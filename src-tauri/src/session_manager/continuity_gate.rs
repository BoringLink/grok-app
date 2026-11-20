//! 重连和发送共用的连续性检查门。
//!
//! `session/load` 成功不代表上下文完整。连接和每次 prompt dispatch 都经过此模块，
//! 将 App journal 与 Agent 只读历史投影进行比较。覆盖缺失或不明确时，使用有界 journal bootstrap
//! 建立新的 Agent session，避免重放旧回合。

use std::{sync::Arc, time::Duration};

use uuid::Uuid;

use crate::acp_client::AcpClient;
use crate::continuity::{
    self, CheckpointRead, ContinuityCheckpoint, ContinuityReason, ContinuityRoute,
    CoverageDecision, CoverageReport,
};

use super::{types::*, SessionManager};

/// 在 async executor 之外检查 JSONL。超时只停止等待，`spawn_blocking` 任务仍会继续，
/// 因此检查器还会限制文件大小和并发扫描数量。
const COVERAGE_INSPECT_TIMEOUT: Duration = Duration::from_secs(3);
static COVERAGE_INSPECT_SEMAPHORE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

pub(super) struct ContinuityBootstrap {
    pub(super) body: String,
}

pub(super) struct ContinuitySendPlan {
    pub(super) pending_prompt_id: String,
    pub(super) bootstrap: Option<ContinuityBootstrap>,
}

fn continuity_recovery_error() -> String {
    crate::error::AgentErrorCode::ConnectFailed
        .as_str()
        .to_string()
}

pub(super) struct ContinuityContext {
    pub(super) app_session_id: String,
    pub(super) checkpoint: ContinuityCheckpoint,
    pub(super) agent_session_id: Option<String>,
    pub(super) project_path: Option<String>,
    pub(super) model_id: Option<String>,
    pub(super) product_mode: Option<String>,
    pub(super) acp: Option<Arc<AcpClient>>,
    pub(super) remote: bool,
    pub(super) custom_route: bool,
    pub(super) backend: String,
}

pub(super) fn capture_context(
    manager: &SessionManager,
    app_session_id: &str,
) -> Option<ContinuityContext> {
    manager.with_session_mut(app_session_id, |session| ContinuityContext {
        app_session_id: session.app_session_id.clone(),
        checkpoint: session.continuity.clone(),
        agent_session_id: session.meta.agent_session_id.clone(),
        project_path: session.project_path.clone(),
        model_id: session.model_id.clone(),
        product_mode: session.product_mode.clone(),
        acp: session.acp.clone(),
        remote: session
            .acp
            .as_ref()
            .is_some_and(|client| client.is_ssh_remote()),
        custom_route: session
            .acp
            .as_ref()
            .is_some_and(|client| client.is_custom_route()),
        backend: session.backend.clone(),
    })
}

async fn read_checkpoint(session_id: String) -> CheckpointRead {
    match tokio::task::spawn_blocking(move || continuity::read(&session_id)).await {
        Ok(read) => read,
        Err(error) => {
            tracing::warn!(error = %error, "continuity checkpoint read task failed");
            CheckpointRead::Corrupt
        }
    }
}

async fn save_checkpoint(session_id: String, checkpoint: ContinuityCheckpoint) -> bool {
    match tokio::task::spawn_blocking(move || continuity::save(&session_id, &checkpoint)).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "continuity checkpoint write failed");
            false
        }
        Err(error) => {
            tracing::warn!(error = %error, "continuity checkpoint write task failed");
            false
        }
    }
}

async fn inspect_coverage(
    app_session_id: &str,
    agent_session_id: &str,
    cwd: Option<&str>,
    session_data_mode: &str,
    custom_route: bool,
) -> CoverageReport {
    let deadline = tokio::time::Instant::now() + COVERAGE_INSPECT_TIMEOUT;
    let permit = match tokio::time::timeout_at(deadline, COVERAGE_INSPECT_SEMAPHORE.acquire()).await
    {
        Ok(Ok(permit)) => permit,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "agent history coverage permit failed");
            return CoverageReport::ambiguous();
        }
        Err(_) => {
            tracing::warn!("agent history coverage wait timed out");
            return CoverageReport::ambiguous();
        }
    };
    let app_session_id = app_session_id.to_string();
    let agent_session_id = agent_session_id.to_string();
    let cwd = cwd.map(str::to_string);
    let mode = session_data_mode.to_string();
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::cli_sessions::continuity_coverage::inspect_agent_history_coverage_for_inference(
            &app_session_id,
            &agent_session_id,
            cwd.as_deref(),
            &mode,
            custom_route,
        )
    });
    match tokio::time::timeout_at(deadline, task).await {
        Ok(Ok(report)) => report,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "agent history coverage task failed");
            CoverageReport::ambiguous()
        }
        Err(_) => {
            tracing::warn!("agent history coverage inspection timed out");
            CoverageReport::ambiguous()
        }
    }
}

async fn persist_agent_session_id(
    app_session_id: String,
    agent_session_id: String,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        crate::store::set_session_agent_session_id_strict(&app_session_id, &agent_session_id)
    })
    .await;
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "continuity recovery meta update failed");
            Err(continuity_recovery_error())
        }
        Err(error) => {
            tracing::warn!(error = %error, "continuity recovery meta task failed");
            Err(continuity_recovery_error())
        }
    }
}

async fn build_bootstrap(app_session_id: String) -> Result<Option<HistoryBootstrapBundle>, String> {
    match tokio::task::spawn_blocking(move || build_history_bootstrap_bundle(&app_session_id)).await
    {
        Ok(Ok(bundle)) => Ok(bundle),
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "continuity bootstrap journal read failed");
            Err(continuity_recovery_error())
        }
        Err(error) => {
            tracing::warn!(error = %error, "continuity bootstrap build task failed");
            Err(continuity_recovery_error())
        }
    }
}

async fn journal_has_bootstrap_context(app_session_id: String) -> Result<bool, String> {
    match tokio::task::spawn_blocking(move || {
        crate::store::load_messages_strict(&app_session_id).map(|journal| {
            journal
                .iter()
                .any(crate::session_attach::is_bootstrap_context_message)
        })
    })
    .await
    {
        Ok(Ok(has_context)) => Ok(has_context),
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "continuity journal inspection failed");
            Err(continuity_recovery_error())
        }
        Err(error) => {
            tracing::warn!(error = %error, "continuity journal inspection task failed");
            Err(continuity_recovery_error())
        }
    }
}

async fn build_bootstrap_for_recovery(
    app_session_id: String,
) -> Result<Option<HistoryBootstrapBundle>, String> {
    let bundle = build_bootstrap(app_session_id.clone()).await?;
    if bundle.is_none() && journal_has_bootstrap_context(app_session_id).await? {
        return Err(continuity_recovery_error());
    }
    Ok(bundle)
}

fn attach_bootstrap(
    checkpoint: &mut ContinuityCheckpoint,
    bundle: HistoryBootstrapBundle,
    pending_prompt_id: &str,
) -> ContinuityBootstrap {
    checkpoint.record_bootstrap(crate::continuity::BootstrapScope {
        bundle_id: bundle.bundle_id,
        prompt_id: pending_prompt_id.to_string(),
        included: bundle.included,
        omitted: bundle.omitted,
        included_message_ids: bundle.included_message_ids,
        included_message_digests: bundle.included_message_digests,
        omitted_from_message_id: bundle.omitted_from_message_id,
        omitted_through_message_id: bundle.omitted_through_message_id,
    });
    ContinuityBootstrap { body: bundle.body }
}

/// 重连阶段只记录待核验状态；发送门会在下一个模型请求前检查覆盖关系。
///
/// 此处不读取 Agent transcript，避免重开会话时解析大型历史文件。
pub(super) async fn continuity_after_open(
    app_session_id: &str,
    agent_session_id: &str,
    resumed: bool,
    route_id: &str,
    cwd: &str,
    remote: bool,
    custom_route: bool,
) -> ContinuityCheckpoint {
    let previous = read_checkpoint(app_session_id.to_string()).await;
    let mode = crate::store::load_settings().session_data_mode;
    let route = ContinuityRoute::new(route_id, cwd, mode).with_custom_route(custom_route);
    let mut checkpoint = continuity::after_reconnect(previous, agent_session_id, &route, resumed);
    if remote && resumed {
        // 重连后的 SSH 历史只在远端可见，发送前必须从 App journal 恢复。
        checkpoint.mark_unverified(ContinuityReason::RemoteUnverified);
    }
    let _ = save_checkpoint(app_session_id.to_string(), checkpoint.clone()).await;
    checkpoint
}

async fn persist_pending_send(
    manager: &Arc<SessionManager>,
    context: &mut ContinuityContext,
    agent_session_id: &str,
    pending_prompt_id: &str,
) -> Result<(), String> {
    let repair_agent_link = context.agent_session_id.as_deref() != Some(agent_session_id);
    context.checkpoint.begin_turn(pending_prompt_id);
    if !save_checkpoint(context.app_session_id.clone(), context.checkpoint.clone()).await {
        return Err(continuity_recovery_error());
    }
    if repair_agent_link {
        persist_agent_session_id(context.app_session_id.clone(), agent_session_id.to_string())
            .await?;
    }
    context.agent_session_id = Some(agent_session_id.to_string());
    manager.with_session_mut(&context.app_session_id, |session| {
        session.meta.agent_session_id = Some(agent_session_id.to_string());
        session.continuity = context.checkpoint.clone();
    });
    Ok(())
}

pub(super) async fn record_prepared_prompt_digests(
    manager: &SessionManager,
    app_session_id: &str,
    pending_prompt_id: &str,
    journal_prompt_digest: &str,
    final_prompt: &str,
    has_bootstrap: bool,
) {
    let bootstrap_body = if has_bootstrap {
        match continuity::bootstrap_body_from_prompt(final_prompt) {
            Some(body) => Some(body),
            None => {
                tracing::warn!(
                    session = %app_session_id,
                    "bootstrap marker missing after prompt preparation"
                );
                return;
            }
        }
    } else {
        None
    };
    let Some(context) = capture_context(manager, app_session_id) else {
        return;
    };
    if context.checkpoint.pending_prompt_id.as_deref() != Some(pending_prompt_id)
        || (has_bootstrap && context.checkpoint.bootstrap_bundle_id.is_none())
    {
        return;
    }
    let mut updated = context.checkpoint.clone();
    if let Some(body) = bootstrap_body {
        updated.refresh_bootstrap_bundle_id(&body);
    }
    updated.record_prepared_prompt_digests(
        journal_prompt_digest.to_string(),
        crate::cli_sessions::continuity_coverage::agent_prompt_digest_for_content(final_prompt),
    );
    let Some(_connect_guard) = manager.try_lock_connect(COVERAGE_INSPECT_TIMEOUT).await else {
        return;
    };
    let Some(current) = capture_context(manager, app_session_id) else {
        return;
    };
    if current.agent_session_id != context.agent_session_id
        || !current
            .checkpoint
            .matches_pending_snapshot(&context.checkpoint, pending_prompt_id)
    {
        return;
    }
    if !save_checkpoint(app_session_id.to_string(), updated.clone()).await {
        return;
    }
    manager.with_session_mut(app_session_id, |session| {
        if session.meta.agent_session_id.as_deref() == context.agent_session_id.as_deref()
            && session
                .continuity
                .matches_pending_snapshot(&context.checkpoint, pending_prompt_id)
        {
            session.continuity = updated;
        }
    });
}

async fn prepare_remote_continuity_send(
    manager: &Arc<SessionManager>,
    mut context: ContinuityContext,
    pending_prompt_id: String,
) -> Result<ContinuitySendPlan, String> {
    let mut agent_session_id = context
        .agent_session_id
        .clone()
        .or_else(|| context.checkpoint.agent_session_id.clone())
        .ok_or_else(continuity_recovery_error)?;
    let mut bootstrap = None;

    if context.checkpoint.needs_recovery() {
        let (recovered_agent_id, bundle) =
            if context.checkpoint.reason == Some(ContinuityReason::NewAgentSession) {
                (
                    agent_session_id.clone(),
                    build_bootstrap_for_recovery(context.app_session_id.clone()).await?,
                )
            } else {
                recover_with_new_session(manager, &mut context).await?
            };
        agent_session_id = recovered_agent_id;
        context.agent_session_id = Some(agent_session_id.clone());
        if let Some(bundle) = bundle {
            bootstrap = Some(attach_bootstrap(
                &mut context.checkpoint,
                bundle,
                &pending_prompt_id,
            ));
        }
    }

    persist_pending_send(manager, &mut context, &agent_session_id, &pending_prompt_id).await?;
    Ok(ContinuitySendPlan {
        pending_prompt_id,
        bootstrap,
    })
}

async fn remote_turn_coverage(
    app_session_id: String,
    checkpoint: ContinuityCheckpoint,
    pending_prompt_id: String,
) -> Option<(Vec<String>, u32)> {
    let deadline = tokio::time::Instant::now() + COVERAGE_INSPECT_TIMEOUT;
    let permit = match tokio::time::timeout_at(deadline, COVERAGE_INSPECT_SEMAPHORE.acquire()).await
    {
        Ok(Ok(permit)) => permit,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "remote live continuity permit failed");
            return None;
        }
        Err(_) => {
            tracing::warn!("remote live continuity wait timed out");
            return None;
        }
    };
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let journal = crate::store::load_messages_strict(&app_session_id)?;
        let Some(prompt_index) = journal.iter().position(|message| {
            message.id == pending_prompt_id && crate::store::is_user_prompt_message(message)
        }) else {
            return Err("remote turn prompt is missing from the App journal".to_string());
        };
        let mut seen = std::collections::HashSet::new();
        let covered_message_ids: Vec<String> = checkpoint
            .covered_message_ids
            .iter()
            .chain(&checkpoint.bootstrap_included_message_ids)
            .chain(journal[prompt_index..].iter().map(|message| &message.id))
            .filter(|id| seen.insert((*id).clone()))
            .cloned()
            .collect();
        let covered: std::collections::HashSet<&str> =
            covered_message_ids.iter().map(String::as_str).collect();
        let covered_prompt_count = journal
            .iter()
            .filter(|message| {
                crate::store::is_user_prompt_message(message)
                    && covered.contains(message.id.as_str())
            })
            .count() as u32;
        Ok((covered_message_ids, covered_prompt_count))
    });
    match tokio::time::timeout_at(deadline, task).await {
        Ok(Ok(Ok(coverage))) => Some(coverage),
        Ok(Ok(Err(error))) => {
            tracing::warn!(error = %error, "remote live continuity check failed");
            None
        }
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "remote live continuity check task failed");
            None
        }
        Err(_) => {
            tracing::warn!("remote live continuity check timed out");
            None
        }
    }
}

/// 回合结束后只有在已完成 prompt 的历史覆盖完整时，才能将检查点恢复为 `Verified`。
pub(super) async fn verify_continuity_after_turn(
    manager: &SessionManager,
    app_session_id: &str,
    completed_prompt_id: &str,
) {
    let Some(context) = capture_context(manager, app_session_id) else {
        return;
    };
    if context.backend == "mock_acp"
        || context.checkpoint.pending_prompt_id.as_deref() != Some(completed_prompt_id)
    {
        return;
    }
    if context.remote {
        let Some((covered_message_ids, covered_prompt_count)) = remote_turn_coverage(
            context.app_session_id.clone(),
            context.checkpoint.clone(),
            completed_prompt_id.to_string(),
        )
        .await
        else {
            return;
        };
        let mut updated = context.checkpoint.clone();
        updated.mark_verified(&covered_message_ids, covered_prompt_count);
        let Some(_connect_guard) = manager.try_lock_connect(COVERAGE_INSPECT_TIMEOUT).await else {
            return;
        };
        let Some(current) = capture_context(manager, app_session_id) else {
            return;
        };
        if current.agent_session_id != context.agent_session_id
            || !current
                .checkpoint
                .matches_pending_snapshot(&context.checkpoint, completed_prompt_id)
        {
            return;
        }
        // 远端只核验当前活跃 ACP 会话；不落盘，重连后必须重新恢复。
        manager.with_session_mut(app_session_id, |session| {
            if session.meta.agent_session_id.as_deref() == context.agent_session_id.as_deref()
                && session
                    .continuity
                    .matches_pending_snapshot(&context.checkpoint, completed_prompt_id)
            {
                session.continuity = updated;
            }
        });
        return;
    }
    let Some(agent_session_id) = context
        .agent_session_id
        .clone()
        .or_else(|| context.checkpoint.agent_session_id.clone())
    else {
        return;
    };
    let mode = context
        .checkpoint
        .session_data_mode
        .clone()
        .unwrap_or_else(|| crate::store::load_settings().session_data_mode);
    let coverage = inspect_coverage(
        app_session_id,
        &agent_session_id,
        context.project_path.as_deref(),
        &mode,
        context.custom_route,
    )
    .await;
    let updated = continuity::after_turn(
        context.checkpoint.clone(),
        &coverage,
        Some(completed_prompt_id),
    );
    if updated == context.checkpoint {
        return;
    }
    // 将检查点提交与下一次发送的 prepare 阶段串行化。
    let Some(_connect_guard) = manager.try_lock_connect(COVERAGE_INSPECT_TIMEOUT).await else {
        return;
    };
    let Some(current) = capture_context(manager, app_session_id) else {
        return;
    };
    if current.agent_session_id != context.agent_session_id
        || current.checkpoint.pending_prompt_id.as_deref() != Some(completed_prompt_id)
    {
        return;
    }
    if !save_checkpoint(app_session_id.to_string(), updated.clone()).await {
        return;
    }
    manager.with_session_mut(app_session_id, |session| {
        session.continuity = updated;
    });
}

/// 发送门：在下一个模型请求前核验覆盖，并按需从 App journal 恢复；返回需前置的 bootstrap。
pub(super) async fn prepare_continuity_send(
    manager: &Arc<SessionManager>,
    app_session_id: &str,
) -> Result<ContinuitySendPlan, String> {
    let pending_prompt_id = Uuid::new_v4().to_string();
    if AcpClient::use_mock() {
        // Mock backend 没有可核验的持久化 Agent 历史。
        return Ok(ContinuitySendPlan {
            pending_prompt_id,
            bootstrap: None,
        });
    }
    let Some(mut context) = capture_context(manager, app_session_id) else {
        return Err(continuity_recovery_error());
    };
    // Agent session 正由回合占用时不检查或恢复；connect lock 同时阻止重复发送。
    if manager
        .with_session_mut(app_session_id, |session| session.prompt_in_flight)
        .unwrap_or(false)
    {
        return Err(format!(
            "{}: chat {} is still running its previous turn",
            crate::error::AgentErrorCode::ConnectFailed.as_str(),
            app_session_id
        ));
    }
    if context.backend == "mock_acp" {
        return Ok(ContinuitySendPlan {
            pending_prompt_id,
            bootstrap: None,
        });
    }
    if context.remote {
        return prepare_remote_continuity_send(manager, context, pending_prompt_id).await;
    }

    let mode = context
        .checkpoint
        .session_data_mode
        .clone()
        .unwrap_or_else(|| crate::store::load_settings().session_data_mode);
    let agent_session_id = context
        .agent_session_id
        .clone()
        .or_else(|| context.checkpoint.agent_session_id.clone())
        .ok_or_else(continuity_recovery_error)?;

    let mut coverage = None;
    let mut bootstrap_current_agent = false;
    let decision = if context.checkpoint.needs_recovery() {
        let report = inspect_coverage(
            app_session_id,
            &agent_session_id,
            context.project_path.as_deref(),
            &mode,
            context.custom_route,
        )
        .await;
        bootstrap_current_agent = continuity::can_bootstrap_current_agent(
            &context.checkpoint,
            &agent_session_id,
            &report,
        );
        let route = ContinuityRoute::new(
            context.checkpoint.route_id.clone().unwrap_or_default(),
            context.project_path.clone().unwrap_or_default(),
            mode.clone(),
        )
        .with_custom_route(context.custom_route);
        context.checkpoint = continuity::after_open(
            CheckpointRead::Loaded(Box::new(context.checkpoint.clone())),
            &agent_session_id,
            &route,
            true,
            &report,
        );
        let decision = continuity::decide_coverage(&report);
        coverage = Some(report);
        decision
    } else {
        CoverageDecision::Verified
    };

    let mut bootstrap = None;
    match decision {
        CoverageDecision::Verified => {
            if let Some(report) = coverage.as_ref() {
                context
                    .checkpoint
                    .mark_verified(&report.covered_message_ids, report.covered_prompt_count);
            }
        }
        CoverageDecision::Fresh => {
            context
                .checkpoint
                .mark_bootstrap_pending(ContinuityReason::NoPromptYet);
        }
        CoverageDecision::Recover => {
            let (agent_session_id, bundle) = if bootstrap_current_agent {
                let bundle = build_bootstrap(context.app_session_id.clone())
                    .await?
                    .ok_or_else(continuity_recovery_error)?;
                (agent_session_id.clone(), Some(bundle))
            } else {
                recover_with_new_session(manager, &mut context).await?
            };
            context.agent_session_id = Some(agent_session_id.clone());
            if let Some(bundle) = bundle {
                bootstrap = Some(attach_bootstrap(
                    &mut context.checkpoint,
                    bundle,
                    &pending_prompt_id,
                ));
            }
        }
    }

    persist_pending_send(manager, &mut context, &agent_session_id, &pending_prompt_id).await?;
    Ok(ContinuitySendPlan {
        pending_prompt_id,
        bootstrap,
    })
}

async fn recover_with_new_session(
    manager: &Arc<SessionManager>,
    context: &mut ContinuityContext,
) -> Result<(String, Option<HistoryBootstrapBundle>), String> {
    // 创建新的 Agent session 前先安全检查 App journal。
    let bundle = build_bootstrap_for_recovery(context.app_session_id.clone()).await?;
    let acp = context.acp.clone().ok_or_else(continuity_recovery_error)?;
    let cwd = context.project_path.clone().unwrap_or_default();
    let (agent_session_id, _) =
        SessionManager::with_handshake_budget(acp.open_session_at(None, false, &cwd))
            .await
            .map_err(|error| {
                tracing::warn!(
                    session = %context.app_session_id,
                    error = %error.message,
                    "continuity recovery session/new failed"
                );
                continuity_recovery_error()
            })?;
    tracing::info!(
        session = %context.app_session_id,
        agent = %agent_session_id,
        "continuity recovery opened a fresh agent session"
    );

    let route_id = context
        .checkpoint
        .route_id
        .as_deref()
        .unwrap_or(crate::providers::SESSION_PROVIDER_OFFICIAL);
    if let Some(model_id) = context.model_id.clone().filter(|s| !s.trim().is_empty()) {
        if let Err(error) =
            super::connect::apply_connected_model(&acp, &agent_session_id, route_id, &model_id)
                .await
        {
            tracing::warn!(
                session = %context.app_session_id,
                error = %error,
                "continuity recovery model was refused"
            );
            return Err(continuity_recovery_error());
        }
    }
    if let Some(mode) = context
        .product_mode
        .clone()
        .filter(|s| !s.trim().is_empty())
    {
        if let Err(error) = acp.set_mode_for(&agent_session_id, &mode).await {
            tracing::warn!("continuity recovery set_mode soft-fail: {error}");
        }
    }

    persist_agent_session_id(context.app_session_id.clone(), agent_session_id.clone()).await?;
    manager.with_session_mut(&context.app_session_id, |session| {
        session.meta.agent_session_id = Some(agent_session_id.clone());
    });

    let route = ContinuityRoute::new(
        route_id,
        context.project_path.clone().unwrap_or_default(),
        context
            .checkpoint
            .session_data_mode
            .clone()
            .unwrap_or_else(|| crate::store::load_settings().session_data_mode),
    )
    .with_custom_route(context.custom_route);
    let mut next = ContinuityCheckpoint {
        agent_session_id: Some(agent_session_id.clone()),
        route_id: Some(route.route_id),
        cwd: Some(route.cwd),
        session_data_mode: Some(route.session_data_mode),
        custom_route: route.custom_route,
        ..ContinuityCheckpoint::default()
    };
    next.mark_bootstrap_pending(ContinuityReason::NewAgentSession);
    context.checkpoint = next;
    Ok((agent_session_id, bundle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // test-only env isolation lock
    async fn remote_resume_stays_unverified_until_send_recovery() {
        let _home = crate::test_support::TestAppHome::new("continuity-gate");

        let checkpoint = continuity_after_open(
            "remote-session",
            "agent-remote",
            true,
            "official",
            "/tmp",
            true,
            false,
        )
        .await;

        assert_eq!(
            checkpoint.status,
            crate::continuity::ContinuityStatus::Unverified
        );
        assert_eq!(checkpoint.reason, Some(ContinuityReason::RemoteUnverified));
        assert!(matches!(
            crate::continuity::read("remote-session"),
            CheckpointRead::Loaded(_)
        ));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn fresh_remote_agent_bootstraps_and_keeps_only_live_verification() {
        let _home = crate::test_support::TestAppHome::new("continuity-remote-live");
        let mut meta = crate::store::create_session(None, Some("remote".into()), false).unwrap();
        let agent_id = "agent-remote-fresh";
        meta.agent_session_id = Some(agent_id.into());
        crate::store::update_session_meta(&meta).unwrap();
        crate::store::append_message(
            &meta.id,
            crate::store::ChatMessageStored {
                id: "prior-user".into(),
                role: "user".into(),
                content: "prior remote question".into(),
                thought: None,
                created_at: chrono::Utc::now(),
                is_error: false,
                attachments: None,
                marker: None,
            },
        )
        .unwrap();
        let route = ContinuityRoute::new("official", "/data/remote-project", "shared");
        let checkpoint =
            continuity::after_reconnect(CheckpointRead::Missing, agent_id, &route, false);
        continuity::save(&meta.id, &checkpoint).unwrap();

        let mut live = super::super::routing_tests::bare_live_session(&meta.id, "remote-proc");
        live.meta = meta.clone();
        live.meta.agent_session_id = Some(agent_id.into());
        live.backend = "grok_agent_stdio".into();
        live.acp = Some(AcpClient::test_ssh_stub(true));
        live.project_path = Some(route.cwd.clone());
        live.continuity = checkpoint;
        let manager = Arc::new(SessionManager::new());
        *manager.inner.lock() = Some(live);

        let first = prepare_continuity_send(&manager, &meta.id).await.unwrap();
        assert!(first
            .bootstrap
            .as_ref()
            .is_some_and(|bootstrap| bootstrap.body.contains("prior remote question")));
        crate::store::append_message(
            &meta.id,
            crate::store::ChatMessageStored {
                id: first.pending_prompt_id.clone(),
                role: "user".into(),
                content: "new remote question".into(),
                thought: None,
                created_at: chrono::Utc::now(),
                is_error: false,
                attachments: None,
                marker: None,
            },
        )
        .unwrap();
        crate::store::append_message(
            &meta.id,
            crate::store::ChatMessageStored {
                id: "remote-answer".into(),
                role: "assistant".into(),
                content: "answer".into(),
                thought: None,
                created_at: chrono::Utc::now(),
                is_error: false,
                attachments: None,
                marker: None,
            },
        )
        .unwrap();

        verify_continuity_after_turn(&manager, &meta.id, &first.pending_prompt_id).await;

        let live_checkpoint = manager
            .inner
            .lock()
            .as_ref()
            .expect("remote session remains live")
            .continuity
            .clone();
        assert_eq!(
            live_checkpoint.status,
            crate::continuity::ContinuityStatus::Verified
        );
        assert_eq!(live_checkpoint.pending_prompt_id, None);
        let persisted = match continuity::read(&meta.id) {
            CheckpointRead::Loaded(checkpoint) => checkpoint,
            other => panic!("expected pending checkpoint, got {other:?}"),
        };
        assert_eq!(
            persisted.status,
            crate::continuity::ContinuityStatus::BootstrapPending
        );
        assert_eq!(
            persisted.pending_prompt_id.as_deref(),
            Some(first.pending_prompt_id.as_str())
        );

        let second = prepare_continuity_send(&manager, &meta.id).await.unwrap();
        assert!(second.bootstrap.is_none());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn new_remote_agent_remains_eligible_for_bootstrap() {
        let _home = crate::test_support::TestAppHome::new("continuity-remote-new");
        let checkpoint = continuity_after_open(
            "remote-new-session",
            "agent-remote-new",
            false,
            "official",
            "/data/project",
            true,
            false,
        )
        .await;

        assert_eq!(
            checkpoint.status,
            crate::continuity::ContinuityStatus::BootstrapPending
        );
        assert_eq!(checkpoint.reason, Some(ContinuityReason::NewAgentSession));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn remote_post_turn_check_does_not_verify_a_newer_pending_prompt() {
        let _home = crate::test_support::TestAppHome::new("continuity-remote-stale-verify");
        let mut meta = crate::store::create_session(None, Some("remote".into()), false).unwrap();
        let agent_id = "agent-remote-stale";
        meta.agent_session_id = Some(agent_id.into());
        crate::store::update_session_meta(&meta).unwrap();
        crate::store::append_message(
            &meta.id,
            crate::store::ChatMessageStored {
                id: "new-prompt".into(),
                role: "user".into(),
                content: "not dispatched yet".into(),
                thought: None,
                created_at: chrono::Utc::now(),
                is_error: false,
                attachments: None,
                marker: None,
            },
        )
        .unwrap();
        let route = ContinuityRoute::new("official", "/data/remote-project", "shared");
        let mut checkpoint = ContinuityCheckpoint::default();
        checkpoint.attach_route(agent_id, &route);
        checkpoint.begin_turn("new-prompt");
        continuity::save(&meta.id, &checkpoint).unwrap();

        let mut live = super::super::routing_tests::bare_live_session(&meta.id, "remote-proc");
        live.meta = meta.clone();
        live.meta.agent_session_id = Some(agent_id.into());
        live.backend = "grok_agent_stdio".into();
        live.acp = Some(AcpClient::test_ssh_stub(true));
        live.project_path = Some(route.cwd);
        live.continuity = checkpoint;
        let manager = Arc::new(SessionManager::new());
        *manager.inner.lock() = Some(live);

        verify_continuity_after_turn(&manager, &meta.id, "old-prompt").await;

        let current = manager
            .inner
            .lock()
            .as_ref()
            .expect("remote session remains live")
            .continuity
            .clone();
        assert_eq!(current.pending_prompt_id.as_deref(), Some("new-prompt"));
        assert_eq!(
            current.status,
            crate::continuity::ContinuityStatus::BootstrapPending
        );
    }

    #[test]
    fn strict_agent_session_link_update_preserves_current_fields() {
        let _home = crate::test_support::TestAppHome::new("continuity-agent-link-update");
        let mut meta =
            crate::store::create_session(None, Some("continuity".into()), false).unwrap();
        meta.provider_id = Some("relay-old".into());
        meta.model_id = Some("model-old".into());
        crate::store::update_session_meta(&meta).unwrap();

        let mut latest = meta.clone();
        latest.provider_id = Some("relay-current".into());
        latest.model_id = Some("model-current".into());
        latest.title = "current title".into();
        latest.updated_at = chrono::Utc::now();
        crate::store::update_session_meta(&latest).unwrap();

        crate::store::set_session_agent_session_id_strict(&meta.id, "agent-recovered").unwrap();

        let persisted = crate::store::load_sessions_index_strict_readonly()
            .unwrap()
            .into_iter()
            .find(|session| session.id == meta.id)
            .expect("session row remains present");
        assert_eq!(
            persisted.agent_session_id.as_deref(),
            Some("agent-recovered")
        );
        assert_eq!(persisted.provider_id.as_deref(), Some("relay-current"));
        assert_eq!(persisted.model_id.as_deref(), Some("model-current"));
        assert_eq!(persisted.title, "current title");
        assert_eq!(persisted.updated_at, latest.updated_at);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn corrupt_sessions_index_blocks_agent_link_persistence() {
        let _home = crate::test_support::TestAppHome::new("continuity-corrupt-index");
        let meta = crate::store::create_session(None, Some("continuity".into()), false).unwrap();
        let path = crate::paths::sessions_index_file();
        let corrupt = b"{broken sessions index";
        std::fs::write(&path, corrupt).unwrap();

        let result = persist_agent_session_id(meta.id, "agent-recovered".into()).await;

        assert_eq!(
            result,
            Err(crate::error::AgentErrorCode::ConnectFailed.as_str().into())
        );
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn missing_agent_id_fails_before_recording_a_prompt() {
        let _home = crate::test_support::TestAppHome::new("continuity-missing-agent");
        let meta = crate::store::create_session(None, Some("continuity".into()), false).unwrap();
        let mut live = super::super::routing_tests::bare_live_session(&meta.id, "continuity-proc");
        live.meta = meta.clone();
        live.backend = "grok_agent_stdio".into();
        live.acp = Some(AcpClient::test_stub(true));
        let manager = Arc::new(SessionManager::new());
        *manager.inner.lock() = Some(live);

        let result = prepare_continuity_send(&manager, &meta.id).await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("send gate must reject a missing Agent session id"),
        };

        assert_eq!(error, crate::error::AgentErrorCode::ConnectFailed.as_str());
        assert!(crate::store::load_messages_strict(&meta.id)
            .unwrap()
            .is_empty());
        assert_eq!(continuity::read(&meta.id), CheckpointRead::Missing);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn fresh_empty_agent_bootstraps_in_place_before_first_prompt() {
        let _home = crate::test_support::TestAppHome::new("continuity-fresh-agent");
        let mut meta =
            crate::store::create_session(None, Some("continuity".into()), false).unwrap();
        let agent_id = "agent-fresh";
        meta.agent_session_id = Some(agent_id.into());
        crate::store::update_session_meta(&meta).unwrap();
        crate::store::append_message(
            &meta.id,
            crate::store::ChatMessageStored {
                id: "prior-user".into(),
                role: "user".into(),
                content: "prior question".into(),
                thought: None,
                created_at: chrono::Utc::now(),
                is_error: false,
                attachments: None,
                marker: None,
            },
        )
        .unwrap();
        let route = ContinuityRoute::new("official", "/tmp/continuity-project", "independent");
        let checkpoint =
            continuity::after_reconnect(CheckpointRead::Missing, agent_id, &route, false);
        continuity::save(&meta.id, &checkpoint).unwrap();

        let mut live = super::super::routing_tests::bare_live_session(&meta.id, "continuity-proc");
        live.meta = meta.clone();
        live.meta.agent_session_id = Some(agent_id.into());
        live.backend = "grok_agent_stdio".into();
        live.acp = Some(AcpClient::test_stub(true));
        live.project_path = Some(route.cwd.clone());
        live.continuity = checkpoint;
        let manager = Arc::new(SessionManager::new());
        *manager.inner.lock() = Some(live);

        let plan = prepare_continuity_send(&manager, &meta.id).await.unwrap();

        assert!(plan.bootstrap.is_some());
        assert_eq!(
            manager
                .inner
                .lock()
                .as_ref()
                .and_then(|session| session.meta.agent_session_id.as_deref()),
            Some(agent_id)
        );
        let checkpoint = match continuity::read(&meta.id) {
            CheckpointRead::Loaded(checkpoint) => checkpoint,
            other => panic!("expected saved checkpoint, got {other:?}"),
        };
        assert_eq!(
            checkpoint.bootstrap_prompt_id.as_deref(),
            Some(plan.pending_prompt_id.as_str())
        );
        assert_eq!(
            checkpoint.bootstrap_included_message_ids,
            vec!["prior-user"]
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn resumed_agent_must_cover_all_journal_rows_before_and_after_send() {
        let _home = crate::test_support::TestAppHome::new("continuity-resume-gate");
        let mut meta =
            crate::store::create_session(None, Some("continuity".into()), false).unwrap();
        let agent_id = "agent-linked";
        let cwd = "/tmp/continuity-project";
        meta.agent_session_id = Some(agent_id.into());
        crate::store::update_session_meta(&meta).unwrap();
        let now = chrono::Utc::now();
        let initial = vec![
            crate::store::ChatMessageStored {
                id: "u1".into(),
                role: "user".into(),
                content: "first".into(),
                thought: None,
                created_at: now,
                is_error: false,
                attachments: None,
                marker: None,
            },
            crate::store::ChatMessageStored {
                id: "a1".into(),
                role: "assistant".into(),
                content: "answer".into(),
                thought: None,
                created_at: now,
                is_error: false,
                attachments: None,
                marker: None,
            },
            crate::store::ChatMessageStored {
                id: "tool-call-1".into(),
                role: "tool".into(),
                content: "tool_step|completed|run_terminal_command|Run Command".into(),
                thought: None,
                created_at: now,
                is_error: false,
                attachments: None,
                marker: Some("tool_step".into()),
            },
        ];
        crate::store::replace_messages(&meta.id, &initial).unwrap();
        let agent_dir = crate::paths::agent_home_dir()
            .join("sessions")
            .join(crate::paths::percent_encode_path_component(cwd))
            .join(agent_id);
        std::fs::create_dir_all(&agent_dir).unwrap();
        let history_rows = [
            serde_json::json!({"type":"user", "content":"first"}),
            serde_json::json!({"type":"assistant", "content":"answer"}),
            serde_json::json!({"type":"tool_result", "tool_call_id":"call-1", "content":"exit: 0"}),
        ];
        std::fs::write(
            agent_dir.join("chat_history.jsonl"),
            history_rows
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let route = ContinuityRoute::new("official", cwd, "independent");
        let checkpoint =
            continuity::after_reconnect(CheckpointRead::Missing, agent_id, &route, true);
        continuity::save(&meta.id, &checkpoint).unwrap();

        let mut live = super::super::routing_tests::bare_live_session(&meta.id, "continuity-proc");
        live.meta = meta.clone();
        live.meta.agent_session_id = Some(agent_id.into());
        live.backend = "grok_agent_stdio".into();
        live.acp = Some(AcpClient::test_stub(true));
        live.project_path = Some(cwd.into());
        live.continuity = checkpoint;
        let manager = Arc::new(SessionManager::new());
        *manager.inner.lock() = Some(live);

        let plan = prepare_continuity_send(&manager, &meta.id).await.unwrap();
        assert!(
            plan.bootstrap.is_none(),
            "complete native history must be reused"
        );
        let next_user = crate::store::ChatMessageStored {
            id: plan.pending_prompt_id.clone(),
            role: "user".into(),
            content: "next".into(),
            thought: None,
            created_at: chrono::Utc::now(),
            is_error: false,
            attachments: None,
            marker: None,
        };
        crate::store::append_message(&meta.id, next_user.clone()).unwrap();
        let next_assistant = crate::store::ChatMessageStored {
            id: "a2".into(),
            role: "assistant".into(),
            content: "next answer".into(),
            thought: None,
            created_at: chrono::Utc::now(),
            is_error: false,
            attachments: None,
            marker: None,
        };
        crate::store::append_message(&meta.id, next_assistant).unwrap();
        let completed_rows = [
            serde_json::json!({"type":"user", "content":"first"}),
            serde_json::json!({"type":"assistant", "content":"answer"}),
            serde_json::json!({"type":"tool_result", "tool_call_id":"call-1", "content":"exit: 0"}),
            serde_json::json!({"type":"user", "content":"next"}),
            serde_json::json!({"type":"assistant", "content":"next answer"}),
        ];
        std::fs::write(
            agent_dir.join("chat_history.jsonl"),
            completed_rows
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        verify_continuity_after_turn(&manager, &meta.id, &plan.pending_prompt_id).await;

        let saved = match continuity::read(&meta.id) {
            CheckpointRead::Loaded(checkpoint) => checkpoint,
            other => panic!("expected verified checkpoint, got {other:?}"),
        };
        assert_eq!(saved.status, crate::continuity::ContinuityStatus::Verified);
        assert_eq!(saved.covered_prompt_count, 2);
        assert_eq!(saved.pending_prompt_id, None);
        assert!(saved.covered_message_ids.contains(&plan.pending_prompt_id));
        assert!(saved.covered_message_ids.contains(&"tool-call-1".into()));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn corrupt_journal_fails_bootstrap_without_quarantining_it() {
        let _home = crate::test_support::TestAppHome::new("continuity-corrupt-bootstrap");
        let session = crate::store::create_session(None, Some("continuity".into()), false).unwrap();
        let path = crate::paths::session_dir(&session.id).join("messages.json");
        let corrupt = b"{unrecoverable transcript";
        std::fs::write(&path, corrupt).unwrap();

        let result = build_bootstrap(session.id.clone()).await;

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
        assert!(!path.with_extension("corrupt.json").exists());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn corrupt_attached_journal_fails_bootstrap_without_quarantining_it() {
        let _home = crate::test_support::TestAppHome::new("continuity-corrupt-attachment");
        let main = crate::store::create_session(None, Some("main".into()), false).unwrap();
        let attached = crate::store::create_session(None, Some("attached".into()), false).unwrap();
        crate::store::append_message(
            &main.id,
            crate::store::ChatMessageStored {
                id: "main-user".into(),
                role: "user".into(),
                content: format!("[[chat:{}]]\nanswer using that chat", attached.id),
                thought: None,
                created_at: chrono::Utc::now(),
                is_error: false,
                attachments: None,
                marker: None,
            },
        )
        .unwrap();
        let path = crate::paths::session_dir(&attached.id).join("messages.json");
        let corrupt = b"{broken attachment journal";
        std::fs::write(&path, corrupt).unwrap();

        let result = build_bootstrap(main.id).await;

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
        assert!(!path.with_extension("corrupt.json").exists());
    }
}
