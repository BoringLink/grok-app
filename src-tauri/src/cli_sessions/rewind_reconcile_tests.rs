use super::*;

fn reconcile_test_message(id: &str, role: &str, content: &str) -> ChatMessageStored {
    ChatMessageStored {
        id: id.into(),
        role: role.into(),
        content: content.into(),
        thought: None,
        created_at: Utc::now(),
        is_error: false,
        attachments: None,
        marker: None,
    }
}

fn reconcile_test_rows(rows: &[(&str, &str)]) -> Vec<(String, String, Option<String>)> {
    rows.iter()
        .map(|(role, body)| (role.to_string(), body.to_string(), None))
        .collect()
}

fn reconcile_test_interjection(id: &str, content: &str) -> ChatMessageStored {
    ChatMessageStored {
        marker: Some("interjection".into()),
        ..reconcile_test_message(id, "user", content)
    }
}

/// Host opened a post-interjection assistant row but only the thought reached
/// the journal (the body chunk was lost).
fn reconcile_test_thought_placeholder(id: &str, thought: &str) -> ChatMessageStored {
    ChatMessageStored {
        thought: Some(thought.into()),
        ..reconcile_test_message(id, "assistant", "")
    }
}

fn reconcile_test_bodies(journal: &[ChatMessageStored]) -> Vec<&str> {
    journal.iter().map(|m| m.content.as_str()).collect()
}

#[test]
fn reconcile_disk_history_after_rewind_preserves_new_answer() {
    reconcile_disk_rewind_scenario(false, false);
}

#[test]
fn reconcile_disk_rewind_same_prompt_blocks_old_answer_and_tools_after_restart() {
    reconcile_disk_rewind_scenario(true, false);
}

#[test]
fn reconcile_disk_rewind_corrupt_history_fails_closed() {
    reconcile_disk_rewind_scenario(true, true);
}

fn reconcile_disk_rewind_scenario(same_prompt: bool, corrupt_history: bool) {
    let _home = crate::test_support::TestAppHome::new("rewind-reconcile");
    let agent_id = "rewind-reconcile-disk";
    let dir = crate::paths::agent_home_dir()
        .join("sessions")
        .join("rewind-fixture")
        .join(agent_id);
    fs::create_dir_all(&dir).unwrap();
    let mut session = store::create_session(None, Some("rewind regression".into()), false).unwrap();
    session.agent_session_id = Some(agent_id.into());
    store::update_session_meta(&session).unwrap();
    let mut settings = store::load_settings();
    settings.session_data_mode = "independent".into();
    store::save_settings(&settings).unwrap();
    let old = vec![
        reconcile_test_message("u1", "user", "keep"),
        reconcile_test_message("a1", "assistant", "kept answer"),
        reconcile_test_message("u2", "user", "removed"),
        reconcile_test_message("a2", "assistant", "obsolete answer"),
    ];
    let stale_history = old.iter()
        .map(|m| serde_json::json!({"type":m.role,"content":m.content}).to_string())
        .chain(std::iter::once(serde_json::json!({"type":"tool_result","content":"old tool output","tool_call_id":"old-tool"}).to_string()))
        .collect::<Vec<_>>().join("\n");
    fs::write(
        dir.join("chat_history.jsonl"),
        if corrupt_history {
            "invalid json"
        } else {
            &stale_history
        },
    )
    .unwrap();
    store::replace_messages(&session.id, &old).unwrap();
    let kept = store::truncate_through_user_prompt(&old, 0).unwrap();
    let fence = rewind_fence::RewindFence::capture(&session.id, 1);
    fence.replace_journal(&session.id, &kept).unwrap();
    // Repeated rewind unions the same exclusions and remains idempotent.
    rewind_fence::RewindFence::capture(&session.id, 1)
        .replace_journal(&session.id, &kept)
        .unwrap();
    store::append_message(
        &session.id,
        reconcile_test_message(
            "new-u",
            "user",
            if same_prompt {
                "removed"
            } else {
                "replacement"
            },
        ),
    )
    .unwrap();
    store::append_message(
        &session.id,
        reconcile_test_message("new-a", "assistant", "fresh answer"),
    )
    .unwrap();
    // Disk flush becomes valid again after capture; fence is loaded fresh
    // from disk by reconcile, as it would be after an App restart.
    fs::write(dir.join("chat_history.jsonl"), stale_history).unwrap();
    assert_eq!(
        reconcile_journal_from_chat_history(&session.id, agent_id, None, "independent").unwrap(),
        0
    );
    let after = store::load_messages(&session.id);
    assert_eq!(after.len(), 4);
    assert_eq!(after[3].content, "fresh answer");
    if !same_prompt && !corrupt_history {
        // A genuinely new branch still gets missing-answer recovery.
        store::replace_messages(&session.id, &after[..3]).unwrap();
        fs::write(dir.join("chat_history.jsonl"),
            "{\"type\":\"user\",\"content\":\"keep\"}\n{\"type\":\"assistant\",\"content\":\"kept answer\"}\n{\"type\":\"user\",\"content\":\"replacement\"}\n{\"type\":\"assistant\",\"content\":\"recovered fresh answer\"}\n"
        ).unwrap();
        assert_eq!(
            reconcile_journal_from_chat_history(&session.id, agent_id, None, "independent")
                .unwrap(),
            1
        );
        assert_eq!(
            store::load_messages(&session.id)[3].content,
            "recovered fresh answer"
        );
    }
}

#[test]
fn reconcile_rejects_cut_turn_even_after_new_prompt_restores_user_count() {
    let mut journal = vec![
        reconcile_test_message("u1", "user", "keep"),
        reconcile_test_message("a1", "assistant", "kept answer"),
        reconcile_test_message("u-new", "user", "replacement"),
        reconcile_test_message("a-new", "assistant", "new answer"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "keep"),
        ("assistant", "kept answer"),
        ("user", "removed"),
        ("assistant", "obsolete answer"),
    ]);
    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        0
    );
    assert_eq!(journal.len(), 4);
    assert_eq!(journal[3].content, "new answer");
}

#[test]
fn reconcile_does_not_match_old_prompt_as_prefix_of_replacement() {
    let mut journal = vec![reconcile_test_message("new", "user", "do more")];
    let rows = reconcile_test_rows(&[("user", "do"), ("assistant", "obsolete")]);
    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        0
    );
    assert_eq!(journal.len(), 1);
}

#[test]
fn reconcile_inserts_answer_in_its_turn_and_does_not_extend_another_turn() {
    let mut journal = vec![
        reconcile_test_message("u1", "user", "first"),
        reconcile_test_message("a1", "assistant", "same"),
        reconcile_test_message("u2", "user", "second"),
        reconcile_test_message("u3", "user", "third"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "first"),
        ("assistant", "same"),
        ("user", "second"),
        ("assistant", "same extended"),
        ("user", "third"),
        ("assistant", "same"),
    ]);
    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        2
    );
    assert_eq!(
        journal
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "same", "second", "same extended", "third", "same"]
    );
    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        0
    );
}

#[test]
fn reconcile_accepts_bootstrapped_suffix_and_skips_stale_branch_tools() {
    let mut journal = vec![
        reconcile_test_message("u1", "user", "older bootstrap context"),
        reconcile_test_message("u2", "user", "current"),
    ];
    let mut rows = reconcile_test_rows(&[("user", "removed"), ("assistant", "stale")]);
    rows.push((
        "tool".into(),
        "stale output".into(),
        Some("stale-call".into()),
    ));
    rows.extend(reconcile_test_rows(&[
        ("user", "current"),
        ("assistant", "fresh"),
    ]));
    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(journal.len(), 3);
    assert_eq!(journal[2].content, "fresh");
}

#[test]
fn reconcile_keeps_interjection_answer_under_the_surrounding_prompt() {
    // Mid-turn steer: the App journal holds the prompt, its first fragment, and
    // the interjection row; the agent's history holds the same rows plus the
    // answer tail that never reached the Host stream buffer.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_message("a1", "assistant", "part one"),
        reconcile_test_interjection("i1", "also check logs"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "part one"),
        ("user", "also check logs"),
        ("assistant", "part two"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(
        reconcile_test_bodies(&journal),
        vec!["question", "part one", "also check logs", "part two"]
    );
    assert_eq!(
        journal[2].marker.as_deref(),
        Some("interjection"),
        "interjection row must stay a non-prompt journal row"
    );
}

#[test]
fn reconcile_interjection_does_not_consume_a_prompt_slot() {
    let mut journal = vec![
        reconcile_test_message("u1", "user", "first"),
        reconcile_test_message("a1", "assistant", "first answer"),
        reconcile_test_interjection("i1", "steer"),
        reconcile_test_message("u2", "user", "second"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "first"),
        ("assistant", "first answer"),
        ("user", "steer"),
        ("assistant", "steered answer"),
        ("user", "second"),
        ("assistant", "second answer"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        2
    );
    assert_eq!(
        reconcile_test_bodies(&journal),
        vec![
            "first",
            "first answer",
            "steer",
            "steered answer",
            "second",
            "second answer",
        ]
    );
}

#[test]
fn reconcile_places_post_interjection_tool_rows_in_stream_order() {
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_message("a1", "assistant", "part one"),
        reconcile_test_interjection("i1", "steer"),
    ];
    let mut rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "part one"),
        ("user", "steer"),
    ]);
    rows.push(("tool".into(), "exit: 0".into(), Some("call-1".into())));
    rows.push(("assistant".into(), "part two".into(), None));

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        2
    );
    let roles: Vec<(&str, &str)> = journal
        .iter()
        .map(|m| (m.role.as_str(), m.content.as_str()))
        .collect();
    assert_eq!(roles[0], ("user", "question"));
    assert_eq!(roles[1], ("assistant", "part one"));
    assert_eq!(roles[2], ("user", "steer"));
    assert_eq!(roles[3].0, "tool");
    assert!(roles[3].1.starts_with("tool_step|"));
    assert_eq!(roles[4], ("assistant", "part two"));
}

#[test]
fn reconcile_fills_thought_only_placeholder_after_interjection() {
    // Live race: the Host opened the post-steer assistant row and only the
    // thought reached the journal. The agent history still has the body; fill
    // that row (keep id + thought) instead of adding a second bubble.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_message("a1", "assistant", "part one"),
        reconcile_test_interjection("i1", "steer"),
        reconcile_test_thought_placeholder("a2", "considering the steer"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "part one"),
        ("user", "steer"),
        ("assistant", "part two"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(
        journal.len(),
        4,
        "placeholder must absorb the body; no duplicate assistant row"
    );
    assert_eq!(journal[3].id, "a2");
    assert_eq!(journal[3].content, "part two");
    assert_eq!(
        journal[3].thought.as_deref(),
        Some("considering the steer"),
        "placeholder thought must survive the backfill"
    );
    assert_eq!(journal[1].content, "part one");
}

#[test]
fn reconcile_does_not_fill_thought_placeholder_before_the_interjection() {
    // A pre-steer placeholder is not the post-steer answer row: keep the
    // existing insert path rather than attaching the body to it.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_thought_placeholder("a1", "pre-steer thought"),
        reconcile_test_interjection("i1", "steer"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("user", "steer"),
        ("assistant", "part two"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(journal[1].content, "");
    assert_eq!(journal[1].thought.as_deref(), Some("pre-steer thought"));
    assert_eq!(journal.len(), 4);
    assert_eq!(journal[3].content, "part two");
}

#[test]
fn reconcile_does_not_fill_thought_placeholder_without_an_interjection() {
    // The same turn shape without an interjection keeps the old behavior: the
    // placeholder is not silently claimed, and the answer is inserted.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_message("a1", "assistant", "part one"),
        reconcile_test_thought_placeholder("a2", "still thinking"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "part one"),
        ("assistant", "part two"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(journal[2].content, "");
    assert_eq!(journal.len(), 4);
    assert_eq!(journal[3].content, "part two");
}

#[test]
fn reconcile_ignores_interjections_from_another_turn() {
    // `steer one` belongs to the first prompt; after the second prompt is
    // matched it must not keep that prompt active and pull foreign text in.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "first"),
        reconcile_test_interjection("i1", "steer one"),
        reconcile_test_message("a1", "assistant", "first answer"),
        reconcile_test_message("u2", "user", "second"),
        reconcile_test_message("a2", "assistant", "second answer"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "first"),
        ("assistant", "first answer"),
        ("user", "second"),
        ("assistant", "second answer"),
        ("user", "steer one"),
        ("assistant", "must not land anywhere"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        0
    );
    assert_eq!(journal.len(), 5);
}

#[test]
fn reconcile_imports_answer_when_agent_log_omits_the_interjection_row() {
    // Some CLI builds steer without writing a user row; the plain user → user
    // walk must keep working when only the interjection journal row exists.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_interjection("i1", "steer"),
        reconcile_test_message("u2", "user", "next question"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "answer one"),
        ("user", "next question"),
        ("assistant", "answer two"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        2
    );
    assert_eq!(
        reconcile_test_bodies(&journal),
        vec![
            "question",
            "steer",
            "answer one",
            "next question",
            "answer two"
        ]
    );
}

#[test]
fn reconcile_does_not_let_a_new_prompt_reconsume_an_interjection_prefix() {
    // The journal interjection `yes` and the real follow-up prompt
    // `yes, and revert` share a prefix. Prefix matching made the prompt look
    // like a second interjection, so its answer stayed in the first turn.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "start"),
        reconcile_test_message("a1", "assistant", "part one"),
        reconcile_test_interjection("i1", "yes"),
        reconcile_test_message("u2", "user", "yes, and revert"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "start"),
        ("assistant", "part one"),
        ("user", "yes"),
        ("assistant", "steered answer"),
        ("user", "yes, and revert"),
        ("assistant", "final answer"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        2
    );
    assert_eq!(
        reconcile_test_bodies(&journal),
        vec![
            "start",
            "part one",
            "yes",
            "steered answer",
            "yes, and revert",
            "final answer",
        ]
    );
    assert_eq!(journal[5].content, "final answer");
}

#[test]
fn reconcile_matches_interjection_body_after_stripping_attachment_lines() {
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_interjection("i1", "see this\n@/Users/me/shot.png"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("user", "see this"),
        ("assistant", "describes the screenshot"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(
        reconcile_test_bodies(&journal),
        vec![
            "question",
            "see this\n@/Users/me/shot.png",
            "describes the screenshot"
        ]
    );
}

#[test]
fn reconcile_assigns_identical_interjections_to_their_own_rows() {
    // Two same-text steers in one turn: each history user row must claim its
    // own marker so the answer and tool rows stay in stream order.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_message("a1", "assistant", "part one"),
        reconcile_test_interjection("i1", "retry"),
        reconcile_test_thought_placeholder("a2", "first thought"),
        reconcile_test_interjection("i2", "retry"),
        reconcile_test_thought_placeholder("a3", "second thought"),
    ];
    let mut rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "part one"),
        ("user", "retry"),
        ("assistant", "answer one"),
        ("user", "retry"),
    ]);
    rows.push(("tool".into(), "exit: 0".into(), Some("call-1".into())));
    rows.push(("assistant".into(), "answer two".into(), None));

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        3
    );
    let roles: Vec<(&str, &str)> = journal
        .iter()
        .map(|m| (m.role.as_str(), m.content.as_str()))
        .collect();
    assert_eq!(roles[0], ("user", "question"));
    assert_eq!(roles[1], ("assistant", "part one"));
    assert_eq!(roles[2], ("user", "retry"));
    assert_eq!(roles[3], ("assistant", "answer one"));
    assert_eq!(roles[4], ("user", "retry"));
    assert_eq!(roles[5].0, "tool");
    assert!(roles[5].1.starts_with("tool_step|"));
    assert_eq!(roles[6], ("assistant", "answer two"));
    assert_eq!(journal[3].id, "a2");
    assert_eq!(journal[3].thought.as_deref(), Some("first thought"));
    assert_eq!(journal[6].id, "a3");
    assert_eq!(journal[6].thought.as_deref(), Some("second thought"));
}

#[test]
fn reconcile_fills_thought_placeholder_when_history_omits_the_interjection_row() {
    // Some CLI builds steer without logging the steer's user row: the plain
    // prompt match leaves no marker behind, but the post-steer placeholder
    // still has to take the body instead of a duplicate bubble.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_message("a1", "assistant", "part one"),
        reconcile_test_interjection("i1", "steer"),
        reconcile_test_thought_placeholder("a2", "considering the steer"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "part one"),
        ("assistant", "part two"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(journal.len(), 4);
    assert_eq!(journal[3].id, "a2");
    assert_eq!(journal[3].content, "part two");
    assert_eq!(journal[3].thought.as_deref(), Some("considering the steer"));
}

#[test]
fn reconcile_omitted_interjection_fill_stays_inside_its_turn() {
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_interjection("i1", "steer"),
        reconcile_test_thought_placeholder("a1", "a thought"),
        reconcile_test_message("u2", "user", "next"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("user", "next"),
        ("assistant", "next answer"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(
        reconcile_test_bodies(&journal),
        vec!["question", "steer", "", "next", "next answer"]
    );
    assert_eq!(journal[2].thought.as_deref(), Some("a thought"));
}

#[test]
fn reconcile_omitted_interjection_keeps_a_pre_steer_placeholder_empty() {
    // The pending reply precedes the steer: never jump a pre-steer placeholder
    // to reach the post-steer row.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_thought_placeholder("a1", "pre-steer thought"),
        reconcile_test_interjection("i1", "steer"),
        reconcile_test_thought_placeholder("a2", "post-steer thought"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "part two"),
        ("user", "next"),
        ("assistant", "next answer"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        1
    );
    assert_eq!(journal[1].content, "");
    assert_eq!(journal[1].thought.as_deref(), Some("pre-steer thought"));
    assert_eq!(journal[3].content, "");
    assert_eq!(journal[3].thought.as_deref(), Some("post-steer thought"));
    assert_eq!(journal[4].content, "part two");
}

#[test]
fn reconcile_unmatched_user_row_still_clears_the_prompt_anchor() {
    // Anything that is not this turn's interjection keeps the conservative
    // reset: a stray prompt must not adopt the previous turn's answer.
    let mut journal = vec![
        reconcile_test_message("u1", "user", "question"),
        reconcile_test_message("a1", "assistant", "answer one"),
    ];
    let rows = reconcile_test_rows(&[
        ("user", "question"),
        ("assistant", "answer one"),
        ("user", "unknown prompt"),
        ("assistant", "foreign answer"),
    ]);

    assert_eq!(
        reconcile_history_rows(
            &mut journal,
            &rows,
            &HashMap::new(),
            &rewind_fence::RewindFence::default()
        ),
        0
    );
    assert_eq!(journal.len(), 2);
}
