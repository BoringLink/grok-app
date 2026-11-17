#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerPrefsResolution {
    #[serde(flatten)]
    pub prefs: store::ComposerPrefs,
    pub session_model_id: Option<String>,
}

fn composer_prefs_resolution(
    prefs: store::ComposerPrefs,
    session_id: Option<&str>,
) -> ComposerPrefsResolution {
    let session_model_id = session_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .and_then(|id| {
            store::load_sessions_index()
                .into_iter()
                .find(|session| session.id == id)
                .and_then(|session| session.model_id)
        })
        .filter(|model_id| !model_id.trim().is_empty());
    ComposerPrefsResolution {
        prefs,
        session_model_id,
    }
}

#[tauri::command]
pub async fn composer_prefs_resolve(
    project_id: Option<String>,
    session_id: Option<String>,
) -> Result<ComposerPrefsResolution, String> {
    Ok(composer_prefs_resolution(
        store::resolve_composer_prefs(project_id.as_deref(), session_id.as_deref()),
        session_id.as_deref(),
    ))
}

fn should_apply_live_composer_preferences(
    target_session_id: Option<&str>,
    live_session_id: Option<&str>,
) -> bool {
    target_session_id.is_some() && target_session_id == live_session_id
}

fn composer_prefs_is_draft_write(
    explicit_session_id: Option<&str>,
    effort: Option<&str>,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    mode: Option<&str>,
    permission_policy: Option<&str>,
) -> bool {
    explicit_session_id.is_none()
        && (effort.is_some()
            || (provider_id.is_some() && model_id.is_some())
            || mode.is_some()
            || permission_policy.is_some())
}

fn composer_prefs_project_target(
    explicit_project: Option<String>,
    target_session: Option<&str>,
    target_session_project: Option<String>,
    live_project: Option<String>,
    draft_write: bool,
) -> Result<Option<String>, String> {
    if draft_write {
        return Ok(explicit_project);
    }
    if target_session.is_some() {
        if explicit_project
            .as_deref()
            .is_some_and(|project| target_session_project.as_deref() != Some(project))
        {
            return Err("composer prefs project does not match session".into());
        }
        return Ok(target_session_project);
    }
    Ok(explicit_project.or(live_project))
}

fn composer_prefs_session_target(
    explicit_session: Option<String>,
    live_session: Option<String>,
    effort: Option<&str>,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    mode: Option<&str>,
    permission_policy: Option<&str>,
) -> Option<String> {
    if composer_prefs_is_draft_write(
        explicit_session.as_deref(),
        effort,
        provider_id,
        model_id,
        mode,
        permission_policy,
    ) {
        return explicit_session;
    }
    explicit_session.or(live_session)
}

fn composer_effort_validation_model(
    picked_model: Option<&str>,
    stored_provider: Option<&str>,
    resolved_provider: &str,
    stored_model: &str,
    session_model_is_stored: bool,
) -> String {
    picked_model.map(str::to_string).unwrap_or_else(|| {
        crate::providers::session_composer_model_id_for_route(
            stored_provider,
            resolved_provider,
            stored_model,
            session_model_is_stored,
        )
    })
}

fn composer_effort_validation_provider<'a>(
    route_changed: bool,
    picked_provider: Option<&'a str>,
    previous_route: &'a str,
) -> &'a str {
    if route_changed {
        picked_provider.unwrap_or(crate::providers::SESSION_PROVIDER_OFFICIAL)
    } else {
        picked_provider.unwrap_or(previous_route)
    }
}

/// 按配置的记忆范围保存 Composer 偏好，并仅应用到对应的 live session。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn composer_prefs_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    project_id: Option<String>,
    session_id: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    mode: Option<String>,
    permission_policy: Option<String>,
    provider_id: Option<String>,
) -> Result<ComposerPrefsResolution, String> {
    // Prefer explicit ids; fall back to live session context.
    let (live_proj, live_sess) = mgr.current_context_ids();
    let live_session_for_apply = live_sess.clone();
    let draft_write = composer_prefs_is_draft_write(
        session_id.as_deref(),
        effort.as_deref(),
        provider_id.as_deref(),
        model_id.as_deref(),
        mode.as_deref(),
        permission_policy.as_deref(),
    );
    let target_session = composer_prefs_session_target(
        session_id,
        live_sess,
        effort.as_deref(),
        provider_id.as_deref(),
        model_id.as_deref(),
        mode.as_deref(),
        permission_policy.as_deref(),
    );
    let target_session_project = target_session.as_deref().and_then(|sid| {
        store::load_sessions_index()
            .into_iter()
            .find(|session| session.id == sid)
            .and_then(|session| session.project_id)
    });
    let project_id = composer_prefs_project_target(
        project_id,
        target_session.as_deref(),
        target_session_project,
        live_proj,
        draft_write,
    )?;
    // Draft writes must not inherit either live id; their route is saved on materialization.
    let session_id = target_session;
    let apply_to_live_session = should_apply_live_composer_preferences(
        session_id.as_deref(),
        live_session_for_apply.as_deref(),
    );
    let previous_prefs = store::resolve_composer_prefs(project_id.as_deref(), session_id.as_deref());
    let (previous_provider, ssh, previous_session_model_is_stored) =
        session_provider_and_ssh(session_id.as_deref(), project_id.as_deref());
    let previous_route_provider = if ssh {
        Some(crate::providers::SESSION_PROVIDER_OFFICIAL)
    } else {
        previous_provider.as_deref()
    };
    let previous_route = crate::providers::existing_session_route(
        &crate::providers::session_route_provider_id(previous_route_provider),
        &previous_prefs.model_id,
        previous_session_model_is_stored,
    );
    let previous_composer_model = crate::providers::session_composer_model_id_for_route(
        previous_route_provider,
        &previous_route,
        &previous_prefs.model_id,
        previous_session_model_is_stored,
    );
    let previous_session_model = crate::providers::session_model_id_for_route(
        previous_route_provider,
        &previous_route,
        &previous_composer_model,
    );
    let previous_model = crate::providers::effort_model_id_for_route(
        &previous_route,
        &previous_composer_model,
        &previous_session_model,
    );
    let previous_effective = crate::providers::effective_reasoning_effort(
        &previous_route,
        &previous_model,
        &previous_prefs.effort,
    );
    let model_id = model_id.map(|model| {
        if ssh {
            crate::providers::official_model_id_for(&model)
        } else {
            model
        }
    });
    let picked_provider = if ssh {
        Some(crate::providers::SESSION_PROVIDER_OFFICIAL)
    } else {
        provider_id.as_deref()
    };
    let pick = crate::providers::composer_provider_pick(
        ssh,
        previous_provider.as_deref(),
        picked_provider,
        model_id.as_deref(),
    );

    if let Some(value) = effort.as_deref() {
        if !crate::acp_client::is_spawnable_reasoning_effort(value) {
            return Err("invalid composer reasoning effort".into());
        }
        let validation_provider = composer_effort_validation_provider(
            pick.route_changed,
            picked_provider,
            &previous_route,
        );
        let stored_provider = if pick.route_changed {
            picked_provider
        } else {
            previous_route_provider
        };
        let validation_model = composer_effort_validation_model(
            model_id.as_deref(),
            stored_provider,
            validation_provider,
            &previous_prefs.model_id,
            !pick.route_changed && previous_session_model_is_stored,
        );
        if !crate::providers::is_valid_reasoning_effort_for_model(
            validation_provider,
            &validation_model,
            value,
        ) {
            return Err("reasoning effort is not advertised by this model".into());
        }
    }

    let prefs = store::save_composer_prefs(
        project_id.as_deref(),
        session_id.as_deref(),
        model_id.clone(),
        effort.clone(),
        mode.clone(),
        permission_policy.clone(),
        pick.provider_to_persist.clone(),
    )?;
    if let (Some(sid), Some(pid)) = (session_id.as_deref(), pick.provider_to_persist.as_deref()) {
        mgr.remember_session_provider(sid, pid);
    }

    if apply_to_live_session {
        if let Some(ref pol) = permission_policy {
            if let Err(e) = mgr.apply_permission_policy(&app, pol).await {
                tracing::warn!("composer_prefs_set apply_permission: {e}");
            }
        }
    }
    // An empty stored id is the official route. Comparing the effective
    // routes treats the first save of that same route as a no-op, which keeps
    // the CLI resume id and still applies session/set_model. SSH pins both
    // sides to official, so an official model never respawns that chat.
    if pick.route_changed {
        // This chat's process was spawned for the previous provider. Clear
        // only this session's CLI resume id, then cold-spawn this chat.
        // `session/load` would restore the old route. Never `recycle_all`.
        if let Some(sid) = session_id.as_deref() {
            mgr.invalidate_spawn_flags_for_session(&app, sid, "session_provider")
                .await;
        }
    } else if let Some(mid) = pick.set_model_id {
        if let Err(e) = mgr.set_model(mid, session_id.as_deref()).await {
            tracing::warn!("composer_prefs_set set_model soft-fail: {e}");
        }
    }
    if let Some(sid) = session_id.as_deref() {
        let (next_provider, _, next_session_model_is_stored) =
            session_provider_and_ssh(Some(sid), project_id.as_deref());
        let next_route_provider = if ssh {
            Some(crate::providers::SESSION_PROVIDER_OFFICIAL)
        } else {
            next_provider.as_deref()
        };
        let next_route = crate::providers::existing_session_route(
            &crate::providers::session_route_provider_id(next_route_provider),
            &prefs.model_id,
            next_session_model_is_stored,
        );
        let next_composer_model = crate::providers::session_composer_model_id_for_route(
            next_route_provider,
            &next_route,
            &prefs.model_id,
            next_session_model_is_stored,
        );
        let next_session_model = crate::providers::session_model_id_for_route(
            next_route_provider,
            &next_route,
            &next_composer_model,
        );
        let next_model = crate::providers::effort_model_id_for_route(
            &next_route,
            &next_composer_model,
            &next_session_model,
        );
        let next_effective = crate::providers::effective_reasoning_effort(
            &next_route,
            &next_model,
            &prefs.effort,
        );
        let effective_changed = previous_effective != next_effective;
        if effort.is_some() || effective_changed {
            if let Err(e) = mgr
                .apply_effective_effort(
                    sid,
                    &prefs.effort,
                    next_effective.as_deref(),
                    effective_changed,
                )
                .await
            {
                tracing::warn!("composer_prefs_set failed to apply reasoning effort: {e}");
                let rollback_provider = pick.provider_to_persist.as_ref().map(|_| {
                    previous_provider
                        .clone()
                        .unwrap_or_else(|| crate::providers::SESSION_PROVIDER_OFFICIAL.into())
                });
                match store::save_composer_prefs(
                    project_id.as_deref(),
                    session_id.as_deref(),
                    model_id
                        .as_ref()
                        .map(|_| previous_prefs.model_id.clone()),
                    effort
                        .as_ref()
                        .map(|_| previous_prefs.effort.clone()),
                    mode.as_ref().map(|_| previous_prefs.mode.clone()),
                    permission_policy
                        .as_ref()
                        .map(|_| previous_prefs.permission_policy.clone()),
                    rollback_provider.clone(),
                ) {
                    Ok(_) => {
                        if let Some(provider) = rollback_provider.as_deref() {
                            mgr.remember_session_provider(sid, provider);
                        }
                        if pick.route_changed {
                            mgr.invalidate_spawn_flags_for_session(
                                &app,
                                sid,
                                "composer_prefs_rollback",
                            )
                            .await;
                        } else if model_id.is_some() {
                            if let Err(restore_error) = mgr
                                .set_model(previous_prefs.model_id.clone(), Some(sid))
                                .await
                            {
                                tracing::error!(
                                    "composer_prefs_set model restore failed after effort apply error: {restore_error}"
                                );
                            }
                        }
                        if apply_to_live_session && permission_policy.is_some() {
                            if let Err(restore_error) = mgr
                                .apply_permission_policy(&app, &previous_prefs.permission_policy)
                                .await
                            {
                                tracing::error!(
                                    "composer_prefs_set permission restore failed after effort apply error: {restore_error}"
                                );
                            }
                        }
                        if apply_to_live_session && mode.is_some() {
                            if let Err(restore_error) = mgr
                                .apply_product_mode(&app, previous_prefs.mode.clone())
                                .await
                            {
                                tracing::error!(
                                    "composer_prefs_set mode restore failed after effort apply error: {restore_error}"
                                );
                            }
                        }
                    }
                    Err(rollback_error) => tracing::error!(
                        "composer_prefs_set rollback failed after apply error: {rollback_error}"
                    ),
                }
                return Err(format!("failed to apply composer reasoning effort: {e}"));
            }
        }
    }
    if apply_to_live_session {
        if let Some(m) = mode {
            if let Err(e) = mgr.apply_product_mode(&app, m).await {
                tracing::warn!("composer_prefs_set apply_mode soft-fail: {e}");
            }
        }
    }
    Ok(composer_prefs_resolution(prefs, session_id.as_deref()))
}

#[cfg(test)]
mod composer_prefs_session_target_tests {
    use crate::store;
    use super::{
        composer_effort_validation_model, composer_effort_validation_provider,
        composer_prefs_project_target, composer_prefs_resolution, composer_prefs_session_target,
        should_apply_live_composer_preferences,
    };

    #[test]
    fn composer_prefs_resolution_reports_only_a_persisted_session_model() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-composer-prefs-resolution-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = crate::paths::ensure_app_dirs();

        let session = store::create_session(None, Some("test".into()), false)
            .expect("create test session");
        let no_model = composer_prefs_resolution(
            store::resolve_composer_prefs(None, Some(&session.id)),
            Some(&session.id),
        );
        assert!(no_model.session_model_id.is_none());

        store::save_composer_prefs(
            None,
            Some(&session.id),
            Some("session-model".into()),
            None,
            None,
            None,
            None,
        )
        .expect("save session model");
        let saved = composer_prefs_resolution(
            store::resolve_composer_prefs(None, Some(&session.id)),
            Some(&session.id),
        );
        assert_eq!(saved.session_model_id.as_deref(), Some("session-model"));
        let json = serde_json::to_value(saved).expect("serialize resolved prefs");
        assert_eq!(json["sessionModelId"], "session-model");
        assert!(json.get("prefs").is_none(), "prefs fields are flattened");

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn effort_validation_uses_the_resolved_model_after_provider_removal() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-effort-validation-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let resolved = composer_effort_validation_model(
            None,
            Some("deleted-provider-for-effort-test"),
            crate::providers::SESSION_PROVIDER_OFFICIAL,
            "gemini-3.5-flash",
            false,
        );
        let explicit = composer_effort_validation_model(
            Some("grok-4.6"),
            Some("deleted-provider-for-effort-test"),
            crate::providers::SESSION_PROVIDER_OFFICIAL,
            "gemini-3.5-flash",
            false,
        );
        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(resolved, crate::providers::OFFICIAL_CATALOG_MODEL);
        assert_eq!(explicit, "grok-4.6");
    }

    #[test]
    fn effort_validation_uses_the_resolved_route_for_a_deleted_provider() {
        assert_eq!(
            composer_effort_validation_provider(false, None, "official"),
            "official"
        );
        assert_eq!(
            composer_effort_validation_provider(false, None, "relay"),
            "relay"
        );
        assert_eq!(
            composer_effort_validation_provider(true, None, "relay"),
            "official"
        );
        assert_eq!(
            composer_effort_validation_provider(true, Some("relay"), "official"),
            "relay"
        );
    }

    #[test]
    fn draft_pref_updates_do_not_fall_back_to_the_live_project() {
        assert_eq!(
            composer_prefs_project_target(None, None, None, Some("live-project".into()), true)
                .unwrap(),
            None
        );
        assert_eq!(
            composer_prefs_project_target(
                Some("draft-project".into()),
                None,
                None,
                Some("live-project".into()),
                true,
            )
            .unwrap(),
            Some("draft-project".into())
        );
        assert_eq!(
            composer_prefs_project_target(
                None,
                Some("draft-session"),
                None,
                Some("live-project".into()),
                false,
            )
            .unwrap(),
            None
        );
        assert_eq!(
            composer_prefs_project_target(
                None,
                Some("session-in-project"),
                Some("session-project".into()),
                Some("live-project".into()),
                false,
            )
            .unwrap(),
            Some("session-project".into())
        );
        assert!(composer_prefs_project_target(
            Some("live-project".into()),
            Some("session-in-project"),
            Some("session-project".into()),
            Some("live-project".into()),
            false,
        )
        .is_err());
        assert_eq!(
            composer_prefs_project_target(None, None, None, Some("live-project".into()), false)
                .unwrap(),
            Some("live-project".into())
        );
    }

    #[test]
    fn draft_pref_updates_do_not_fall_back_to_the_live_session() {
        let live = Some("live-session".to_string());

        assert_eq!(
            composer_prefs_session_target(
                None,
                live.clone(),
                Some("high"),
                None,
                None,
                None,
                None,
            ),
            None
        );
        assert_eq!(
            composer_prefs_session_target(
                None,
                live.clone(),
                None,
                Some("relay"),
                Some("vendor-model"),
                None,
                None,
            ),
            None
        );
        assert_eq!(
            composer_prefs_session_target(
                None,
                live.clone(),
                None,
                None,
                None,
                Some("plan"),
                None,
            ),
            None
        );
        assert_eq!(
            composer_prefs_session_target(
                None,
                live.clone(),
                None,
                None,
                None,
                None,
                Some("ask"),
            ),
            None
        );
        assert_eq!(
            composer_prefs_session_target(
                None,
                live.clone(),
                None,
                None,
                None,
                None,
                None,
            ),
            live
        );
        assert_eq!(
            composer_prefs_session_target(
                Some("explicit-session".into()),
                Some("live-session".into()),
                None,
                Some("relay"),
                Some("vendor-model"),
                None,
                None,
            ),
            Some("explicit-session".into())
        );
    }

    #[test]
    fn composer_prefs_apply_live_only_to_the_target_session() {
        assert!(should_apply_live_composer_preferences(
            Some("session-a"),
            Some("session-a")
        ));
        assert!(!should_apply_live_composer_preferences(
            Some("session-a"),
            Some("session-b")
        ));
        assert!(!should_apply_live_composer_preferences(None, Some("session-b")));
    }
}
