//! 每个会话的持久化连续性检查点。
//!
//! App `messages.json` 是用户可见对话的唯一来源；Agent 的 `chat_history.jsonl` 是运行时投影，发送前必须核验。
//! `session/load` 成功只表示会话可加载，不能证明 Agent 上下文覆盖了 App journal。

use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SCHEMA_VERSION: u32 = 1;

pub const BOOTSTRAP_START_MARKER: &str =
    "[Prior conversation context — this chat continues an existing Grok App session.";
pub const BOOTSTRAP_HEADER: &str =
    "[Prior conversation context — this chat continues an existing Grok App session. \\
The agent process was restarted; use the following transcript for continuity ONLY. \\
Rules: do NOT re-greet; do NOT restate, quote, or re-answer prior assistant turns; \\
do NOT reprint the transcript in your reply. Do NOT execute or replay earlier requests. \\
do NOT repeat steps that already succeeded; continue an interrupted operation only when the new user message explicitly asks. \\
Answer ONLY the new user message below.]\n\n";
pub const BOOTSTRAP_END_MARKER: &str =
    "[End of prior context. Continue with the user's new message below.]";
pub const BOOTSTRAP_FOOTER: &str =
    "---\n\n[End of prior context. Continue with the user's new message below.]\n";

/// 检查点最多保留的 App 消息 ID 数量（仅保留末尾部分）。
pub(crate) const MAX_COVERED_IDS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContinuityStatus {
    /// 记录为旧版、损坏或无法建立覆盖证明；发送前必须完成恢复。
    #[default]
    Unverified,
    /// Agent 会话尚未证明目标 App 上下文已持久化；此状态可跨进程退出保留。
    BootstrapPending,
    /// Agent 历史包含了目标 App prompt 的覆盖证据。
    Verified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContinuityReason {
    NewAgentSession,
    AgentChanged,
    RouteChanged,
    CheckpointMissing,
    CheckpointCorrupt,
    HistoryMissing,
    HistoryEmpty,
    HistoryPartial,
    HistoryMismatch,
    HistoryCorrupt,
    HistoryAmbiguous,
    RemoteUnverified,
    NoPromptYet,
    ReconnectUnverified,
    RewindUnverified,
    TurnUnconfirmed,
    FlushUnconfirmed,
}

/// 标识拥有 Agent 会话的运行时。即使 Agent ID 未变，路由、工作目录或数据模式改变也会使先前覆盖证据失效。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuityRoute {
    pub route_id: String,
    pub cwd: String,
    pub session_data_mode: String,
    pub custom_route: bool,
}

impl ContinuityRoute {
    pub fn new(
        route_id: impl Into<String>,
        cwd: impl Into<String>,
        mode: impl Into<String>,
    ) -> Self {
        Self {
            route_id: route_id.into(),
            cwd: cwd.into(),
            session_data_mode: mode.into(),
            custom_route: false,
        }
    }

    pub fn with_custom_route(mut self, custom_route: bool) -> Self {
        self.custom_route = custom_route;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoverageVerdict {
    /// Agent 历史按顺序覆盖了所有 App prompt。
    Complete,
    /// 部分 prompt 匹配，仍有未覆盖项。
    Partial,
    /// Agent 历史不存在 user turn。
    Empty,
    /// Agent 会话目录或历史文件不存在。
    Missing,
    /// Agent 历史中的 user turn 与 App prompt 均不匹配。
    Mismatch,
    /// 历史不可读或结构不完整。
    Corrupt,
    /// 无法安全判断覆盖关系（例如 rewind fence 或文件过大）。
    Ambiguous,
}

/// 只读 Agent 历史检查结果；不修改 journal，也不保存 transcript 文本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverageReport {
    pub verdict: CoverageVerdict,
    /// 已在 Agent 历史或已核验 bootstrap bundle 中证明存在的 App 消息 ID（有上限）。
    pub covered_message_ids: Vec<String>,
    /// 已核验 bundle 与逐条检查后缀中覆盖的普通 prompt 数量。
    pub covered_prompt_count: u32,
    /// Agent 上下文预期覆盖的 prompt 数量，不含 bootstrap 中明确省略的范围。
    pub total_prompt_count: u32,
}

impl CoverageReport {
    pub fn new(
        verdict: CoverageVerdict,
        covered_prompt_count: u32,
        total_prompt_count: u32,
    ) -> Self {
        Self {
            verdict,
            covered_message_ids: Vec::new(),
            covered_prompt_count,
            total_prompt_count,
        }
    }

    pub fn ambiguous() -> Self {
        Self::new(CoverageVerdict::Ambiguous, 0, 0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapScope {
    pub bundle_id: String,
    pub prompt_id: String,
    pub included: u32,
    pub omitted: u32,
    pub included_message_ids: Vec<String>,
    pub included_message_digests: Vec<String>,
    pub omitted_from_message_id: Option<String>,
    pub omitted_through_message_id: Option<String>,
}

/// 绑定 App prompt ID 的最终 Agent prompt 摘要索引，不保存 prompt 正文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoveredPromptDigest {
    pub message_id: String,
    pub journal_prompt_digest: String,
    pub agent_prompt_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityCheckpoint {
    #[serde(default)]
    pub schema: u32,
    #[serde(default)]
    pub status: ContinuityStatus,
    #[serde(default)]
    pub reason: Option<ContinuityReason>,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub route_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub session_data_mode: Option<String>,
    #[serde(default)]
    pub custom_route: bool,
    /// 已证明存在于 Agent 历史中的 App 消息 ID 末尾部分。
    #[serde(default)]
    pub covered_message_ids: Vec<String>,
    #[serde(default)]
    pub covered_prompt_count: u32,
    /// 已核验的 App prompt 与最终 Agent prompt 摘要映射（有上限）。
    #[serde(default)]
    pub covered_prompt_digests: Vec<CoveredPromptDigest>,
    /// 已发送给 Agent、但尚未确认 flush 的 prompt ID。
    #[serde(default)]
    pub pending_prompt_id: Option<String>,
    /// 待核验 App prompt 当前 journal 内容与附件的摘要。
    #[serde(default)]
    pub pending_journal_prompt_digest: Option<String>,
    /// Host 预处理后实际交给 Agent 的 prompt 摘要。
    #[serde(default)]
    pub pending_agent_prompt_digest: Option<String>,
    /// bootstrap body 的摘要，不保存 body 本身。
    #[serde(default)]
    pub bootstrap_bundle_id: Option<String>,
    /// 新 Agent session 中追加在 bootstrap body 后的 prompt ID。
    #[serde(default)]
    pub bootstrap_prompt_id: Option<String>,
    /// bundle 纳入的有限 App 消息 ID 和内容摘要。
    #[serde(default)]
    pub bootstrap_included_message_ids: Vec<String>,
    #[serde(default)]
    pub bootstrap_included_message_digests: Vec<String>,
    #[serde(default)]
    pub bootstrap_omitted_from_message_id: Option<String>,
    #[serde(default)]
    pub bootstrap_omitted_through_message_id: Option<String>,
    #[serde(default)]
    pub bootstrap_included: u32,
    #[serde(default)]
    pub bootstrap_omitted: u32,
    #[serde(default)]
    pub updated_at: String,
}

impl Default for ContinuityCheckpoint {
    fn default() -> Self {
        Self {
            schema: SCHEMA_VERSION,
            status: ContinuityStatus::Unverified,
            reason: None,
            agent_session_id: None,
            route_id: None,
            cwd: None,
            session_data_mode: None,
            custom_route: false,
            covered_message_ids: Vec::new(),
            covered_prompt_count: 0,
            covered_prompt_digests: Vec::new(),
            pending_prompt_id: None,
            pending_journal_prompt_digest: None,
            pending_agent_prompt_digest: None,
            bootstrap_bundle_id: None,
            bootstrap_prompt_id: None,
            bootstrap_included_message_ids: Vec::new(),
            bootstrap_included_message_digests: Vec::new(),
            bootstrap_omitted_from_message_id: None,
            bootstrap_omitted_through_message_id: None,
            bootstrap_included: 0,
            bootstrap_omitted: 0,
            updated_at: now(),
        }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

pub fn checkpoint_path(session_id: &str) -> PathBuf {
    crate::paths::session_dir(session_id).join("continuity_checkpoint.json")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointRead {
    Missing,
    Corrupt,
    Loaded(Box<ContinuityCheckpoint>),
}

pub fn read(session_id: &str) -> CheckpointRead {
    match std::fs::read(checkpoint_path(session_id)) {
        Ok(raw) => match serde_json::from_slice::<ContinuityCheckpoint>(&raw) {
            Ok(checkpoint) if checkpoint.schema == SCHEMA_VERSION => {
                CheckpointRead::Loaded(Box::new(checkpoint))
            }
            _ => CheckpointRead::Corrupt,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CheckpointRead::Missing,
        Err(_) => CheckpointRead::Corrupt,
    }
}

pub fn save(session_id: &str, checkpoint: &ContinuityCheckpoint) -> Result<(), String> {
    let path = checkpoint_path(session_id);
    let body = serde_json::to_vec(checkpoint).map_err(|e| format!("encode continuity: {e}"))?;
    crate::store_lock::write_bytes_atomic(&path, &body)
}

impl ContinuityCheckpoint {
    pub fn matches_agent(&self, agent_session_id: &str) -> bool {
        self.agent_session_id.as_deref() == Some(agent_session_id)
    }

    pub fn matches_route(&self, route: &ContinuityRoute) -> bool {
        self.route_id.as_deref() == Some(route.route_id.as_str())
            && self.cwd.as_deref() == Some(route.cwd.as_str())
            && self.session_data_mode.as_deref() == Some(route.session_data_mode.as_str())
            && self.custom_route == route.custom_route
    }

    pub fn needs_recovery(&self) -> bool {
        self.status != ContinuityStatus::Verified
    }

    pub fn matches_pending_snapshot(&self, snapshot: &Self, pending_prompt_id: &str) -> bool {
        self == snapshot && self.pending_prompt_id.as_deref() == Some(pending_prompt_id)
    }

    fn clear_coverage_evidence(&mut self) {
        self.covered_message_ids.clear();
        self.covered_prompt_count = 0;
        self.covered_prompt_digests.clear();
        self.pending_prompt_id = None;
        self.pending_journal_prompt_digest = None;
        self.pending_agent_prompt_digest = None;
        self.bootstrap_bundle_id = None;
        self.bootstrap_prompt_id = None;
        self.bootstrap_included_message_ids.clear();
        self.bootstrap_included_message_digests.clear();
        self.bootstrap_omitted_from_message_id = None;
        self.bootstrap_omitted_through_message_id = None;
        self.bootstrap_included = 0;
        self.bootstrap_omitted = 0;
    }

    pub(crate) fn attach_route(&mut self, agent_session_id: &str, route: &ContinuityRoute) {
        self.schema = SCHEMA_VERSION;
        self.agent_session_id = Some(agent_session_id.to_string());
        self.route_id = Some(route.route_id.clone());
        self.cwd = Some(route.cwd.clone());
        self.session_data_mode = Some(route.session_data_mode.clone());
        self.custom_route = route.custom_route;
        self.updated_at = now();
    }

    pub fn mark_verified(&mut self, covered: &[String], covered_prompt_count: u32) {
        if let (Some(message_id), Some(journal_digest), Some(agent_digest)) = (
            self.pending_prompt_id.clone(),
            self.pending_journal_prompt_digest.clone(),
            self.pending_agent_prompt_digest.clone(),
        ) {
            if covered.iter().any(|covered_id| covered_id == &message_id) {
                self.covered_prompt_digests
                    .retain(|entry| entry.message_id != message_id);
                self.covered_prompt_digests.push(CoveredPromptDigest {
                    message_id,
                    journal_prompt_digest: journal_digest,
                    agent_prompt_digest: agent_digest,
                });
            }
        }
        self.status = ContinuityStatus::Verified;
        self.reason = None;
        self.covered_prompt_count = covered_prompt_count;
        self.covered_message_ids = bounded_tail(covered, MAX_COVERED_IDS);
        self.covered_prompt_digests = bounded_tail(&self.covered_prompt_digests, MAX_COVERED_IDS);
        self.pending_prompt_id = None;
        self.pending_journal_prompt_digest = None;
        self.pending_agent_prompt_digest = None;
        self.updated_at = now();
    }

    pub fn mark_bootstrap_pending(&mut self, reason: ContinuityReason) {
        self.status = ContinuityStatus::BootstrapPending;
        self.reason = Some(reason);
        self.updated_at = now();
    }

    pub fn mark_unverified(&mut self, reason: ContinuityReason) {
        self.status = ContinuityStatus::Unverified;
        self.reason = Some(reason);
        self.updated_at = now();
    }

    /// 在 dispatch 前记录 prompt；重新核验 Agent 历史前，检查点必须保持待恢复状态。
    pub fn begin_turn(&mut self, pending_prompt_id: &str) {
        self.status = ContinuityStatus::BootstrapPending;
        self.reason = Some(ContinuityReason::TurnUnconfirmed);
        self.pending_prompt_id = Some(pending_prompt_id.to_string());
        self.pending_journal_prompt_digest = None;
        self.pending_agent_prompt_digest = None;
        self.updated_at = now();
    }

    pub fn record_prepared_prompt_digests(
        &mut self,
        journal_prompt_digest: String,
        agent_prompt_digest: String,
    ) {
        self.pending_journal_prompt_digest = Some(journal_prompt_digest);
        self.pending_agent_prompt_digest = Some(agent_prompt_digest);
        self.updated_at = now();
    }

    pub fn record_bootstrap(&mut self, scope: BootstrapScope) {
        debug_assert_eq!(
            scope.included_message_ids.len(),
            scope.included_message_digests.len()
        );
        debug_assert_eq!(scope.included_message_ids.len(), scope.included as usize);
        self.bootstrap_bundle_id = Some(scope.bundle_id);
        self.bootstrap_prompt_id = Some(scope.prompt_id);
        self.bootstrap_included_message_ids = scope.included_message_ids;
        self.bootstrap_included_message_digests = scope.included_message_digests;
        self.bootstrap_omitted_from_message_id = scope.omitted_from_message_id;
        self.bootstrap_omitted_through_message_id = scope.omitted_through_message_id;
        self.bootstrap_included = scope.included;
        self.bootstrap_omitted = scope.omitted;
        self.updated_at = now();
    }

    pub fn refresh_bootstrap_bundle_id(&mut self, body: &str) {
        if self.bootstrap_bundle_id.is_some() {
            self.bootstrap_bundle_id = Some(bootstrap_bundle_id(body));
            self.updated_at = now();
        }
    }
}

fn bounded_tail<T: Clone>(ids: &[T], max: usize) -> Vec<T> {
    if ids.len() <= max {
        return ids.to_vec();
    }
    ids[ids.len() - max..].to_vec()
}

/// 生成 bootstrap bundle 标识，不持久化 bundle 文本。
pub fn bootstrap_bundle_id(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

/// 从 Agent prompt 提取 bootstrap header 到 footer 的实际文本片段。
pub fn bootstrap_body_from_prompt(prompt: &str) -> Option<String> {
    let start = prompt.find(BOOTSTRAP_START_MARKER)?;
    let remainder = &prompt[start..];
    let end = remainder.find(BOOTSTRAP_END_MARKER)? + BOOTSTRAP_END_MARKER.len();
    let body = &remainder[..end];
    Some(if body.ends_with('\n') {
        body.to_string()
    } else {
        format!("{body}\n")
    })
}

/// 为源消息生成摘要，不在检查点保存消息文本。
pub fn bootstrap_message_digest(role: &str, content: &str) -> String {
    let encoded = serde_json::to_vec(&(role, content)).expect("message digest tuple serializes");
    format!("{:x}", Sha256::digest(encoded))
}

/// 为 App journal 中的 user prompt 内容与附件元数据生成摘要。
pub fn journal_prompt_digest(
    content: &str,
    attachments: &Option<Vec<crate::store::MessageAttachmentStored>>,
) -> String {
    let encoded = serde_json::to_vec(&("user", content.trim(), attachments))
        .expect("journal prompt digest serializes");
    format!("{:x}", Sha256::digest(encoded))
}

/// 为归一化后的 Agent prompt 正文与附件路径生成摘要。
pub fn agent_prompt_digest(body: &str, attachment_paths: &Option<Vec<String>>) -> String {
    let encoded = serde_json::to_vec(&("user", body.trim(), attachment_paths))
        .expect("agent prompt digest serializes");
    format!("{:x}", Sha256::digest(encoded))
}

/// 发送或重连后的覆盖检查决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoverageDecision {
    /// Agent 历史证明 App journal 已覆盖。
    Verified,
    /// 下一个 prompt dispatch 前必须恢复（新建 Agent session 并 bootstrap）。
    Recover,
    /// App 尚无 prompt；保持检查点待核验，由本轮结果建立覆盖证据。
    Fresh,
}

pub fn can_bootstrap_current_agent(
    checkpoint: &ContinuityCheckpoint,
    agent_session_id: &str,
    coverage: &CoverageReport,
) -> bool {
    checkpoint.matches_agent(agent_session_id)
        && checkpoint.reason == Some(ContinuityReason::NewAgentSession)
        && coverage.total_prompt_count > 0
        && matches!(
            coverage.verdict,
            CoverageVerdict::Empty | CoverageVerdict::Missing
        )
}

pub fn decide_coverage(coverage: &CoverageReport) -> CoverageDecision {
    if coverage.verdict == CoverageVerdict::Complete {
        return if coverage.total_prompt_count > 0 {
            CoverageDecision::Verified
        } else {
            CoverageDecision::Fresh
        };
    }
    // Missing、partial、corrupt、mismatch 和 ambiguous 都必须从 journal 恢复。
    // 超时且没有 journal 数量的检查必须 fail closed，不能误判为无需恢复。
    CoverageDecision::Recover
}

/// 发送前的覆盖决策。
///
/// 刚创建的 Agent 会话面对空 journal 时没有可恢复内容；沿用它可避免每次新会话
/// 首条消息都多开一个 Agent 会话，也能保住已持久化的 Agent 链接。
pub fn decide_coverage_for_send(
    checkpoint_reason: Option<ContinuityReason>,
    coverage: &CoverageReport,
) -> CoverageDecision {
    if checkpoint_reason == Some(ContinuityReason::NewAgentSession)
        && coverage.total_prompt_count == 0
        && matches!(
            coverage.verdict,
            CoverageVerdict::Empty | CoverageVerdict::Missing
        )
    {
        return CoverageDecision::Fresh;
    }
    decide_coverage(coverage)
}

/// 在 `session/load` / `session/new` 完成后更新检查点。
///
/// 此处不读取 Agent 历史，避免重开会话时解析大型 transcript。此前的 `Verified` 状态会降级，
/// 下次模型请求前由发送门重新证明覆盖关系。
pub fn after_reconnect(
    previous: CheckpointRead,
    agent_session_id: &str,
    route: &ContinuityRoute,
    resumed: bool,
) -> ContinuityCheckpoint {
    let (mut checkpoint, agent_matches, route_matches, checkpoint_error) = match previous {
        CheckpointRead::Loaded(checkpoint) => {
            let agent_matches = checkpoint.matches_agent(agent_session_id);
            let route_matches = checkpoint.matches_route(route);
            (*checkpoint, agent_matches, route_matches, None)
        }
        CheckpointRead::Missing => (
            ContinuityCheckpoint::default(),
            false,
            false,
            Some(ContinuityReason::CheckpointMissing),
        ),
        CheckpointRead::Corrupt => (
            ContinuityCheckpoint::default(),
            false,
            false,
            Some(ContinuityReason::CheckpointCorrupt),
        ),
    };
    checkpoint.attach_route(agent_session_id, route);
    if !resumed || !agent_matches || !route_matches {
        checkpoint.clear_coverage_evidence();
        if resumed {
            let reason = checkpoint_error.unwrap_or(if !agent_matches {
                ContinuityReason::AgentChanged
            } else {
                ContinuityReason::RouteChanged
            });
            checkpoint.mark_unverified(reason);
        } else {
            checkpoint.mark_bootstrap_pending(ContinuityReason::NewAgentSession);
        }
        return checkpoint;
    }
    checkpoint.mark_bootstrap_pending(ContinuityReason::ReconnectUnverified);
    checkpoint
}

/// 在 `session/load` / `session/new` 后根据历史覆盖证据更新检查点。
///
/// `session/load` 成功本身不够；只有非空 App journal 被 Agent 历史完整覆盖时才能标记为 `Verified`。
pub fn after_open(
    previous: CheckpointRead,
    agent_session_id: &str,
    route: &ContinuityRoute,
    resumed: bool,
    coverage: &CoverageReport,
) -> ContinuityCheckpoint {
    let mut checkpoint = match previous {
        CheckpointRead::Loaded(cp) => *cp,
        CheckpointRead::Missing => {
            let mut cp = ContinuityCheckpoint::default();
            cp.mark_unverified(ContinuityReason::CheckpointMissing);
            cp
        }
        CheckpointRead::Corrupt => {
            let mut cp = ContinuityCheckpoint::default();
            cp.mark_unverified(ContinuityReason::CheckpointCorrupt);
            cp
        }
    };

    let previous_agent_matches = checkpoint.matches_agent(agent_session_id);
    let previous_route_matches = checkpoint.matches_route(route);
    if !previous_agent_matches || !previous_route_matches {
        checkpoint.clear_coverage_evidence();
    }
    checkpoint.attach_route(agent_session_id, route);

    if previous_agent_matches
        && previous_route_matches
        && checkpoint.status == ContinuityStatus::Verified
        && coverage.verdict == CoverageVerdict::Complete
        && coverage.total_prompt_count > 0
    {
        checkpoint.mark_verified(&coverage.covered_message_ids, coverage.covered_prompt_count);
        return checkpoint;
    }

    match coverage.verdict {
        CoverageVerdict::Complete if coverage.total_prompt_count > 0 => {
            checkpoint.mark_verified(&coverage.covered_message_ids, coverage.covered_prompt_count);
        }
        CoverageVerdict::Complete => {
            checkpoint.covered_message_ids.clear();
            checkpoint.covered_prompt_count = 0;
            checkpoint.mark_bootstrap_pending(if resumed {
                ContinuityReason::NoPromptYet
            } else {
                ContinuityReason::NewAgentSession
            });
        }
        CoverageVerdict::Partial => {
            checkpoint.mark_unverified(ContinuityReason::HistoryPartial);
        }
        CoverageVerdict::Empty => {
            checkpoint.mark_unverified(ContinuityReason::HistoryEmpty);
        }
        CoverageVerdict::Missing => {
            checkpoint.mark_unverified(ContinuityReason::HistoryMissing);
        }
        CoverageVerdict::Mismatch => {
            checkpoint.mark_unverified(ContinuityReason::HistoryMismatch);
        }
        CoverageVerdict::Corrupt => {
            checkpoint.mark_unverified(ContinuityReason::HistoryCorrupt);
        }
        CoverageVerdict::Ambiguous => {
            checkpoint.mark_unverified(ContinuityReason::HistoryAmbiguous);
        }
    }

    if !resumed && checkpoint.status != ContinuityStatus::Verified {
        checkpoint.mark_bootstrap_pending(ContinuityReason::NewAgentSession);
    } else if !previous_agent_matches && checkpoint.status != ContinuityStatus::Verified {
        checkpoint.mark_unverified(ContinuityReason::AgentChanged);
    } else if !previous_route_matches && checkpoint.status != ContinuityStatus::Verified {
        checkpoint.mark_unverified(ContinuityReason::RouteChanged);
    }
    checkpoint
}

/// 根据回合结束后的有界 reconcile 结果推进或保留待核验状态。
pub fn after_turn(
    mut checkpoint: ContinuityCheckpoint,
    coverage: &CoverageReport,
    pending_prompt_id: Option<&str>,
) -> ContinuityCheckpoint {
    let pending_covered = pending_prompt_id.is_none_or(|id| {
        coverage
            .covered_message_ids
            .iter()
            .any(|covered| covered == id)
    });
    if coverage.verdict == CoverageVerdict::Complete
        && coverage.total_prompt_count > 0
        && pending_covered
    {
        checkpoint.mark_verified(&coverage.covered_message_ids, coverage.covered_prompt_count);
        return checkpoint;
    }
    // 保留待核验 prompt ID：journal 仍保存该回合，下一次发送必须恢复，不能重放可能已产生副作用的操作。
    if checkpoint.status == ContinuityStatus::Verified {
        checkpoint.mark_unverified(ContinuityReason::FlushUnconfirmed);
    } else {
        checkpoint.mark_bootstrap_pending(ContinuityReason::FlushUnconfirmed);
    }
    checkpoint
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuitySnapshot {
    pub status: ContinuityStatus,
    /// 未核验或恢复中的安全原因码；不包含 prompt 正文或调用栈。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ContinuityReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_prompt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_prompt_id: Option<String>,
    pub covered_message_ids: Vec<String>,
    pub covered_prompt_count: u32,
    pub bootstrap_included_message_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_omitted_from_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_omitted_through_message_id: Option<String>,
    pub bootstrap_included: u32,
    pub bootstrap_omitted: u32,
}

impl From<&ContinuityCheckpoint> for ContinuitySnapshot {
    fn from(checkpoint: &ContinuityCheckpoint) -> Self {
        Self {
            status: checkpoint.status,
            reason: checkpoint.reason,
            pending_prompt_id: checkpoint.pending_prompt_id.clone(),
            bootstrap_prompt_id: checkpoint.bootstrap_prompt_id.clone(),
            covered_message_ids: checkpoint.covered_message_ids.clone(),
            covered_prompt_count: checkpoint.covered_prompt_count,
            bootstrap_included_message_ids: checkpoint.bootstrap_included_message_ids.clone(),
            bootstrap_omitted_from_message_id: checkpoint.bootstrap_omitted_from_message_id.clone(),
            bootstrap_omitted_through_message_id: checkpoint
                .bootstrap_omitted_through_message_id
                .clone(),
            bootstrap_included: checkpoint.bootstrap_included,
            bootstrap_omitted: checkpoint.bootstrap_omitted,
        }
    }
}

#[cfg(test)]
mod tests;
