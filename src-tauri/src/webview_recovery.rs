#![cfg_attr(not(windows), allow(dead_code))]
//! Pure WebView2 crash-recovery decisions.
//!
//! Windows maps `COREWEBVIEW2_PROCESS_FAILED_KIND` onto these codes and asks
//! this module what to do. The COM hook lives in `win_webview_recovery` and is
//! not compiled on macOS or Linux. Kind numbers match the WebView2 enum
//! (`BROWSER_PROCESS_EXITED` = 0, `RENDER_PROCESS_EXITED` = 1,
//! `RENDER_PROCESS_UNRESPONSIVE` = 2). Other kinds are logged and left alone:
//! the runtime restarts GPU and utility processes itself.

/// `COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED`
pub const KIND_BROWSER_PROCESS_EXITED: i32 = 0;
/// `COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED`
pub const KIND_RENDER_PROCESS_EXITED: i32 = 1;
/// `COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE`
pub const KIND_RENDER_PROCESS_UNRESPONSIVE: i32 = 2;

/// How many automatic recoveries one window may start inside [`RECOVERY_WINDOW_MS`].
pub const RECOVERY_MAX_ATTEMPTS: usize = 3;
/// Sliding window for [`RECOVERY_MAX_ATTEMPTS`].
pub const RECOVERY_WINDOW_MS: u64 = 60_000;

/// `COREWEBVIEW2_PROCESS_FAILED_REASON` values we put in the log line.
pub const REASON_UNEXPECTED: i32 = 0;
pub const REASON_UNRESPONSIVE: i32 = 1;
pub const REASON_TERMINATED: i32 = 2;
pub const REASON_CRASHED: i32 = 3;
pub const REASON_LAUNCH_FAILED: i32 = 4;
pub const REASON_OUT_OF_MEMORY: i32 = 5;
pub const REASON_PROFILE_DELETED: i32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessFailedKind {
    BrowserProcessExited,
    RenderProcessExited,
    RenderProcessUnresponsive,
    Other(i32),
}

impl ProcessFailedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BrowserProcessExited => "browser_process_exited",
            Self::RenderProcessExited => "render_process_exited",
            Self::RenderProcessUnresponsive => "render_process_unresponsive",
            Self::Other(_) => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryAction {
    /// WebView2 is dead. Destroy the native window and build it again.
    RecreateWindow,
    /// Renderer died or hung. `ICoreWebView2::Reload` keeps the same window.
    Reload,
    /// GPU / utility / iframe noise. Log it. Do not touch the window.
    LogOnly,
}

impl RecoveryAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RecreateWindow => "recreate",
            Self::Reload => "reload",
            Self::LogOnly => "log_only",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetDecision {
    Allowed { count: usize },
    Denied { recent: usize },
}

/// Where a dead webview should navigate after its window is rebuilt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoredUrl {
    /// App asset, hash and query included (`index.html#/session/…`).
    App(String),
    /// Full external URL (OAuth, album, any non-app host).
    External(String),
}

pub fn classify_kind(code: i32) -> ProcessFailedKind {
    match code {
        KIND_BROWSER_PROCESS_EXITED => ProcessFailedKind::BrowserProcessExited,
        KIND_RENDER_PROCESS_EXITED => ProcessFailedKind::RenderProcessExited,
        KIND_RENDER_PROCESS_UNRESPONSIVE => ProcessFailedKind::RenderProcessUnresponsive,
        other => ProcessFailedKind::Other(other),
    }
}

pub fn action_for(kind: ProcessFailedKind) -> RecoveryAction {
    match kind {
        ProcessFailedKind::BrowserProcessExited => RecoveryAction::RecreateWindow,
        ProcessFailedKind::RenderProcessExited | ProcessFailedKind::RenderProcessUnresponsive => {
            RecoveryAction::Reload
        }
        ProcessFailedKind::Other(_) => RecoveryAction::LogOnly,
    }
}

pub fn reason_name(code: i32) -> &'static str {
    match code {
        REASON_UNEXPECTED => "unexpected",
        REASON_UNRESPONSIVE => "unresponsive",
        REASON_TERMINATED => "terminated",
        REASON_CRASHED => "crashed",
        REASON_LAUNCH_FAILED => "launch_failed",
        REASON_OUT_OF_MEMORY => "out_of_memory",
        REASON_PROFILE_DELETED => "profile_deleted",
        _ => "unknown",
    }
}

/// Physical pixels to logical pixels. A non-positive scale is treated as 1.
pub fn logical_px(physical: u32, scale: f64) -> f64 {
    if !scale.is_finite() || scale <= 0.0 {
        return f64::from(physical);
    }
    f64::from(physical) / scale
}

/// Signed physical pixels (a window origin, which may sit on a monitor to the
/// left or above the primary) to logical pixels. A non-positive scale is 1.
pub fn logical_signed_px(physical: i32, scale: f64) -> f64 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    f64::from(physical) / scale
}

/// Last-window destruction asks to exit with `exit_code == None`.
/// Tray Quit and `app.exit` pass `Some` and must not be blocked.
/// `rebuilds_in_flight` is the number of windows currently being rebuilt.
pub fn blocks_exit_for_rebuild(exit_code: Option<i32>, rebuilds_in_flight: usize) -> bool {
    exit_code.is_none() && rebuilds_in_flight > 0
}

/// Keep the in-app route. `tauri.localhost` / `tauri:` / `asset:` stay inside
/// the asset host. Anything else is reopened as an external URL.
pub fn restored_url(current: &str) -> RestoredUrl {
    let current = current.trim();
    if current.is_empty() || current.eq_ignore_ascii_case("about:blank") {
        return RestoredUrl::App("index.html".to_string());
    }
    let Ok(url) = url::Url::parse(current) else {
        return RestoredUrl::App("index.html".to_string());
    };
    let embedded = url.host_str() == Some("tauri.localhost")
        || url.scheme() == "tauri"
        || url.scheme() == "asset";
    if !embedded {
        return RestoredUrl::External(url.to_string());
    }
    let mut path = url.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".to_string();
    }
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        path.push('#');
        path.push_str(fragment);
    }
    RestoredUrl::App(path)
}

/// Sliding window of recovery timestamps for one window label.
#[derive(Debug, Clone)]
pub struct RecoveryBudget {
    max: usize,
    window_ms: u64,
    attempts: Vec<u64>,
}

impl RecoveryBudget {
    pub fn new(max: usize, window_ms: u64) -> Self {
        Self {
            max: max.max(1),
            window_ms,
            attempts: Vec::new(),
        }
    }

    pub fn standard() -> Self {
        Self::new(RECOVERY_MAX_ATTEMPTS, RECOVERY_WINDOW_MS)
    }

    /// Record `now_ms` when fewer than `max` attempts fall inside the window.
    /// A denied call does not record, so a later quiet period can recover again.
    pub fn try_acquire(&mut self, now_ms: u64) -> BudgetDecision {
        let window_ms = self.window_ms;
        self.attempts
            .retain(|stamp| now_ms.saturating_sub(*stamp) < window_ms);
        if self.attempts.len() >= self.max {
            return BudgetDecision::Denied {
                recent: self.attempts.len(),
            };
        }
        self.attempts.push(now_ms);
        BudgetDecision::Allowed {
            count: self.attempts.len(),
        }
    }
}

impl Default for RecoveryBudget {
    fn default() -> Self {
        Self::standard()
    }
}

/// One app.log line. `action=give_up` means the budget refused another loop.
pub fn recovery_log_line(
    label: &str,
    kind: ProcessFailedKind,
    requested: RecoveryAction,
    decision: BudgetDecision,
    exit_code: Option<i32>,
    reason: Option<i32>,
) -> String {
    let (action, count) = match decision {
        BudgetDecision::Allowed { count } => (requested.as_str(), count),
        BudgetDecision::Denied { recent } => ("give_up", recent),
    };
    let mut line = format!(
        "label={label} kind={} kind_code={} requested={} action={action} count={count} limit={}",
        kind.as_str(),
        kind_code(kind),
        requested.as_str(),
        RECOVERY_MAX_ATTEMPTS,
    );
    if let ProcessFailedKind::Other(code) = kind {
        line.push_str(&format!(" other={code}"));
    }
    if let Some(exit_code) = exit_code {
        line.push_str(&format!(" exit={exit_code}"));
    }
    if let Some(reason) = reason {
        line.push_str(&format!(
            " reason={} reason_code={reason}",
            reason_name(reason)
        ));
    }
    line
}

fn kind_code(kind: ProcessFailedKind) -> i32 {
    match kind {
        ProcessFailedKind::BrowserProcessExited => KIND_BROWSER_PROCESS_EXITED,
        ProcessFailedKind::RenderProcessExited => KIND_RENDER_PROCESS_EXITED,
        ProcessFailedKind::RenderProcessUnresponsive => KIND_RENDER_PROCESS_UNRESPONSIVE,
        ProcessFailedKind::Other(code) => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_three_recoverable_kinds() {
        assert_eq!(
            classify_kind(KIND_BROWSER_PROCESS_EXITED),
            ProcessFailedKind::BrowserProcessExited
        );
        assert_eq!(
            action_for(ProcessFailedKind::BrowserProcessExited),
            RecoveryAction::RecreateWindow
        );
        assert_eq!(
            action_for(classify_kind(KIND_RENDER_PROCESS_EXITED)),
            RecoveryAction::Reload
        );
        assert_eq!(
            action_for(classify_kind(KIND_RENDER_PROCESS_UNRESPONSIVE)),
            RecoveryAction::Reload
        );
    }

    #[test]
    fn gpu_frame_and_utility_are_log_only() {
        for code in [3, 4, 5, 6, 7, 8, 9, -1, 42] {
            let kind = classify_kind(code);
            assert_eq!(action_for(kind), RecoveryAction::LogOnly, "{code}");
            assert_eq!(kind.as_str(), "other");
        }
    }

    #[test]
    fn budget_allows_three_inside_the_window_then_stops() {
        let mut budget = RecoveryBudget::standard();
        assert_eq!(budget.try_acquire(0), BudgetDecision::Allowed { count: 1 });
        assert_eq!(
            budget.try_acquire(1_000),
            BudgetDecision::Allowed { count: 2 }
        );
        assert_eq!(
            budget.try_acquire(2_000),
            BudgetDecision::Allowed { count: 3 }
        );
        assert_eq!(
            budget.try_acquire(3_000),
            BudgetDecision::Denied { recent: 3 }
        );
        // Denied calls must not stick, or the window could never open again.
        assert_eq!(
            budget.try_acquire(3_001),
            BudgetDecision::Denied { recent: 3 }
        );
    }

    #[test]
    fn budget_drops_attempts_older_than_sixty_seconds() {
        let mut budget = RecoveryBudget::standard();
        budget.try_acquire(0);
        budget.try_acquire(10);
        budget.try_acquire(20);
        assert_eq!(budget.try_acquire(30), BudgetDecision::Denied { recent: 3 });
        // t=0 is exactly 60s old and falls out. Two remain, so one more is allowed.
        assert_eq!(
            budget.try_acquire(60_000),
            BudgetDecision::Allowed { count: 3 }
        );
        assert_eq!(
            budget.try_acquire(60_001),
            BudgetDecision::Denied { recent: 3 }
        );
    }

    #[test]
    fn restored_url_keeps_the_app_route_and_external_pages() {
        assert_eq!(restored_url(""), RestoredUrl::App("index.html".to_string()));
        assert_eq!(
            restored_url("about:blank"),
            RestoredUrl::App("index.html".to_string())
        );
        assert_eq!(
            restored_url("https://tauri.localhost/index.html#/session/abc"),
            RestoredUrl::App("index.html#/session/abc".to_string())
        );
        assert_eq!(
            restored_url("https://tauri.localhost/index.html?x=1#/pet"),
            RestoredUrl::App("index.html?x=1#/pet".to_string())
        );
        assert_eq!(
            restored_url("https://tauri.localhost/"),
            RestoredUrl::App("index.html".to_string())
        );
        assert_eq!(
            restored_url("https://accounts.google.com/o/oauth2/v2/auth?client_id=1"),
            RestoredUrl::External(
                "https://accounts.google.com/o/oauth2/v2/auth?client_id=1".to_string()
            )
        );
    }

    #[test]
    fn logical_px_divides_by_scale() {
        assert_eq!(logical_px(1200, 2.0), 600.0);
        assert_eq!(logical_px(100, 1.25), 80.0);
        assert_eq!(logical_px(90, 0.0), 90.0);
    }

    #[test]
    fn logical_signed_px_keeps_off_primary_origins() {
        assert_eq!(logical_signed_px(-200, 2.0), -100.0);
        assert_eq!(logical_signed_px(80, 1.25), 64.0);
        assert_eq!(logical_signed_px(-40, 0.0), -40.0);
    }

    #[test]
    fn exit_is_blocked_only_while_a_rebuild_is_in_flight() {
        assert!(!blocks_exit_for_rebuild(None, 0));
        assert!(blocks_exit_for_rebuild(None, 1));
        assert!(blocks_exit_for_rebuild(None, 2));
        // Tray Quit / app.exit / pending-quit failsafe.
        assert!(!blocks_exit_for_rebuild(Some(0), 1));
        assert!(!blocks_exit_for_rebuild(Some(1), 3));
    }

    #[test]
    fn log_line_names_kind_action_count_and_oom_reason() {
        let line = recovery_log_line(
            "main",
            ProcessFailedKind::BrowserProcessExited,
            RecoveryAction::RecreateWindow,
            BudgetDecision::Allowed { count: 2 },
            Some(1),
            Some(REASON_OUT_OF_MEMORY),
        );
        assert!(line.contains("label=main"));
        assert!(line.contains("kind=browser_process_exited"));
        assert!(line.contains("requested=recreate"));
        assert!(line.contains("action=recreate"));
        assert!(line.contains("count=2"));
        assert!(line.contains("limit=3"));
        assert!(line.contains("exit=1"));
        assert!(line.contains("reason=out_of_memory"));
    }

    #[test]
    fn denied_budget_logs_give_up() {
        let line = recovery_log_line(
            "session-abc",
            ProcessFailedKind::RenderProcessExited,
            RecoveryAction::Reload,
            BudgetDecision::Denied { recent: 3 },
            None,
            None,
        );
        assert!(line.contains("action=give_up"));
        assert!(line.contains("requested=reload"));
        assert!(line.contains("count=3"));
        assert!(!line.contains("exit="));
    }

    #[test]
    fn reason_names_cover_oom() {
        assert_eq!(reason_name(REASON_OUT_OF_MEMORY), "out_of_memory");
        assert_eq!(reason_name(99), "unknown");
    }
}
