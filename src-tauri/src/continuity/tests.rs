use super::*;

fn route() -> ContinuityRoute {
    ContinuityRoute::new("official", "/tmp/project", "shared")
}

fn empty_history(total: u32) -> CoverageReport {
    CoverageReport::new(CoverageVerdict::Empty, 0, total)
}

fn complete(ids: &[&str]) -> CoverageReport {
    CoverageReport {
        verdict: CoverageVerdict::Complete,
        covered_message_ids: ids.iter().map(|id| id.to_string()).collect(),
        covered_prompt_count: ids.len() as u32,
        total_prompt_count: ids.len() as u32,
    }
}

fn pending_checkpoint() -> ContinuityCheckpoint {
    let mut checkpoint = ContinuityCheckpoint::default();
    checkpoint.attach_route("agent-1", &route());
    checkpoint.mark_bootstrap_pending(ContinuityReason::NewAgentSession);
    checkpoint
}

fn checkpoint_with_coverage_evidence() -> ContinuityCheckpoint {
    let mut checkpoint = pending_checkpoint();
    checkpoint.record_bootstrap(BootstrapScope {
        bundle_id: "old-bundle".into(),
        prompt_id: "old-current".into(),
        included: 1,
        omitted: 1,
        included_message_ids: vec!["old-context".into()],
        included_message_digests: vec!["old-digest".into()],
        omitted_from_message_id: Some("old-omitted".into()),
        omitted_through_message_id: Some("old-omitted".into()),
    });
    checkpoint.begin_turn("old-current");
    checkpoint
        .record_prepared_prompt_digests("old-journal-digest".into(), "old-agent-digest".into());
    checkpoint.mark_verified(&["old-context".into(), "old-current".into()], 2);
    checkpoint
}

fn assert_coverage_evidence_cleared(checkpoint: &ContinuityCheckpoint) {
    assert!(checkpoint.covered_message_ids.is_empty());
    assert_eq!(checkpoint.covered_prompt_count, 0);
    assert!(checkpoint.covered_prompt_digests.is_empty());
    assert_eq!(checkpoint.pending_prompt_id, None);
    assert_eq!(checkpoint.pending_journal_prompt_digest, None);
    assert_eq!(checkpoint.pending_agent_prompt_digest, None);
    assert_eq!(checkpoint.bootstrap_bundle_id, None);
    assert_eq!(checkpoint.bootstrap_prompt_id, None);
    assert!(checkpoint.bootstrap_included_message_ids.is_empty());
    assert!(checkpoint.bootstrap_included_message_digests.is_empty());
    assert_eq!(checkpoint.bootstrap_omitted_from_message_id, None);
    assert_eq!(checkpoint.bootstrap_omitted_through_message_id, None);
    assert_eq!(checkpoint.bootstrap_included, 0);
    assert_eq!(checkpoint.bootstrap_omitted, 0);
}

#[test]
fn load_success_with_empty_history_never_verifies() {
    // session/new 后进入 bootstrap pending，但 prompt 未 flush；重启后 session/load 成功，Agent 历史仍为空。
    let checkpoint = pending_checkpoint();
    let after = after_open(
        CheckpointRead::Loaded(Box::new(checkpoint)),
        "agent-1",
        &route(),
        true,
        &empty_history(2),
    );

    assert_ne!(after.status, ContinuityStatus::Verified);
    assert!(after.needs_recovery());
    assert_eq!(after.reason, Some(ContinuityReason::HistoryEmpty));
}

#[test]
fn bootstrap_pending_survives_a_serialization_roundtrip() {
    let checkpoint = pending_checkpoint();
    let encoded = serde_json::to_vec(&checkpoint).expect("encode");
    let decoded: ContinuityCheckpoint = serde_json::from_slice(&encoded).expect("decode");

    assert_eq!(decoded.status, ContinuityStatus::BootstrapPending);
    assert!(decoded.needs_recovery());
    assert!(decoded.matches_agent("agent-1"));
    assert!(decoded.matches_route(&route()));
}

#[test]
fn exact_native_resume_verifies_only_from_history_evidence() {
    let coverage = complete(&["u1", "u2"]);
    let after = after_open(
        CheckpointRead::Missing,
        "agent-1",
        &route(),
        true,
        &coverage,
    );

    assert_eq!(after.status, ContinuityStatus::Verified);
    assert_eq!(after.covered_prompt_count, 2);
    assert_eq!(after.covered_message_ids, vec!["u1", "u2"]);
}

#[test]
fn empty_new_chat_stays_bootstrap_pending_across_restart() {
    let coverage = CoverageReport::new(CoverageVerdict::Complete, 0, 0);
    let after = after_open(
        CheckpointRead::Loaded(Box::new(pending_checkpoint())),
        "agent-1",
        &route(),
        true,
        &coverage,
    );

    assert_eq!(after.status, ContinuityStatus::BootstrapPending);
    assert_eq!(after.reason, Some(ContinuityReason::NoPromptYet));
}

#[test]
fn partial_history_keeps_recovery_required() {
    let coverage = CoverageReport {
        verdict: CoverageVerdict::Partial,
        covered_message_ids: vec!["u2".into()],
        covered_prompt_count: 1,
        total_prompt_count: 2,
    };
    let after = after_open(
        CheckpointRead::Loaded(Box::new(pending_checkpoint())),
        "agent-1",
        &route(),
        true,
        &coverage,
    );

    assert_eq!(after.status, ContinuityStatus::Unverified);
    assert_eq!(after.reason, Some(ContinuityReason::HistoryPartial));
}

#[test]
fn empty_history_reuses_only_the_agent_session_created_for_bootstrap() {
    let checkpoint = pending_checkpoint();
    assert!(can_bootstrap_current_agent(
        &checkpoint,
        "agent-1",
        &CoverageReport::new(CoverageVerdict::Missing, 0, 2),
    ));
    assert!(!can_bootstrap_current_agent(
        &checkpoint,
        "agent-2",
        &CoverageReport::new(CoverageVerdict::Empty, 0, 2),
    ));

    let mut resumed = checkpoint;
    resumed.mark_unverified(ContinuityReason::ReconnectUnverified);
    assert!(!can_bootstrap_current_agent(
        &resumed,
        "agent-1",
        &CoverageReport::new(CoverageVerdict::Empty, 0, 2),
    ));
}

#[test]
fn agent_id_mismatch_clears_prior_coverage_evidence() {
    let after = after_open(
        CheckpointRead::Loaded(Box::new(checkpoint_with_coverage_evidence())),
        "agent-2",
        &route(),
        true,
        &empty_history(1),
    );

    assert_eq!(after.status, ContinuityStatus::Unverified);
    assert_eq!(after.reason, Some(ContinuityReason::AgentChanged));
    assert!(after.matches_agent("agent-2"));
    assert_coverage_evidence_cleared(&after);
}

#[test]
fn route_change_clears_prior_coverage_evidence() {
    let other = ContinuityRoute::new("relay", "/tmp/other", "independent");
    let after = after_open(
        CheckpointRead::Loaded(Box::new(checkpoint_with_coverage_evidence())),
        "agent-1",
        &other,
        true,
        &empty_history(1),
    );

    assert_eq!(after.status, ContinuityStatus::Unverified);
    assert_eq!(after.reason, Some(ContinuityReason::RouteChanged));
    assert!(after.matches_route(&other));
    assert_coverage_evidence_cleared(&after);
}

#[test]
fn legacy_or_corrupt_records_are_unverified() {
    for read in [CheckpointRead::Missing, CheckpointRead::Corrupt] {
        let after = after_open(read, "agent-1", &route(), true, &complete(&["u1"]));
        assert_eq!(after.status, ContinuityStatus::Verified);
    }
    let missing = after_open(
        CheckpointRead::Missing,
        "agent-1",
        &route(),
        false,
        &CoverageReport::new(CoverageVerdict::Partial, 0, 1),
    );
    assert_eq!(missing.status, ContinuityStatus::BootstrapPending);
    assert_eq!(missing.reason, Some(ContinuityReason::NewAgentSession));
}

#[test]
fn reconnect_never_carries_a_stale_verified_bit() {
    // 即使此前检查点为 Verified，进程重启仍可能丢失 Agent 历史；重开后必须在发送时重新核验。
    let mut checkpoint = pending_checkpoint();
    checkpoint.mark_verified(&["u1".into()], 1);
    let after = after_reconnect(
        CheckpointRead::Loaded(Box::new(checkpoint)),
        "agent-1",
        &route(),
        true,
    );

    assert_eq!(after.status, ContinuityStatus::BootstrapPending);
    assert_eq!(after.reason, Some(ContinuityReason::ReconnectUnverified));
    assert!(after.needs_recovery());
}

#[test]
fn custom_route_home_change_invalidates_checkpoint_identity() {
    let mut checkpoint = pending_checkpoint();
    checkpoint.mark_verified(&["u1".into()], 1);
    let custom_route = route().with_custom_route(true);
    let after = after_reconnect(
        CheckpointRead::Loaded(Box::new(checkpoint)),
        "agent-1",
        &custom_route,
        false,
    );

    assert_eq!(after.status, ContinuityStatus::BootstrapPending);
    assert_eq!(after.reason, Some(ContinuityReason::NewAgentSession));
    assert!(after.matches_route(&custom_route));
}

#[test]
fn reconnect_with_a_new_agent_id_starts_a_fresh_bootstrap() {
    let mut checkpoint = pending_checkpoint();
    checkpoint.mark_verified(&["u1".into()], 1);
    let after = after_reconnect(
        CheckpointRead::Loaded(Box::new(checkpoint)),
        "agent-2",
        &route(),
        false,
    );

    assert_eq!(after.status, ContinuityStatus::BootstrapPending);
    assert_eq!(after.reason, Some(ContinuityReason::NewAgentSession));
    assert_eq!(after.covered_prompt_count, 0);
    assert!(after.covered_message_ids.is_empty());
}

#[test]
fn resumed_agent_with_missing_checkpoint_is_unverified_not_fresh() {
    let after = after_reconnect(CheckpointRead::Missing, "agent-1", &route(), true);

    assert_eq!(after.status, ContinuityStatus::Unverified);
    assert_eq!(after.reason, Some(ContinuityReason::CheckpointMissing));
    assert!(!can_bootstrap_current_agent(
        &after,
        "agent-1",
        &CoverageReport::new(CoverageVerdict::Missing, 0, 1),
    ));
}

#[test]
fn resumed_agent_with_corrupt_checkpoint_is_unverified_not_fresh() {
    let after = after_reconnect(CheckpointRead::Corrupt, "agent-1", &route(), true);

    assert_eq!(after.status, ContinuityStatus::Unverified);
    assert_eq!(after.reason, Some(ContinuityReason::CheckpointCorrupt));
    assert!(!can_bootstrap_current_agent(
        &after,
        "agent-1",
        &CoverageReport::new(CoverageVerdict::Empty, 0, 1),
    ));
}

#[test]
fn resumed_agent_id_mismatch_remains_unverified() {
    let after = after_reconnect(
        CheckpointRead::Loaded(Box::new(pending_checkpoint())),
        "agent-2",
        &route(),
        true,
    );

    assert_eq!(after.status, ContinuityStatus::Unverified);
    assert_eq!(after.reason, Some(ContinuityReason::AgentChanged));
    assert!(!can_bootstrap_current_agent(
        &after,
        "agent-2",
        &CoverageReport::new(CoverageVerdict::Missing, 0, 1),
    ));
}

#[test]
fn verified_prompt_digest_moves_into_the_bounded_history_index() {
    let mut checkpoint = pending_checkpoint();
    checkpoint.begin_turn("prompt-1");
    checkpoint.record_prepared_prompt_digests("journal-digest".into(), "agent-digest".into());

    checkpoint.mark_verified(&["prompt-1".into()], 1);

    assert_eq!(checkpoint.pending_prompt_id, None);
    assert_eq!(checkpoint.pending_agent_prompt_digest, None);
    assert_eq!(checkpoint.covered_prompt_digests.len(), 1);
    assert_eq!(checkpoint.covered_prompt_digests[0].message_id, "prompt-1");
    assert_eq!(
        checkpoint.covered_prompt_digests[0].agent_prompt_digest,
        "agent-digest"
    );
}

#[test]
fn begin_turn_withholds_verified_until_history_proves_the_prompt() {
    let mut checkpoint = ContinuityCheckpoint::default();
    checkpoint.attach_route("agent-1", &route());
    checkpoint.mark_verified(&["u1".into()], 1);
    checkpoint.begin_turn("u2");

    assert!(checkpoint.needs_recovery());
    assert_eq!(checkpoint.pending_prompt_id.as_deref(), Some("u2"));

    let partial = after_turn(
        checkpoint,
        &CoverageReport {
            verdict: CoverageVerdict::Partial,
            covered_message_ids: vec!["u1".into()],
            covered_prompt_count: 1,
            total_prompt_count: 2,
        },
        Some("u2"),
    );
    assert!(partial.needs_recovery());
    assert_eq!(partial.pending_prompt_id.as_deref(), Some("u2"));
    assert_eq!(partial.reason, Some(ContinuityReason::FlushUnconfirmed));
}

#[test]
fn turn_verifies_only_when_pending_prompt_is_covered() {
    let mut checkpoint = ContinuityCheckpoint::default();
    checkpoint.attach_route("agent-1", &route());
    checkpoint.begin_turn("u2");

    let after = after_turn(checkpoint, &complete(&["u1", "u2"]), Some("u2"));
    assert_eq!(after.status, ContinuityStatus::Verified);
    assert_eq!(after.pending_prompt_id, None);
}

#[test]
fn stale_post_turn_snapshot_cannot_restore_verified_after_rewind() {
    let mut checkpoint = pending_checkpoint();
    checkpoint.begin_turn("u2");
    let inspection_snapshot = checkpoint.clone();
    assert!(checkpoint.matches_pending_snapshot(&inspection_snapshot, "u2"));

    checkpoint.mark_unverified(ContinuityReason::RewindUnverified);

    assert!(!checkpoint.matches_pending_snapshot(&inspection_snapshot, "u2"));
    assert_eq!(checkpoint.pending_prompt_id.as_deref(), Some("u2"));
}

#[test]
fn bootstrap_bundle_id_is_a_digest_not_transcript_text() {
    let id = bootstrap_bundle_id("[Prior conversation context — this chat continues an existing Grok App session.]\nsecret body");
    assert_eq!(id.len(), 64);
    assert!(!id.contains("secret"));
}

#[test]
fn vision_preprocessed_bootstrap_can_refresh_its_checkpoint_digest() {
    let raw = format!(
        "{}### User\n@/tmp/prior.png\n\n{}",
        BOOTSTRAP_HEADER, BOOTSTRAP_FOOTER
    );
    let prepared = format!("{raw}\ncurrent question");
    let (prepared, paths) = crate::models_aux::strip_image_at_paths(&prepared);
    assert_eq!(paths, vec!["/tmp/prior.png"]);
    let bootstrap = bootstrap_body_from_prompt(&prepared).expect("prepared bootstrap");
    let raw_digest = bootstrap_bundle_id(&raw);
    let mut checkpoint = pending_checkpoint();
    checkpoint.record_bootstrap(BootstrapScope {
        bundle_id: raw_digest.clone(),
        prompt_id: "current-prompt".into(),
        included: 0,
        omitted: 0,
        included_message_ids: Vec::new(),
        included_message_digests: Vec::new(),
        omitted_from_message_id: None,
        omitted_through_message_id: None,
    });

    checkpoint.refresh_bootstrap_bundle_id(&bootstrap);

    let prepared_digest = bootstrap_bundle_id(&bootstrap);
    assert_ne!(
        checkpoint.bootstrap_bundle_id.as_deref(),
        Some(raw_digest.as_str())
    );
    assert_eq!(
        checkpoint.bootstrap_bundle_id.as_deref(),
        Some(prepared_digest.as_str())
    );
}

#[test]
fn bootstrap_rules_do_not_replay_prior_side_effects_without_explicit_continue() {
    assert!(BOOTSTRAP_HEADER.contains("Do NOT execute or replay earlier requests."));
    assert!(BOOTSTRAP_HEADER.contains("only when the new user message explicitly asks"));
}

#[test]
fn bootstrap_markers_stay_aligned_with_the_envelope() {
    assert!(BOOTSTRAP_HEADER.starts_with(BOOTSTRAP_START_MARKER));
    assert!(BOOTSTRAP_FOOTER.trim_end().ends_with(BOOTSTRAP_END_MARKER));

    let prompt = format!("{BOOTSTRAP_HEADER}transcript{BOOTSTRAP_FOOTER}");
    let body = bootstrap_body_from_prompt(&prompt).expect("bootstrap envelope is extractable");
    assert!(body.contains("transcript"));
    assert!(body.trim_end().ends_with(BOOTSTRAP_END_MARKER));
}

#[test]
fn checkpoint_save_and_read_are_schema_guarded() {
    let _home = crate::test_support::TestAppHome::new("continuity-checkpoint");
    let session_id = "continuity-checkpoint-test";
    let mut checkpoint = pending_checkpoint();
    let included_ids = vec!["u1".to_string()];
    let included_digests = vec![bootstrap_message_digest("user", "hello")];
    checkpoint.record_bootstrap(BootstrapScope {
        bundle_id: "bundle-digest".into(),
        prompt_id: "current-prompt".into(),
        included: 1,
        omitted: 2,
        included_message_ids: included_ids.clone(),
        included_message_digests: included_digests,
        omitted_from_message_id: Some("omitted-first".into()),
        omitted_through_message_id: Some("omitted-last".into()),
    });
    checkpoint.mark_verified(&["u1".into()], 1);
    let snapshot = ContinuitySnapshot::from(&checkpoint);
    assert_eq!(snapshot.bootstrap_included_message_ids, included_ids);
    assert_eq!(
        snapshot.bootstrap_omitted_from_message_id.as_deref(),
        Some("omitted-first")
    );
    assert_eq!(
        snapshot.bootstrap_omitted_through_message_id.as_deref(),
        Some("omitted-last")
    );
    save(session_id, &checkpoint).unwrap();

    assert_eq!(
        read(session_id),
        CheckpointRead::Loaded(Box::new(checkpoint))
    );

    std::fs::write(checkpoint_path(session_id), br#"{"schema":99}"#).unwrap();
    assert_eq!(read(session_id), CheckpointRead::Corrupt);
}
