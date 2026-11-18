
/// Scan CC Switch Grok Build providers (read-only SQLite).
#[tauri::command]
pub async fn providers_cc_switch_scan(
) -> Result<crate::cc_switch_import::CcSwitchScanResult, String> {
    tauri::async_runtime::spawn_blocking(
        crate::cc_switch_import::scan_cc_switch_providers,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Import selected CC Switch Grok Build providers into App custom providers.
#[tauri::command]
pub async fn providers_cc_switch_import(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    body: crate::cc_switch_import::CcSwitchImportRequest,
) -> Result<crate::cc_switch_import::CcSwitchImportResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::cc_switch_import::import_cc_switch_providers(body)
    })
    .await
    .map_err(|e| e.to_string())??;
    for provider_id in &result.affected_provider_ids {
        mgr.invalidate_sessions_for_provider(&app, provider_id, "provider_route")
            .await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn providers_list() -> Result<crate::providers::ProvidersListResult, String> {
    // Blocking file I/O off the async runtime (migrations / repairs / list).
    tauri::async_runtime::spawn_blocking(|| {
        // One-time migration of legacy single relay secrets → multi-provider config.
        let secrets = store::load_secrets();
        let _ = crate::providers::maybe_migrate_legacy_relay(
            secrets.relay_base_url.as_deref(),
            secrets.relay_api_key.as_deref(),
            secrets.default_model.as_deref(),
        );
        // Ensure agent transport retries are high enough for flaky custom relays.
        let _ = crate::providers::ensure_models_retry_cap();
        // Existing allowlists must name App channel ids. Absent key stays absent.
        let _ = crate::providers::ensure_custom_ids_in_allowed_models();
        // Fix bases saved without /v1 (causes silent multi-minute inference retries).
        let _ = crate::providers::repair_custom_base_urls();
        // OpenCode Zen Go SSE trailers → loopback sanitize proxy base_url rewrite.
        let _ = crate::relay_stream_proxy::repair_sanitize_proxy_bases();
        crate::providers::list_custom_providers()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn providers_upsert(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    model: String,
    base_url: String,
    name: Option<String>,
    api_key: Option<String>,
    api_backend: Option<String>,
    provider_mode: Option<String>,
    create_only: Option<bool>,
    models: Option<Vec<crate::providers::ProviderModelEntry>>,
    efforts: Option<Vec<crate::providers::ProviderEffortEntry>>,
    context_window: Option<u64>,
    base_url_full_path: Option<bool>,
    append_prompt: Option<String>,
    supports_vision: Option<bool>,
    extra_headers: Option<Vec<crate::providers::ProviderHeaderEntry>>,
) -> Result<crate::providers::ProvidersListResult, String> {
    let normalized_provider_mode = match provider_mode.as_deref() {
        Some(raw) => crate::providers::normalize_provider_mode(Some(raw)),
        None => crate::providers::provider_mode_for_id(&id),
    };
    if normalized_provider_mode == crate::providers::PROVIDER_MODE_GROK_BUILD_PROXY {
        if crate::providers::normalize_backend(api_backend.as_deref()) != "responses" {
            return Err("grok_build_proxy requires api_backend=responses".into());
        }
        check_grok_build_proxy_live_models(
            id.clone(),
            model.clone(),
            base_url.clone(),
            api_key.clone(),
            base_url_full_path,
            models.clone(),
        )
        .await?;
    }
    let mutated_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result =
            crate::providers::upsert_custom_provider(crate::providers::UpsertProviderInput {
                id,
                model: model.clone(),
                base_url,
                name,
                api_key,
                api_backend,
                provider_mode: Some(normalized_provider_mode),
                create_only,
                models,
                efforts,
                context_window,
                base_url_full_path,
                append_prompt,
                supports_vision,
                extra_headers,
            })?;
        // Keep legacy secrets in sync for Doctor / account channel display.
        if let Some(p) = result
            .providers
            .iter()
            .find(|p| p.is_default)
            .or(result.providers.first())
        {
            let mut secrets = store::load_secrets();
            secrets.relay_base_url = Some(p.base_url.clone());
            secrets.default_model = result.default_model.clone();
            // Do not copy api_key into secrets (stays only in config.toml).
            let _ = store::save_secrets(&secrets);
        }
        Ok::<_, String>(result)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Only chats already routed to this provider must cold-spawn. Dropping
    // every warm agent would interrupt unrelated sessions for one edit.
    mgr.invalidate_sessions_for_provider(&app, &mutated_id, "provider_route")
        .await;
    Ok(result)
}

/// Live `/models` gate for a grok-build-proxy upsert.
///
/// Reads the stored catalog so an unchanged, unreadable, or explicitly cleared
/// one is not re-checked through the channel `model`. `Some([])` on an existing
/// section is the explicit clear and passes without a request; a create with no
/// rows is rejected before the round-trip instead of fetching `/models` to
/// discover the same thing.
async fn check_grok_build_proxy_live_models(
    id: String,
    model: String,
    base_url: String,
    api_key: Option<String>,
    base_url_full_path: Option<bool>,
    models: Option<Vec<crate::providers::ProviderModelEntry>>,
) -> Result<(), String> {
    let provider_id = id.clone();
    let stored_catalog = tauri::async_runtime::spawn_blocking(move || {
        crate::providers::stored_provider_model_catalog(&provider_id)
    })
    .await
    .map_err(|e| e.to_string())?;
    if !crate::providers::grok_build_proxy_upsert_needs_live_models(
        models.as_deref(),
        stored_catalog.as_ref(),
    ) {
        return Ok(());
    }
    if stored_catalog.is_none() && models.as_deref().is_some_and(|rows| rows.is_empty()) {
        return Err("grok_build_proxy requires at least one model".into());
    }
    let normalized_base = crate::providers::normalize_openai_base_url(
        &base_url,
        "responses",
        base_url_full_path.unwrap_or_else(|| {
            crate::providers::provider_base_url_full_path_for_id(&id)
        }),
    );
    let remote =
        crate::providers::list_remote_models(normalized_base, api_key, Some(id)).await?;
    let selected = models.unwrap_or_else(|| {
        vec![crate::providers::ProviderModelEntry::named(
            model.clone(),
            model.clone(),
        )]
    });
    crate::providers::validate_grok_build_proxy_models(&remote.models, &selected)
}

#[tauri::command]
pub async fn providers_remove(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
) -> Result<crate::providers::ProvidersListResult, String> {
    let affected_id = crate::providers::sanitize_provider_id(&id)?;
    let (result, affected_sessions) = tauri::async_runtime::spawn_blocking(move || {
        let result = crate::providers::remove_custom_provider(&id)?;
        let sessions = store::fallback_sessions_for_provider(
            &affected_id,
            crate::providers::OFFICIAL_CATALOG_MODEL,
        )?;
        Ok::<_, String>((result, sessions))
    })
    .await
    .map_err(|e| e.to_string())??;
    // A deleted route must not keep a warm process. Chats on other providers
    // stay connected; its saved route and model already point to official.
    for session_id in affected_sessions {
        mgr.invalidate_spawn_flags_for_session(&app, &session_id, "provider_route")
            .await;
    }
    mgr.retire_prewarm().await;
    Ok(result)
}

#[tauri::command]
pub async fn providers_ping(
    base_url: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<crate::providers::ProviderPingResult, String> {
    crate::providers::ping_provider(base_url, api_key, provider_id).await
}

#[tauri::command]
pub async fn providers_list_models(
    base_url: String,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<crate::providers::RemoteModelsResult, String> {
    crate::providers::list_remote_models(base_url, api_key, provider_id).await
}

/// Test whether a specific model id is usable on a custom provider.
/// Sends one tiny non-streaming inference request; success = HTTP 2xx.
#[tauri::command]
pub async fn providers_test_model(
    base_url: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
    model: String,
    api_backend: Option<String>,
    base_url_full_path: Option<bool>,
) -> Result<crate::providers::ProviderTestResult, String> {
    crate::providers::test_model_connection(
        base_url,
        api_key,
        provider_id,
        model,
        api_backend,
        base_url_full_path,
    )
    .await
}

/// Probe provider account balance (Phase 1: DeepSeek `GET /user/balance` only).
#[tauri::command]
pub async fn providers_balance(
    base_url: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<crate::providers::ProviderBalanceResult, String> {
    crate::providers::query_provider_balance(base_url, api_key, provider_id).await
}

// ── Official aux side-channel (isolated GROK_HOME + grok -p) ─────────────────

#[tauri::command]
pub async fn official_aux_status() -> Result<crate::official_aux::OfficialAuxStatus, String> {
    Ok(crate::official_aux::status())
}

#[tauri::command]
pub async fn official_aux_ensure_home() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::official_aux::ensure_official_aux_home().map(|p| p.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn official_aux_dispatch(
    tool: String,
    args: serde_json::Value,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::official_aux::dispatch_tool(&tool, &args))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn official_aux_web_search(query: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::official_aux::web_search(&query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn official_aux_x_keyword_search(
    query: String,
    limit: Option<u32>,
    min_faves: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::official_aux::x_keyword_search(&query, limit, min_faves)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn official_aux_x_semantic_search(
    query: String,
    limit: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::official_aux::x_semantic_search(&query, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn official_aux_x_user_search(
    query: String,
    count: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::official_aux::x_user_search(&query, count))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn official_aux_x_thread_fetch(post_id_or_url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::official_aux::x_thread_fetch(&post_id_or_url)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn official_aux_vision_describe(
    paths: Vec<String>,
    question: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::official_aux::vision_describe(&paths, question.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Editors ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn editors_list() -> Result<crate::editors::EditorsListResult, String> {
    Ok(crate::editors::list_editors_with_icons())
}

#[tauri::command]
pub async fn open_in_editor(
    path: String,
    line: Option<u32>,
    editor: Option<String>,
) -> Result<(), String> {
    let settings = store::load_settings_async().await;
    let target = editor
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| settings.default_open_target.clone());
    crate::editors::open_in_editor(&path, line, Some(target.as_str()))
}

#[cfg(test)]
mod project_inspect_tests {
    use super::build_project_inspect_summary;

    #[test]
    fn summary_strips_mcp_env_and_skill_descriptions() {
        let raw = serde_json::json!({
            "grokVersion": "0.2.0",
            "projectRoot": "/tmp/p/",
            "projectTrusted": true,
            "skills": [{
                "name": "help",
                "description": "secret sk-abcdefghijklmnopqrstuvwxyz",
                "source": { "type": "user" },
                "userInvocable": true
            }],
            "mcpServers": [{
                "name": "ctx",
                "transport": "stdio",
                "target": "/bin/npx",
                "env": { "API_KEY": "sk-secretsecretsecret" }
            }],
            "plugins": [{ "name": "p1", "scope": "user", "enabled": true }],
            "agents": [{ "name": "explore", "source": { "type": "builtin" } }],
            "projectInstructions": [{ "path": "/tmp/p/AGENTS.md", "scope": "project" }],
            "hooks": [{
                "event": "stop",
                "hookType": "file",
                "target": "/tmp/p/.grok/hooks/stop.json",
                "source": { "type": "project" }
            }],
            "permissions": { "loaded": 0, "sources": [], "managedSettingsActive": false }
        });
        let out = build_project_inspect_summary(
            Some(&raw),
            Some("/tmp/p"),
            None,
            vec!["grok-4".into()],
        );
        let s = out.to_string();
        assert!(s.contains("\"help\""));
        assert!(s.contains("\"ctx\""));
        assert!(s.contains("AGENTS.md"));
        assert!(!s.contains("sk-secret"));
        assert!(!s.contains("API_KEY"));
        assert!(!s.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert_eq!(out["skills"]["total"], 1);
        assert_eq!(out["skills"]["names"][0], "help");
        assert_eq!(out["mcp"][0]["name"], "ctx");
        assert!(out["mcp"][0].get("env").is_none());
        assert_eq!(out["hooksCount"], 1);
        assert_eq!(out["hooks"][0]["event"], "stop");
        assert_eq!(out["hooks"][0]["source"], "project");
        assert_eq!(out["agents"][0]["name"], "explore");
        assert!(out["modelsHints"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("grok-4")));
    }

    #[test]
    fn summary_handles_missing_inspect() {
        let out = build_project_inspect_summary(
            None,
            Some("/tmp/p"),
            Some("Grok Build CLI not found".into()),
            vec![],
        );
        assert_eq!(out["skills"]["total"], 0);
        assert_eq!(out["error"], "Grok Build CLI not found");
    }
}

#[cfg(test)]
mod grok_build_proxy_gate_tests {
    use super::check_grok_build_proxy_live_models;

    fn proxy_config(app_models_json: &str) -> String {
        let quoted =
            serde_json::to_string(app_models_json).expect("quote app_models for TOML");
        format!(
            "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Relay\"
api_key = \"sk-test-relay\"
api_backend = \"responses\"
app_provider_mode = \"grok_build_proxy\"
app_models = {quoted}
"
        )
    }

    fn with_app_home<T>(config_toml: Option<&str>, run: impl FnOnce() -> T) -> T {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-proxy-gate-{}",
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);
        if let Some(text) = config_toml {
            let dir = home.join("agent-home");
            std::fs::create_dir_all(&dir).expect("agent home");
            std::fs::write(dir.join("config.toml"), text).expect("config.toml");
        }
        let out = run();
        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
        out
    }

    fn gate(models: Option<Vec<crate::providers::ProviderModelEntry>>) -> Result<(), String> {
        tauri::async_runtime::block_on(check_grok_build_proxy_live_models(
            "relay".into(),
            "m1".into(),
            "https://relay.example/v1".into(),
            Some("sk-test-relay".into()),
            None,
            models,
        ))
    }

    #[test]
    fn explicit_clear_on_an_existing_proxy_skips_the_live_gate() {
        let config = proxy_config(r#"[{"id":"m1","name":"M1"}]"#);
        let outcome = with_app_home(Some(&config), || gate(Some(Vec::new())));
        assert_eq!(outcome, Ok(()));
    }

    #[test]
    fn unchanged_corrupt_catalog_skips_the_live_gate_and_the_clear_still_passes() {
        let config = proxy_config("{not json");
        let outcome = with_app_home(Some(&config), || {
            (gate(None), gate(Some(Vec::new())))
        });
        assert_eq!(outcome, (Ok(()), Ok(())));
    }

    #[test]
    fn explicit_clear_on_create_still_requires_one_model() {
        let outcome = with_app_home(None, || gate(Some(Vec::new())));
        assert_eq!(
            outcome.unwrap_err(),
            "grok_build_proxy requires at least one model"
        );
    }
}
