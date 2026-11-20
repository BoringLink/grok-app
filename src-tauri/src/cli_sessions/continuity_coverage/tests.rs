use std::fs;

use chrono::Utc;
use uuid::Uuid;

use crate::store::{self, ChatMessageStored, MessageAttachmentStored};

use super::*;

struct Fixture {
    _home: crate::test_support::TestAppHome,
    session_id: String,
    agent_id: String,
    agent_dir: std::path::PathBuf,
}

fn setup(journal: &[(&str, &str)]) -> Fixture {
    let home = crate::test_support::TestAppHome::new("continuity-coverage");
    let mut settings = store::load_settings();
    settings.session_data_mode = "independent".into();
    store::save_settings(&settings).unwrap();

    let mut session = store::create_session(None, Some("coverage".into()), false).unwrap();
    let agent_id = format!("agent-{}", Uuid::new_v4());
    session.agent_session_id = Some(agent_id.clone());
    store::update_session_meta(&session).unwrap();
    let messages: Vec<ChatMessageStored> = journal
        .iter()
        .enumerate()
        .map(|(index, (role, content))| ChatMessageStored {
            id: format!("m{index}"),
            role: (*role).into(),
            content: (*content).into(),
            thought: None,
            created_at: Utc::now(),
            is_error: false,
            attachments: None,
            marker: None,
        })
        .collect();
    store::replace_messages(&session.id, &messages).unwrap();
    let agent_dir = crate::paths::agent_home_dir()
        .join("sessions")
        .join("fixture")
        .join(&agent_id);
    fs::create_dir_all(&agent_dir).unwrap();
    Fixture {
        _home: home,
        session_id: session.id,
        agent_id,
        agent_dir,
    }
}

fn set_attachments(fixture: &Fixture, message_id: &str, attachments: Vec<MessageAttachmentStored>) {
    let mut journal = store::load_messages_strict(&fixture.session_id).unwrap();
    journal
        .iter_mut()
        .find(|message| message.id == message_id)
        .unwrap()
        .attachments = Some(attachments);
    store::replace_messages(&fixture.session_id, &journal).unwrap();
}

fn path_attachment(path: &str) -> MessageAttachmentStored {
    MessageAttachmentStored {
        path: path.to_string(),
        ..Default::default()
    }
}

fn write_history(fixture: &Fixture, rows: &[(&str, &str)]) {
    let body = rows
        .iter()
        .map(|(role, content)| serde_json::json!({"type": role, "content": content}).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(fixture.agent_dir.join("chat_history.jsonl"), body).unwrap();
}

fn inspect(fixture: &Fixture) -> CoverageReport {
    inspect_agent_history_coverage(&fixture.session_id, &fixture.agent_id, None, "independent")
}

fn bootstrap_body(messages: &[(&str, &str)]) -> String {
    bootstrap_body_with_omissions(messages, 0)
}

fn bootstrap_body_with_omissions(messages: &[(&str, &str)], omitted: u32) -> String {
    let mut body = String::from(crate::continuity::BOOTSTRAP_HEADER);
    if omitted > 0 {
        body.push_str(&format!(
            "### …\n[{omitted} transcript entries omitted by the context limits]\n\n"
        ));
    }
    for (role, content) in messages {
        body.push_str(&format!("### {role}\n{content}\n\n"));
    }
    body.push_str(crate::continuity::BOOTSTRAP_FOOTER);
    body
}

fn record_bootstrap(
    fixture: &Fixture,
    body: &str,
    prompt_id: &str,
    included_count: usize,
    omitted: u32,
) -> Vec<String> {
    let journal = store::load_messages_strict(&fixture.session_id).unwrap();
    let prompt_index = journal
        .iter()
        .position(|message| message.id == prompt_id)
        .unwrap();
    let prefix = &journal[..prompt_index];
    let included: Vec<_> = prefix
        .iter()
        .filter(|message| {
            (message.role == "user" || message.role == "assistant")
                && !message.content.trim().is_empty()
        })
        .take(included_count)
        .collect();
    assert_eq!(included.len(), included_count);
    let ids: Vec<String> = included.iter().map(|message| message.id.clone()).collect();
    let digests: Vec<String> = included
        .iter()
        .map(|message| {
            crate::continuity::bootstrap_message_digest(&message.role, message.content.trim())
        })
        .collect();
    let omitted_ids: Vec<String> = prefix
        .iter()
        .filter(|message| crate::session_attach::is_bootstrap_context_message(message))
        .filter(|message| !ids.contains(&message.id))
        .map(|message| message.id.clone())
        .collect();
    assert_eq!(omitted_ids.len() as u32, omitted);
    let mut checkpoint = crate::continuity::ContinuityCheckpoint::default();
    checkpoint.record_bootstrap(crate::continuity::BootstrapScope {
        bundle_id: crate::continuity::bootstrap_bundle_id(body),
        prompt_id: prompt_id.to_string(),
        included: ids.len() as u32,
        omitted,
        included_message_ids: ids.clone(),
        included_message_digests: digests,
        omitted_from_message_id: omitted_ids.first().cloned(),
        omitted_through_message_id: omitted_ids.last().cloned(),
    });
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();
    ids
}

#[test]
fn exact_history_is_complete() {
    let fixture = setup(&[("user", "first"), ("assistant", "a1"), ("user", "second")]);
    write_history(
        &fixture,
        &[("user", "first"), ("assistant", "a1"), ("user", "second")],
    );

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 2);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1", "m2"]);
    assert_eq!(
        inspect_linked_history_coverage(&fixture.session_id).verdict,
        CoverageVerdict::Complete
    );
}

#[test]
fn attachment_only_prompt_matches_agent_history_path() {
    let fixture = setup(&[("user", "")]);
    set_attachments(&fixture, "m0", vec![path_attachment("/tmp/image.png")]);
    write_history(&fixture, &[("user", "@/tmp/image.png")]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_message_ids, vec!["m0"]);
}

#[test]
fn attachment_only_prompt_rejects_a_different_agent_path() {
    let fixture = setup(&[("user", "")]);
    set_attachments(&fixture, "m0", vec![path_attachment("/tmp/expected.png")]);
    write_history(&fixture, &[("user", "@/tmp/other.png")]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Mismatch);
    assert!(report.covered_message_ids.is_empty());
}

#[test]
fn id_only_attachment_prompt_fails_closed() {
    let fixture = setup(&[("user", "")]);
    set_attachments(
        &fixture,
        "m0",
        vec![MessageAttachmentStored {
            id: Some("attachment-id".into()),
            name: "image.png".into(),
            ..Default::default()
        }],
    );
    write_history(&fixture, &[("user", "@/tmp/image.png")]);

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Mismatch);
}

#[test]
fn text_and_attachment_prompt_requires_the_same_agent_path() {
    let fixture = setup(&[("user", "describe this image")]);
    set_attachments(&fixture, "m0", vec![path_attachment("/tmp/expected.png")]);
    write_history(&fixture, &[("user", "describe this image")]);

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Mismatch);
}

#[test]
fn text_and_attachment_prompt_rejects_a_different_agent_path() {
    let fixture = setup(&[("user", "describe this image")]);
    set_attachments(&fixture, "m0", vec![path_attachment("/tmp/expected.png")]);
    write_history(
        &fixture,
        &[("user", "describe this image\n@/tmp/other.png")],
    );

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Mismatch);
}

#[test]
fn text_and_attachment_prompt_matches_host_vision_path_evidence() {
    let fixture = setup(&[("user", "describe this image")]);
    set_attachments(&fixture, "m0", vec![path_attachment("/tmp/expected.png")]);
    write_history(
        &fixture,
        &[(
            "user",
            "describe this image\n<image_description path=\"/tmp/expected.png\">chart</image_description>",
        )],
    );

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Complete);
}

#[test]
fn text_and_attachment_prompt_matches_the_same_agent_path() {
    let fixture = setup(&[("user", "describe this image")]);
    set_attachments(&fixture, "m0", vec![path_attachment("/tmp/expected.png")]);
    write_history(
        &fixture,
        &[("user", "describe this image\n@/tmp/expected.png")],
    );

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Complete);
}

#[test]
fn recorded_agent_prompt_digest_covers_host_vision_transformations() {
    let fixture = setup(&[("user", "describe this image")]);
    set_attachments(&fixture, "m0", vec![path_attachment("/tmp/image.png")]);
    let agent_prompt =
        "describe this image\n<image_description path=\"/tmp/image.png\">chart</image_description>";
    write_history(&fixture, &[("user", agent_prompt)]);

    let journal = store::load_messages_strict(&fixture.session_id).unwrap();
    let mut checkpoint = crate::continuity::ContinuityCheckpoint::default();
    checkpoint.attach_route(
        &fixture.agent_id,
        &crate::continuity::ContinuityRoute::new("official", "/tmp", "independent"),
    );
    checkpoint.begin_turn("m0");
    checkpoint.record_prepared_prompt_digests(
        crate::continuity::journal_prompt_digest(&journal[0].content, &journal[0].attachments),
        super::agent_prompt_digest_for_content(agent_prompt),
    );
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_message_ids, vec!["m0"]);
}

#[test]
fn prompt_digest_is_ignored_after_its_app_message_changes() {
    let fixture = setup(&[("user", "original question")]);
    let original = store::load_messages_strict(&fixture.session_id).unwrap();
    let mut checkpoint = crate::continuity::ContinuityCheckpoint::default();
    checkpoint.attach_route(
        &fixture.agent_id,
        &crate::continuity::ContinuityRoute::new("official", "/tmp", "independent"),
    );
    checkpoint.begin_turn("m0");
    checkpoint.record_prepared_prompt_digests(
        crate::continuity::journal_prompt_digest(&original[0].content, &original[0].attachments),
        super::agent_prompt_digest_for_content("Host-transformed question"),
    );
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();
    write_history(&fixture, &[("user", "Host-transformed question")]);

    let mut changed = original;
    changed[0].content = "edited App question".into();
    store::replace_messages(&fixture.session_id, &changed).unwrap();

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Mismatch);
}

#[test]
fn truncated_agent_prompt_is_not_complete_coverage() {
    let fixture = setup(&[("user", "retain this entire instruction")]);
    write_history(&fixture, &[("user", "retain this")]);

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Mismatch);
}

#[test]
fn large_prompt_match_matrix_fails_closed() {
    assert!(super::prompt_match_work_exceeds_budget(1_001, 1_000));
}

#[test]
fn attached_chat_expansion_keeps_the_current_prompt_matchable() {
    let token = "11111111-1111-4111-8111-111111111111";
    let fixture = setup(&[("user", &format!("[[chat:{token}]]\nplease continue"))]);
    let expanded = format!(
        "[Attached conversation — prior ({token}). Context only.]\n\n### User\nprevious answer\n\n[End of attached conversation \"prior\".]\nplease continue"
    );
    write_history(&fixture, &[("user", &expanded)]);

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Complete);
}

#[test]
fn shared_custom_route_coverage_reads_agent_home_history() {
    let fixture = setup(&[("user", "first"), ("assistant", "answer")]);
    write_history(&fixture, &[("user", "first"), ("assistant", "answer")]);

    assert!(crate::paths::find_agent_session_dir_for_inference(
        &fixture.agent_id,
        None,
        "shared",
        false,
    )
    .is_none());
    assert_eq!(
        inspect_agent_history_coverage_for_inference(
            &fixture.session_id,
            &fixture.agent_id,
            None,
            "shared",
            true,
        )
        .verdict,
        CoverageVerdict::Complete
    );
}

#[test]
fn missing_assistant_reply_is_not_covered_by_matching_prompts() {
    let fixture = setup(&[("user", "first"), ("assistant", "visible answer")]);
    write_history(&fixture, &[("user", "first")]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Partial);
    assert_eq!(report.covered_prompt_count, 1);
    assert_eq!(report.covered_message_ids, vec!["m0"]);
}

fn add_tool_row_with_output(fixture: &Fixture, output: Option<&str>) {
    let mut content =
        "tool_step|completed|run_terminal_command|Run Command\ninput:echo safe".to_string();
    if let Some(output) = output {
        content.push('\n');
        content.push_str(crate::session_manager::TOOL_OUTPUT_SENTINEL);
        content.push('\n');
        content.push_str(output);
    }
    store::append_message(
        &fixture.session_id,
        ChatMessageStored {
            id: "tool-call-1".into(),
            role: "tool".into(),
            content,
            thought: None,
            created_at: Utc::now(),
            is_error: false,
            attachments: None,
            marker: Some("tool_step".into()),
        },
    )
    .unwrap();
}

fn add_tool_row(fixture: &Fixture) {
    add_tool_row_with_output(fixture, None);
}

#[test]
fn missing_tool_result_is_not_covered_by_prompt_and_answer_rows() {
    let fixture = setup(&[("user", "run command"), ("assistant", "running it")]);
    add_tool_row(&fixture);
    write_history(
        &fixture,
        &[("user", "run command"), ("assistant", "running it")],
    );

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Partial);
    assert_eq!(report.covered_prompt_count, 1);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1"]);
}

#[test]
fn matching_tool_result_covers_its_journal_row() {
    let fixture = setup(&[("user", "run command"), ("assistant", "running it")]);
    add_tool_row_with_output(&fixture, Some("useful output"));
    let rows = [
        serde_json::json!({"type":"user", "content":"run command"}),
        serde_json::json!({"type":"assistant", "content":"running it"}),
        serde_json::json!({"type":"tool_result", "tool_call_id":"call-1-0", "content":"exit: 0\\nuseful output"}),
    ];
    fs::write(
        fixture.agent_dir.join("chat_history.jsonl"),
        rows.iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 1);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1", "tool-call-1"]);
}

#[test]
fn matching_tool_id_with_different_result_body_is_not_coverage() {
    let fixture = setup(&[("user", "run command"), ("assistant", "running it")]);
    add_tool_row_with_output(&fixture, Some("expected output"));
    let rows = [
        serde_json::json!({"type":"user", "content":"run command"}),
        serde_json::json!({"type":"assistant", "content":"running it"}),
        serde_json::json!({"type":"tool_result", "tool_call_id":"call-1", "content":"different output"}),
    ];
    fs::write(
        fixture.agent_dir.join("chat_history.jsonl"),
        rows.iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Partial);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1"]);
}

#[test]
fn empty_or_missing_history_is_not_evidence() {
    let fixture = setup(&[("user", "first")]);
    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Missing);

    write_history(&fixture, &[("assistant", "only an answer")]);
    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Empty);
}

#[test]
fn fresh_empty_agent_and_app_journal_are_fresh() {
    let fixture = setup(&[]);
    let route = crate::continuity::ContinuityRoute::new("official", "/tmp", "independent");
    let mut checkpoint = crate::continuity::ContinuityCheckpoint::default();
    checkpoint.attach_route(&fixture.agent_id, &route);
    checkpoint.mark_bootstrap_pending(crate::continuity::ContinuityReason::NewAgentSession);
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Complete);
}

#[test]
fn resumed_agent_history_is_not_ignored_when_app_journal_is_empty() {
    let fixture = setup(&[]);
    let route = crate::continuity::ContinuityRoute::new("official", "/tmp", "independent");
    let mut checkpoint = crate::continuity::ContinuityCheckpoint::default();
    checkpoint.attach_route(&fixture.agent_id, &route);
    checkpoint.mark_bootstrap_pending(crate::continuity::ContinuityReason::ReconnectUnverified);
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();
    write_history(&fixture, &[("user", "stale agent prompt")]);

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Ambiguous);
}

#[test]
fn resumed_agent_with_empty_app_journal_requires_a_fresh_session() {
    let fixture = setup(&[]);
    let route = crate::continuity::ContinuityRoute::new("official", "/tmp", "independent");
    let mut checkpoint = crate::continuity::ContinuityCheckpoint::default();
    checkpoint.attach_route(&fixture.agent_id, &route);
    checkpoint.mark_bootstrap_pending(crate::continuity::ContinuityReason::ReconnectUnverified);
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Missing);
    write_history(&fixture, &[]);
    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Empty);
}

#[test]
fn corrupt_app_journal_is_reported_without_quarantining_or_rewriting_it() {
    let fixture = setup(&[("user", "first")]);
    let path = crate::paths::session_dir(&fixture.session_id).join("messages.json");
    fs::write(&path, b"{broken journal").unwrap();

    let report = inspect(&fixture);

    assert_eq!(report.verdict, CoverageVerdict::Corrupt);
    assert_eq!(fs::read(&path).unwrap(), b"{broken journal");
    assert!(!path.with_extension("corrupt.json").exists());
}

#[test]
fn partial_history_is_partial_not_complete() {
    let fixture = setup(&[("user", "first"), ("user", "second")]);
    write_history(&fixture, &[("user", "first")]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Partial);
    assert_eq!(report.covered_prompt_count, 1);
    assert_eq!(report.total_prompt_count, 2);
}

#[test]
fn duplicate_prompts_match_in_order_but_extra_agent_prompt_is_unverified() {
    let fixture = setup(&[("user", "same"), ("user", "same")]);
    write_history(&fixture, &[("user", "same")]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Partial);
    assert_eq!(report.covered_prompt_count, 1);

    write_history(
        &fixture,
        &[("user", "same"), ("user", "same"), ("user", "same")],
    );
    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Partial);
    assert_eq!(report.covered_prompt_count, 2);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1"]);
}

#[test]
fn corrupt_or_truncated_jsonl_is_not_evidence() {
    let fixture = setup(&[("user", "first")]);
    fs::write(
        fixture.agent_dir.join("chat_history.jsonl"),
        "{\"type\":\"user\",\"content\":\"first\"}\n{\"type\":\"assistant\"",
    )
    .unwrap();

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Corrupt);
}

#[test]
fn agent_rows_that_match_no_prompt_are_a_mismatch() {
    let fixture = setup(&[("user", "intended")]);
    write_history(&fixture, &[("user", "something else")]);

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Mismatch);
}

#[test]
fn bootstrap_prefixed_prompt_counts_as_covered() {
    let fixture = setup(&[
        ("user", "prior question"),
        ("assistant", "prior answer"),
        ("user", "current question"),
    ]);
    let body = bootstrap_body(&[("User", "prior question"), ("Assistant", "prior answer")]);
    record_bootstrap(&fixture, &body, "m2", 2, 0);
    let prompt = format!("{body}\ncurrent question");
    write_history(&fixture, &[("user", &prompt)]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 2);
    assert_eq!(report.total_prompt_count, 2);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1", "m2"]);
}

#[test]
fn bootstrap_matches_attachment_only_prompt_after_its_footer() {
    let fixture = setup(&[
        ("user", "prior question"),
        ("assistant", "prior answer"),
        ("user", ""),
    ]);
    set_attachments(&fixture, "m2", vec![path_attachment("/tmp/current.png")]);
    let body = bootstrap_body(&[("User", "prior question"), ("Assistant", "prior answer")]);
    record_bootstrap(&fixture, &body, "m2", 2, 0);
    let prompt = format!("{body}\n@/tmp/current.png");
    write_history(&fixture, &[("user", &prompt)]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 2);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1", "m2"]);
}

#[test]
fn bootstrap_matches_attachment_only_next_user_row() {
    let fixture = setup(&[("user", "prior question"), ("user", "")]);
    set_attachments(&fixture, "m1", vec![path_attachment("/tmp/current.png")]);
    let body = bootstrap_body(&[("User", "prior question")]);
    record_bootstrap(&fixture, &body, "m1", 1, 0);
    write_history(&fixture, &[("user", &body), ("user", "@/tmp/current.png")]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 2);
}

#[test]
fn bootstrap_does_not_reuse_a_prior_attachment_path_as_the_current_prompt() {
    let fixture = setup(&[("user", "@/tmp/reused.png"), ("user", "")]);
    set_attachments(&fixture, "m1", vec![path_attachment("/tmp/reused.png")]);
    let body = bootstrap_body(&[("User", "@/tmp/reused.png")]);
    record_bootstrap(&fixture, &body, "m1", 1, 0);
    write_history(&fixture, &[("user", &body)]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Ambiguous);
    assert_eq!(report.covered_prompt_count, 0);
}

#[test]
fn bootstrap_scope_starts_at_the_appended_prompt() {
    let fixture = setup(&[
        ("user", "old one"),
        ("user", "old two"),
        ("user", "current"),
        ("assistant", "answer"),
        ("user", "next"),
    ]);
    let body = bootstrap_body(&[("User", "old one"), ("User", "old two")]);
    record_bootstrap(&fixture, &body, "m2", 2, 0);
    let prompt = format!("{body}\ncurrent");
    write_history(
        &fixture,
        &[("user", &prompt), ("assistant", "answer"), ("user", "next")],
    );

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 4, "included + current + next");
    assert_eq!(report.total_prompt_count, 4);
    assert_eq!(
        report.covered_message_ids,
        vec!["m0", "m1", "m2", "m3", "m4"]
    );
}

#[test]
fn bootstrap_row_without_the_appended_prompt_is_unverified() {
    let fixture = setup(&[("user", "old"), ("user", "current")]);
    let body = bootstrap_body(&[("User", "old")]);
    record_bootstrap(&fixture, &body, "m1", 1, 0);
    write_history(&fixture, &[("user", &body)]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Ambiguous);
    assert_eq!(report.covered_prompt_count, 0);
}

#[test]
fn bootstrap_body_must_match_checkpoint_and_current_app_messages() {
    let fixture = setup(&[("user", "old"), ("user", "current")]);
    let body = bootstrap_body(&[("User", "old")]);
    record_bootstrap(&fixture, &body, "m1", 1, 0);

    let tampered = format!("{}\ncurrent", body.replace("old", "changed"));
    write_history(&fixture, &[("user", &tampered)]);
    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Ambiguous);

    let mut journal = store::load_messages_strict(&fixture.session_id).unwrap();
    journal[0].content = "edited old message".into();
    store::replace_messages(&fixture.session_id, &journal).unwrap();
    let original = format!("{body}\ncurrent");
    write_history(&fixture, &[("user", &original)]);
    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Ambiguous);
}

#[test]
fn rewind_fence_excludes_abandoned_prompts() {
    let fixture = setup(&[("user", "kept")]);
    write_history(&fixture, &[("user", "kept"), ("user", "removed")]);
    let fence = crate::cli_sessions::rewind_fence::RewindFence::capture(&fixture.session_id, 1);
    let kept = store::load_messages(&fixture.session_id);
    fence.replace_journal(&fixture.session_id, &kept).unwrap();
    // 成功的原生 rewind 也会截断 Agent 历史。
    write_history(&fixture, &[("user", "kept")]);

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Complete);
}

#[test]
fn bootstrap_omission_scope_tracks_tool_rows_and_rejects_stale_ranges() {
    let fixture = setup(&[
        ("user", "prior"),
        ("tool", "tool_step|completed|read_file|Read"),
        ("user", "current"),
    ]);
    let body = bootstrap_body_with_omissions(&[("User", "prior")], 1);
    assert_eq!(record_bootstrap(&fixture, &body, "m2", 1, 1), vec!["m0"]);
    let prompt = format!("{body}\ncurrent");
    write_history(&fixture, &[("user", &prompt)]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 2);
    assert_eq!(report.total_prompt_count, 2);
    assert_eq!(report.covered_message_ids, vec!["m0", "m2"]);

    let mut checkpoint = match crate::continuity::read(&fixture.session_id) {
        crate::continuity::CheckpointRead::Loaded(checkpoint) => *checkpoint,
        other => panic!("expected bootstrap checkpoint, got {other:?}"),
    };
    checkpoint.bootstrap_omitted_from_message_id = Some("m0".into());
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();
    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Ambiguous);
}

#[test]
fn bootstrap_epoch_is_not_blocked_by_an_old_fence() {
    let fixture = setup(&[("user", "first"), ("user", "same")]);
    write_history(
        &fixture,
        &[("user", "first"), ("user", "same"), ("user", "same")],
    );
    let fence = crate::cli_sessions::rewind_fence::RewindFence::capture(&fixture.session_id, 2);
    let kept = store::load_messages(&fixture.session_id);
    fence.replace_journal(&fixture.session_id, &kept).unwrap();
    // 新 Agent 的 bootstrap 在旧 fence 之后建立可信历史区间。
    let body = bootstrap_body(&[("User", "first")]);
    record_bootstrap(&fixture, &body, "m1", 1, 0);
    let prompt = format!("{body}\nsame");
    write_history(&fixture, &[("user", &prompt)]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_prompt_count, 2);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1"]);
}

#[test]
fn failed_rewind_left_in_agent_history_is_not_complete() {
    let fixture = setup(&[("user", "kept")]);
    write_history(&fixture, &[("user", "kept"), ("user", "removed")]);
    let fence = crate::cli_sessions::rewind_fence::RewindFence::capture(&fixture.session_id, 1);
    let kept = store::load_messages(&fixture.session_id);
    fence.replace_journal(&fixture.session_id, &kept).unwrap();

    // Agent rewind 失败后，被丢弃的回合仍留在模型上下文中。
    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Partial);
    assert_eq!(report.covered_prompt_count, 1);
}

#[test]
fn standalone_bootstrap_row_bounds_individual_coverage() {
    let fixture = setup(&[
        ("user", "old one"),
        ("user", "old two"),
        ("user", "current"),
    ]);
    let body = bootstrap_body(&[("User", "old one"), ("User", "old two")]);
    record_bootstrap(&fixture, &body, "m2", 2, 0);
    write_history(&fixture, &[("user", &body), ("user", "current")]);

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1", "m2"]);
    assert_eq!(report.covered_prompt_count, 3);
    assert_eq!(report.total_prompt_count, 3);
}

#[test]
fn corrupt_rewind_fence_trusts_only_the_bootstrap_suffix() {
    let fixture = setup(&[("user", "old"), ("user", "current")]);
    let body = bootstrap_body(&[("User", "old")]);
    record_bootstrap(&fixture, &body, "m1", 1, 0);
    let prompt = format!("{body}\ncurrent");
    write_history(&fixture, &[("user", &prompt)]);
    fs::write(
        crate::paths::session_dir(&fixture.session_id).join("rewind_reconcile_fence.json"),
        br#"{"block_all":true}"#,
    )
    .unwrap();

    let report = inspect(&fixture);
    assert_eq!(report.verdict, CoverageVerdict::Complete);
    assert_eq!(report.covered_message_ids, vec!["m0", "m1"]);
}

#[test]
fn oversized_history_fails_closed() {
    let fixture = setup(&[("user", "first")]);
    let path = fixture.agent_dir.join("chat_history.jsonl");
    let file = fs::File::create(&path).unwrap();
    file.set_len(MAX_HISTORY_BYTES + 1).unwrap();

    assert_eq!(inspect(&fixture).verdict, CoverageVerdict::Ambiguous);
}

#[test]
fn restart_after_unflushed_bootstrap_prompt_requires_recovery() {
    // session/new 进入 bootstrap pending 并 dispatch 首个 prompt，但 CLI 未 flush；重启后 session/load 只恢复了更早的 prompt。
    let fixture = setup(&[("user", "prior question"), ("user", "new question")]);
    write_history(&fixture, &[("user", "prior question")]);

    let route = crate::continuity::ContinuityRoute::new("official", "/tmp/project", "independent");
    let mut checkpoint = crate::continuity::ContinuityCheckpoint {
        agent_session_id: Some(fixture.agent_id.clone()),
        route_id: Some(route.route_id.clone()),
        cwd: Some(route.cwd.clone()),
        session_data_mode: Some(route.session_data_mode.clone()),
        ..crate::continuity::ContinuityCheckpoint::default()
    };
    checkpoint.mark_bootstrap_pending(crate::continuity::ContinuityReason::NewAgentSession);
    checkpoint.pending_prompt_id = Some("m1".into());
    crate::continuity::save(&fixture.session_id, &checkpoint).unwrap();

    // 模拟重启：读取持久化检查点，再让 session/load 返回成功。
    let previous = crate::continuity::read(&fixture.session_id);
    let coverage = inspect(&fixture);
    let after = crate::continuity::after_open(previous, &fixture.agent_id, &route, true, &coverage);

    assert_eq!(coverage.verdict, CoverageVerdict::Partial);
    assert_ne!(after.status, crate::continuity::ContinuityStatus::Verified);
    assert!(after.needs_recovery());
    assert_eq!(
        after.pending_prompt_id.as_deref(),
        Some("m1"),
        "the unflushed turn must stay marked until history proves it"
    );
}
