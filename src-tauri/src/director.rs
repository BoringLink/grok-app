//! Director rule for `session/new`.
//!
//! The paragraph matches `DIRECTOR_RULE` in `src/lib/directorMode.ts`.
//! This module does not write `~/.grok`.

/// Sent as ACP `session/new` `_meta.rules` when Director mode is on.
pub const DIRECTOR_RULE: &str = "Do lane work with a background workflow or background subagents. Keep this transcript to decisions, blockers, and a short status. Put file lists, diffs, and command output in the child prompt. Name the task ids started. Ask before two writers share one tree.";

/// Rule text for `session/new`.
///
/// `use_app_director_rules` is fixed when the process starts (default on;
/// off for official aux). `director_enabled` is the app setting at the
/// moment the request is built, so a warm process still follows a toggle.
pub fn rules_for_session_new(
    use_app_director_rules: bool,
    director_enabled: bool,
) -> Option<&'static str> {
    if use_app_director_rules && director_enabled {
        Some(DIRECTOR_RULE)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_follow_the_setting_at_session_new() {
        assert_eq!(rules_for_session_new(true, false), None);
        assert_eq!(rules_for_session_new(false, true), None);
        assert_eq!(rules_for_session_new(false, false), None);
        assert_eq!(rules_for_session_new(true, true), Some(DIRECTOR_RULE));
    }
}
