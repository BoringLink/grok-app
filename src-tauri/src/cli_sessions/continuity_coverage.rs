//! 只读检查 Agent 历史覆盖情况。
//!
//! 检查 Agent 的 `chat_history.jsonl` 是否按顺序包含 App journal 中的 prompt，且不修改 journal。
//! 匹配复用 journal reconcile 的归一化与 rewind fence，但绝不把可写入 journal 的 reconcile
//! 当作覆盖证明。

use std::fs;

use crate::continuity::{self, ContinuityCheckpoint, CoverageReport, CoverageVerdict};
use crate::store::{self, ChatMessageStored};

use super::{
    parse_at_path_attachments, parse_chat_history_rows_strict, rewind_fence::RewindFence,
    user_body_key,
};

/// 超过此大小的历史不解析，发送门改用 journal bootstrap，避免无界读取。
const MAX_HISTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PROMPT_MATCH_COMPARISONS: usize = 1_000_000;

fn prompt_match_work_exceeds_budget(agent_users: usize, app_prompts: usize) -> bool {
    agent_users.saturating_mul(app_prompts) > MAX_PROMPT_MATCH_COMPARISONS
}

/// Host history-bootstrap 前缀。带此标记的 Agent row 以一个紧凑 block 表示较早的 journal 回合，
/// 因此逐条覆盖从追加在该 row 后的 prompt 开始检查。
const BOOTSTRAP_MARKER: &str = continuity::BOOTSTRAP_START_MARKER;

/// 测试辅助函数：从 App index 找到关联的 Agent 历史。
#[cfg(test)]
fn inspect_linked_history_coverage(app_session_id: &str) -> CoverageReport {
    let meta = store::load_sessions_index()
        .into_iter()
        .find(|s| s.id == app_session_id);
    let Some(meta) = meta else {
        return CoverageReport::new(CoverageVerdict::Missing, 0, 0);
    };
    let Some(agent_id) = meta.agent_session_id.as_deref().filter(|s| !s.is_empty()) else {
        return CoverageReport::new(CoverageVerdict::Missing, 0, 0);
    };
    let cwd_hint = meta.project_id.as_deref().and_then(|pid| {
        store::load_projects()
            .into_iter()
            .find(|p| p.id == pid)
            .map(|p| p.path)
    });
    let mode = store::load_settings().session_data_mode;
    let custom_route = meta
        .provider_id
        .as_deref()
        .is_some_and(|id| !crate::providers::is_session_provider_official(id));
    inspect_agent_history_coverage_for_inference(
        app_session_id,
        agent_id,
        cwd_hint.as_deref(),
        &mode,
        custom_route,
    )
}

/// 检查 `agent_session_id` 的历史是否覆盖 `app_session_id` 的 journal。
#[cfg(test)]
fn inspect_agent_history_coverage(
    app_session_id: &str,
    agent_session_id: &str,
    cwd_hint: Option<&str>,
    session_data_mode: &str,
) -> CoverageReport {
    inspect_agent_history_coverage_for_inference(
        app_session_id,
        agent_session_id,
        cwd_hint,
        session_data_mode,
        false,
    )
}

pub(crate) fn inspect_agent_history_coverage_for_inference(
    app_session_id: &str,
    agent_session_id: &str,
    cwd_hint: Option<&str>,
    session_data_mode: &str,
    custom_route: bool,
) -> CoverageReport {
    let checkpoint = match continuity::read(app_session_id) {
        continuity::CheckpointRead::Loaded(checkpoint) => *checkpoint,
        continuity::CheckpointRead::Missing | continuity::CheckpointRead::Corrupt => {
            ContinuityCheckpoint::default()
        }
    };
    inspect_agent_history_coverage_with_checkpoint(
        app_session_id,
        agent_session_id,
        cwd_hint,
        session_data_mode,
        &checkpoint,
        custom_route,
    )
}

pub(crate) fn inspect_agent_history_coverage_with_checkpoint(
    app_session_id: &str,
    agent_session_id: &str,
    cwd_hint: Option<&str>,
    session_data_mode: &str,
    checkpoint: &ContinuityCheckpoint,
    custom_route: bool,
) -> CoverageReport {
    let journal = match store::load_messages_strict(app_session_id) {
        Ok(journal) => journal,
        Err(_) => return CoverageReport::new(CoverageVerdict::Corrupt, 0, 0),
    };
    let turns = journal_turns(&journal);
    let total = turns.len();
    let empty_journal = total == 0;
    if empty_journal && checkpoint.bootstrap_bundle_id.is_some() {
        return CoverageReport::new(CoverageVerdict::Ambiguous, 0, 0);
    }

    let Some(dir) = crate::paths::find_agent_session_dir_for_inference(
        agent_session_id,
        cwd_hint,
        session_data_mode,
        custom_route,
    ) else {
        let verdict = if empty_journal
            && checkpoint.reason == Some(continuity::ContinuityReason::NewAgentSession)
        {
            CoverageVerdict::Complete
        } else {
            CoverageVerdict::Missing
        };
        return CoverageReport::new(verdict, 0, total as u32);
    };
    let history_path = dir.join("chat_history.jsonl");
    let metadata = match fs::metadata(&history_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let verdict = if empty_journal
                && checkpoint.reason == Some(continuity::ContinuityReason::NewAgentSession)
            {
                CoverageVerdict::Complete
            } else {
                CoverageVerdict::Missing
            };
            return CoverageReport::new(verdict, 0, total as u32);
        }
        Err(_) => return CoverageReport::new(CoverageVerdict::Corrupt, 0, total as u32),
    };
    if metadata.len() > MAX_HISTORY_BYTES {
        return CoverageReport::new(CoverageVerdict::Ambiguous, 0, total as u32);
    }
    let raw = match fs::read_to_string(&history_path) {
        Ok(raw) => raw,
        Err(_) => return CoverageReport::new(CoverageVerdict::Corrupt, 0, total as u32),
    };
    let rows = match parse_chat_history_rows_strict(&raw) {
        Ok(rows) => rows,
        Err(_) => {
            let verdict = if raw.trim().is_empty() {
                CoverageVerdict::Empty
            } else {
                CoverageVerdict::Corrupt
            };
            return CoverageReport::new(verdict, 0, total as u32);
        }
    };
    let bootstrap = match validate_bootstrap_context(&journal, &turns, &rows, checkpoint) {
        Ok(context) => context,
        Err(()) => return CoverageReport::new(CoverageVerdict::Ambiguous, 0, total as u32),
    };
    if empty_journal {
        let verdict = if rows.is_empty()
            && checkpoint.reason == Some(continuity::ContinuityReason::NewAgentSession)
        {
            CoverageVerdict::Complete
        } else if rows.is_empty() {
            CoverageVerdict::Empty
        } else {
            CoverageVerdict::Ambiguous
        };
        return CoverageReport::new(verdict, 0, 0);
    }
    let agent_users = rows.iter().filter(|(role, ..)| role == "user").count();
    if agent_users == 0 {
        return CoverageReport::new(CoverageVerdict::Empty, 0, total as u32);
    }
    // 超出比较预算时保持未核验，避免异常长历史触发高成本匹配。
    if prompt_match_work_exceeds_budget(agent_users, total) {
        return CoverageReport::new(CoverageVerdict::Ambiguous, 0, total as u32);
    }

    let fence = RewindFence::load(app_session_id);
    let block_all = fence.is_block_all();
    // fence 无法区分分支时，导入的旧行都不可信；Host bootstrap 之后的行属于当前 Agent session。
    // 只信任该后缀；没有 bootstrap row 时，磁盘历史不能作为证据。
    let trust_from = if block_all {
        match bootstrap {
            Some(context) => context.row_index,
            None => return CoverageReport::new(CoverageVerdict::Ambiguous, 0, total as u32),
        }
    } else {
        0
    };

    let prompt_keys: Vec<PromptMatchKey> = turns
        .iter()
        .map(|turn| prompt_match_key(&turn.prompt, Some(checkpoint)))
        .collect();
    let mut next_prompt = 0usize;
    let mut covered: Vec<usize> = Vec::new();
    let mut agent_context_by_turn: Vec<Vec<usize>> = (0..total).map(|_| Vec::new()).collect();
    let mut scope_start = 0usize;
    let mut bootstrap_boundary_pending = false;
    let mut stale_fence_row = false;
    let mut unmatched_agent_rows = false;
    let mut active_turn = None;
    let mut trusted_epoch_start: Option<usize> = None;
    for (row_index, (role, content, tool_id)) in rows.iter().enumerate().skip(trust_from) {
        if content.contains(BOOTSTRAP_MARKER) && trusted_epoch_start.is_none() {
            trusted_epoch_start = Some(row_index);
        }
        let in_trusted_epoch = trusted_epoch_start.is_some_and(|start| row_index >= start);
        if role == "user" {
            let prior_turn = active_turn.take();
            if !block_all && !in_trusted_epoch && fence.blocks_prompt(content) {
                // fenced prompt 仍出现在 Agent 历史中，说明 rewind 失败，模型上下文还保留已丢弃回合。
                // Host bootstrap 后写入的行属于当前 Agent session，不受旧 fence 判定。
                stale_fence_row = true;
                continue;
            }
            if content.contains(BOOTSTRAP_MARKER) {
                let Some(bootstrap_context) = bootstrap else {
                    return CoverageReport::new(CoverageVerdict::Ambiguous, 0, total as u32);
                };
                if row_index != bootstrap_context.row_index {
                    unmatched_agent_rows = true;
                    continue;
                }
                let at = bootstrap_context.prompt_index;
                scope_start = at;
                next_prompt = at;
                let appended_prompt_matches = bootstrap_prompt_suffix(content)
                    .map(agent_prompt_key)
                    .is_some_and(|agent_key| prompt_matches(&prompt_keys[at], &agent_key));
                let full_bootstrap_row_matches =
                    prompt_matches(&prompt_keys[at], &agent_prompt_key(content));
                if appended_prompt_matches || full_bootstrap_row_matches {
                    covered.push(at);
                    next_prompt = at + 1;
                    active_turn = Some(at);
                } else {
                    bootstrap_boundary_pending = true;
                }
                continue;
            }
            let agent_key = agent_prompt_key(content);
            if let Some(offset) = turns[next_prompt..]
                .iter()
                .enumerate()
                .position(|(i, _)| prompt_matches(&prompt_keys[next_prompt + i], &agent_key))
            {
                let at = next_prompt + offset;
                if bootstrap_boundary_pending {
                    // 独立 bootstrap row 为首个逐条匹配的 row 之前的 prompt 提供覆盖证据。
                    scope_start = at;
                    bootstrap_boundary_pending = false;
                }
                covered.push(at);
                next_prompt = at + 1;
                active_turn = Some(at);
                continue;
            }
            if let Some(turn_index) = prior_turn {
                let is_interjection = turns[turn_index].context.iter().any(|expected| {
                    expected.role == "user" && context_row_matches(expected, &rows[row_index])
                });
                if is_interjection {
                    agent_context_by_turn[turn_index].push(row_index);
                    active_turn = Some(turn_index);
                } else {
                    unmatched_agent_rows = true;
                }
            } else {
                unmatched_agent_rows = true;
            }
            continue;
        }
        if !block_all && !in_trusted_epoch && fence.blocks(role, content, tool_id.as_deref()) {
            stale_fence_row = true;
            continue;
        }
        if let Some(turn_index) = active_turn {
            agent_context_by_turn[turn_index].push(row_index);
        } else if role == "assistant" || role == "tool" {
            unmatched_agent_rows = true;
        }
    }

    // bootstrap 边界之后的 prompt 必须逐条出现在 Agent 历史中。
    let required_total = total.saturating_sub(scope_start);
    let covered: Vec<usize> = covered
        .into_iter()
        .filter(|index| *index >= scope_start)
        .collect();
    let matched = covered.len() as u32;
    let covered_set: std::collections::HashSet<usize> = covered.iter().copied().collect();
    let mut missing_context = false;
    let mut extra_context = false;
    let mut context_ids_by_turn: Vec<Vec<String>> = (0..total).map(|_| Vec::new()).collect();
    for turn_index in scope_start..total {
        if !covered_set.contains(&turn_index) {
            continue;
        }
        let actual = &agent_context_by_turn[turn_index];
        let mut used = vec![false; actual.len()];
        let mut cursor = 0usize;
        for expected in &turns[turn_index].context {
            let Some(index) = (cursor..actual.len())
                .find(|index| context_row_matches(expected, &rows[actual[*index]]))
            else {
                missing_context = true;
                continue;
            };
            used[index] = true;
            // 一个 CLI assistant row 可以覆盖多个流式写入的 App row。
            cursor = index;
            context_ids_by_turn[turn_index].push(expected.id.clone());
        }
        extra_context |= used.iter().any(|matched| !matched);
    }

    let bootstrap_prompt_count = if bootstrap.is_some() {
        checkpoint
            .bootstrap_included_message_ids
            .iter()
            .filter(|id| {
                journal.iter().any(|message| {
                    message.id.as_str() == id.as_str() && store::is_user_prompt_message(message)
                })
            })
            .count() as u32
    } else {
        0
    };
    let covered_prompt_count = matched.saturating_add(bootstrap_prompt_count);
    let total_prompt_count = (required_total as u32).saturating_add(bootstrap_prompt_count);
    let prompts_complete = matched == required_total as u32;
    let context_complete = !missing_context && !extra_context && !unmatched_agent_rows;
    let verdict = if prompts_complete && context_complete && !stale_fence_row {
        CoverageVerdict::Complete
    } else if matched == 0 && context_ids_by_turn.iter().all(Vec::is_empty) {
        CoverageVerdict::Mismatch
    } else {
        CoverageVerdict::Partial
    };
    let mut ids = if bootstrap.is_some() {
        checkpoint.bootstrap_included_message_ids.clone()
    } else {
        Vec::new()
    };
    for turn_index in &covered {
        ids.push(turns[*turn_index].prompt.id.clone());
        ids.extend(context_ids_by_turn[*turn_index].iter().cloned());
    }
    let ids: Vec<String> = ids
        .into_iter()
        .rev()
        .take(continuity::MAX_COVERED_IDS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    CoverageReport {
        verdict,
        covered_message_ids: ids,
        covered_prompt_count,
        total_prompt_count,
    }
}

#[derive(Clone, Copy)]
struct BootstrapContext {
    row_index: usize,
    prompt_index: usize,
}

fn validate_bootstrap_context(
    journal: &[ChatMessageStored],
    turns: &[JournalTurn],
    rows: &[(String, String, Option<String>)],
    checkpoint: &ContinuityCheckpoint,
) -> Result<Option<BootstrapContext>, ()> {
    let bootstrap_rows: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, (role, content, _))| role == "user" && content.contains(BOOTSTRAP_MARKER))
        .map(|(index, _)| index)
        .collect();
    let Some(expected_bundle_id) = checkpoint.bootstrap_bundle_id.as_deref() else {
        return if bootstrap_rows.is_empty() {
            Ok(None)
        } else {
            Err(())
        };
    };
    if bootstrap_rows.len() != 1 {
        return Err(());
    }
    let row_index = bootstrap_rows[0];
    // Host recovery 使用新的 Agent session；若前面还有聊天 row，说明 bundle 追加到了旧上下文，不能证明恢复成功。
    if row_index != 0 {
        return Err(());
    }
    let Some(body) = continuity::bootstrap_body_from_prompt(&rows[row_index].1) else {
        return Err(());
    };
    if continuity::bootstrap_bundle_id(&body) != expected_bundle_id {
        return Err(());
    }
    if checkpoint.bootstrap_included_message_ids.len() != checkpoint.bootstrap_included as usize
        || checkpoint.bootstrap_included_message_ids.len()
            != checkpoint.bootstrap_included_message_digests.len()
    {
        return Err(());
    }
    let prompt_id = checkpoint.bootstrap_prompt_id.as_deref().ok_or(())?;
    let prompt_index = turns
        .iter()
        .position(|turn| turn.prompt.id == prompt_id)
        .ok_or(())?;
    if checkpoint
        .bootstrap_included_message_ids
        .iter()
        .any(|id| id == prompt_id)
    {
        return Err(());
    }
    let prompt_message_index = journal
        .iter()
        .position(|message| message.id == prompt_id)
        .ok_or(())?;
    let eligible_prefix: Vec<&ChatMessageStored> = journal[..prompt_message_index]
        .iter()
        .filter(|message| crate::session_attach::is_bootstrap_context_message(message))
        .collect();
    let mut prefix_cursor = 0usize;
    for (message_id, expected_digest) in checkpoint
        .bootstrap_included_message_ids
        .iter()
        .zip(&checkpoint.bootstrap_included_message_digests)
    {
        let Some(offset) = eligible_prefix[prefix_cursor..]
            .iter()
            .position(|message| &message.id == message_id)
        else {
            return Err(());
        };
        let index = prefix_cursor + offset;
        let message = eligible_prefix[index];
        if (message.role != "user" && message.role != "assistant")
            || continuity::bootstrap_message_digest(&message.role, message.content.trim())
                != *expected_digest
        {
            return Err(());
        }
        prefix_cursor = index + 1;
    }
    let omitted: Vec<&ChatMessageStored> = eligible_prefix
        .iter()
        .copied()
        .filter(|message| {
            !checkpoint
                .bootstrap_included_message_ids
                .iter()
                .any(|included| included == &message.id)
        })
        .collect();
    if omitted.len() as u32 != checkpoint.bootstrap_omitted {
        return Err(());
    }
    let omitted_from = omitted.first().map(|message| message.id.as_str());
    let omitted_through = omitted.last().map(|message| message.id.as_str());
    if checkpoint.bootstrap_omitted_from_message_id.as_deref() != omitted_from
        || checkpoint.bootstrap_omitted_through_message_id.as_deref() != omitted_through
    {
        return Err(());
    }
    if checkpoint.bootstrap_omitted > 0 {
        let marker = format!(
            "[{} transcript entries omitted by the context limits]",
            checkpoint.bootstrap_omitted
        );
        if !body.contains(&marker) {
            return Err(());
        }
    }

    let expected_prompt = prompt_match_key(&turns[prompt_index].prompt, Some(checkpoint));
    let same_row_has_prompt = bootstrap_prompt_suffix(&rows[row_index].1)
        .map(agent_prompt_key)
        .is_some_and(|agent_key| prompt_matches(&expected_prompt, &agent_key))
        || prompt_matches(&expected_prompt, &agent_prompt_key(&rows[row_index].1));
    let next_user_has_prompt = rows
        .iter()
        .skip(row_index + 1)
        .find(|(role, _, _)| role == "user")
        .is_some_and(|(_, content, _)| {
            prompt_matches(&expected_prompt, &agent_prompt_key(content))
        });
    if !same_row_has_prompt && !next_user_has_prompt {
        return Err(());
    }
    Ok(Some(BootstrapContext {
        row_index,
        prompt_index,
    }))
}

fn bootstrap_prompt_suffix(content: &str) -> Option<&str> {
    content
        .split_once(continuity::BOOTSTRAP_END_MARKER)
        .map(|(_, suffix)| suffix)
}

#[derive(Clone)]
struct JournalContextRow {
    id: String,
    role: String,
    content: String,
    tool_call_id: Option<String>,
    attachment_paths: Option<Vec<String>>,
    journal_prompt_digest: Option<String>,
}

struct JournalTurn {
    prompt: JournalContextRow,
    context: Vec<JournalContextRow>,
}

struct PromptMatchKey {
    body: String,
    attachment_paths: Option<Vec<String>>,
    agent_prompt_digest: Option<String>,
    expected_agent_prompt_digest: Option<String>,
}

/// 仅有附件 ID 时，CLI 文本历史无法提供足够证据。
fn message_attachment_paths(message: &ChatMessageStored) -> Option<Vec<String>> {
    if let Some(attachments) = message
        .attachments
        .as_deref()
        .filter(|attachments| !attachments.is_empty())
    {
        return attachments
            .iter()
            .map(|attachment| {
                let path = attachment.path.trim();
                (!path.is_empty()).then(|| path.to_owned())
            })
            .collect();
    }
    let (_, attachments) = parse_at_path_attachments(&message.content);
    Some(
        attachments
            .into_iter()
            .map(|attachment| attachment.path)
            .collect(),
    )
}

fn prompt_match_key(
    row: &JournalContextRow,
    checkpoint: Option<&ContinuityCheckpoint>,
) -> PromptMatchKey {
    let content = crate::session_attach::strip_chat_tokens(&row.content);
    let expected_agent_prompt_digest = checkpoint.and_then(|checkpoint| {
        let journal_digest = row.journal_prompt_digest.as_deref()?;
        if checkpoint.pending_prompt_id.as_deref() == Some(row.id.as_str())
            && checkpoint.pending_journal_prompt_digest.as_deref() == Some(journal_digest)
        {
            return checkpoint.pending_agent_prompt_digest.clone();
        }
        checkpoint
            .covered_prompt_digests
            .iter()
            .find(|digest| {
                digest.message_id == row.id && digest.journal_prompt_digest == journal_digest
            })
            .map(|digest| digest.agent_prompt_digest.clone())
    });
    PromptMatchKey {
        body: user_body_key(&content),
        attachment_paths: row.attachment_paths.clone(),
        agent_prompt_digest: None,
        expected_agent_prompt_digest,
    }
}

fn agent_prompt_key(content: &str) -> PromptMatchKey {
    let (body, _) = parse_at_path_attachments(content);
    let body = body.trim().to_string();
    let attachment_paths = Some(agent_attachment_paths(content));
    PromptMatchKey {
        agent_prompt_digest: Some(continuity::agent_prompt_digest(&body, &attachment_paths)),
        body,
        attachment_paths,
        expected_agent_prompt_digest: None,
    }
}

fn agent_attachment_paths(content: &str) -> Vec<String> {
    let (_, path_attachments) = parse_at_path_attachments(content);
    let vision_paths = content
        .split("<image_description path=\"")
        .skip(1)
        .filter_map(|block| {
            let (path, remainder) = block.split_once("\">")?;
            let (description, _) = remainder.split_once("</image_description>")?;
            (!description.to_ascii_lowercase().contains("vision failed")).then(|| path.to_string())
        });
    let mut seen = std::collections::HashSet::new();
    path_attachments
        .into_iter()
        .map(|attachment| attachment.path)
        .chain(vision_paths)
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

pub(crate) fn agent_prompt_digest_for_content(content: &str) -> String {
    agent_prompt_key(content)
        .agent_prompt_digest
        .expect("Agent prompt key contains its digest")
}

fn journal_turns(journal: &[ChatMessageStored]) -> Vec<JournalTurn> {
    let mut turns: Vec<JournalTurn> = Vec::new();
    for message in journal {
        let row = JournalContextRow {
            id: message.id.clone(),
            role: message.role.clone(),
            content: message.content.clone(),
            tool_call_id: message.id.strip_prefix("tool-").map(str::to_string),
            attachment_paths: message_attachment_paths(message),
            journal_prompt_digest: store::is_user_prompt_message(message)
                .then(|| continuity::journal_prompt_digest(&message.content, &message.attachments)),
        };
        if store::is_user_prompt_message(message) {
            turns.push(JournalTurn {
                prompt: row,
                context: Vec::new(),
            });
            continue;
        }
        let Some(turn) = turns.last_mut() else {
            continue;
        };
        let is_context_row = (message.role == "user"
            && message.marker.as_deref() == Some("interjection"))
            || (message.role == "assistant"
                && !message.is_error
                && !message.content.trim().is_empty())
            || (message.role == "tool" && message.content.starts_with("tool_step|"));
        if is_context_row {
            turn.context.push(row);
        }
    }
    turns
}

fn context_row_matches(
    expected: &JournalContextRow,
    actual: &(String, String, Option<String>),
) -> bool {
    match expected.role.as_str() {
        "assistant" => {
            let expected_body = expected.content.trim();
            !expected_body.is_empty() && actual.0 == "assistant" && actual.1.contains(expected_body)
        }
        "tool" => expected
            .tool_call_id
            .as_deref()
            .zip(actual.2.as_deref())
            .is_some_and(|(expected_id, actual_id)| {
                tool_call_ids_match(expected_id, actual_id)
                    && tool_result_covers_journal_detail(&expected.content, &actual.1)
            }),
        "user" => {
            actual.0 == "user"
                && prompt_matches(
                    &prompt_match_key(expected, None),
                    &agent_prompt_key(&actual.1),
                )
        }
        _ => false,
    }
}

fn tool_result_covers_journal_detail(journal_content: &str, agent_content: &str) -> bool {
    let detail = if let Some((_, output)) =
        journal_content.split_once(crate::session_manager::TOOL_OUTPUT_SENTINEL)
    {
        output.to_string()
    } else {
        journal_content
            .lines()
            .skip(1)
            .filter(|line| !line.starts_with("input:"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let detail = super::strip_numbered_markers(&detail);
    if detail.trim().is_empty() {
        return true;
    }
    super::strip_numbered_markers(agent_content).contains(detail.trim())
}

fn tool_call_ids_match(expected: &str, actual: &str) -> bool {
    if expected == actual {
        return true;
    }
    [(expected, actual), (actual, expected)]
        .into_iter()
        .any(|(base, full)| {
            full.strip_prefix(base)
                .and_then(|suffix| suffix.strip_prefix('-'))
                .is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
                })
        })
}

/// 正文与附件路径都必须覆盖；不能用被截断的 Agent 正文证明完整 prompt。
fn prompt_matches(journal_key: &PromptMatchKey, agent_key: &PromptMatchKey) -> bool {
    let attachment_path_evidence = journal_key
        .attachment_paths
        .as_ref()
        .zip(agent_key.attachment_paths.as_ref())
        .is_some_and(|(expected, actual)| expected.iter().all(|path| actual.contains(path)));
    if journal_key.expected_agent_prompt_digest.as_deref()
        == agent_key.agent_prompt_digest.as_deref()
        && journal_key.expected_agent_prompt_digest.is_some()
        && attachment_path_evidence
    {
        return true;
    }
    let attachment_paths_match = journal_key
        .attachment_paths
        .as_ref()
        .zip(agent_key.attachment_paths.as_ref())
        .is_some_and(|(expected, actual)| expected == actual);
    if !attachment_paths_match {
        return false;
    }
    if journal_key.body.is_empty() || agent_key.body.is_empty() {
        return journal_key.body.is_empty()
            && agent_key.body.is_empty()
            && journal_key
                .attachment_paths
                .as_ref()
                .is_some_and(|paths| !paths.is_empty());
    }
    let journal_body = &journal_key.body;
    let agent_body = &agent_key.body;
    journal_body == agent_body
        || agent_body.starts_with(journal_body)
        || (agent_body.len() > journal_body.len() && agent_body.ends_with(journal_body))
}

#[cfg(test)]
mod tests;
