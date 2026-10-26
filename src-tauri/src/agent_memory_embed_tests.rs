use super::*;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_app_home(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let p = std::env::temp_dir().join(format!(
        "grok-mem-embed-{}-{}-{}",
        label,
        std::process::id(),
        nanos
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn parse_missing_keys_are_none() {
    let flags = parse_memory_embed_flags("[ui]\nyolo = true\n");
    assert_eq!(flags, MemoryEmbedFlags::default());
}

#[test]
fn parse_allowlisted_nested_memory_keys() {
    let text = r#"
[memory]
enabled = true

[memory.embedding]
model = "text-embedding-3-small"
dimensions = 1024
provider = "api"
base_url = "https://api.siliconflow.cn/v1"
api_key = "sk-embed-secret"

[memory.search]
max_results = 8
min_score = 0.35
vector_weight = 0.7
text_weight = 0.3

[memory.search.mmr]
enabled = true
lambda = 0.7

[memory.search.temporal_decay]
enabled = true
half_life_days = 7.0

[memory.dream]
enabled = false
min_hours = 4
min_sessions = 3
check_interval_secs = 3600

[memory.watcher]
enabled = true

[memory.initial_injection]
enabled = true
min_score = 0.0

[model.x]
api_key = "sk-abcdefghijklmnopqrstuvwxyz0123"
"#;
    let flags = parse_memory_embed_flags(text);
    assert_eq!(
        flags.embedding_model.as_deref(),
        Some("text-embedding-3-small")
    );
    assert_eq!(flags.embedding_dimensions, Some(1024));
    assert_eq!(flags.embedding_provider.as_deref(), Some("api"));
    assert_eq!(
        flags.embedding_base_url.as_deref(),
        Some("https://api.siliconflow.cn/v1")
    );
    assert_eq!(flags.embedding_api_key.as_deref(), Some("sk-embed-secret"));
    assert_eq!(flags.search_max_results, Some(8));
    assert_eq!(flags.search_min_score, Some(0.35));
    assert_eq!(flags.mmr_enabled, Some(true));
    assert_eq!(flags.mmr_lambda, Some(0.7));
    assert_eq!(flags.temporal_decay_enabled, Some(true));
    assert_eq!(flags.dream_enabled, Some(false));
    assert_eq!(flags.dream_min_sessions, Some(3));
    assert_eq!(flags.watcher_enabled, Some(true));
    assert_eq!(flags.initial_injection_enabled, Some(true));
}

#[test]
fn apply_patch_sets_nested_tables_and_clears_model() {
    let existing = r#"
[models]
default = "grok"

[memory.embedding]
model = "old-model"
dimensions = 512
"#;
    let next = apply_memory_embed_patch(
        existing,
        &MemoryEmbedConfigPatch {
            clear_embedding_model: Some(true),
            embedding_dimensions: Some(1024),
            mmr_enabled: Some(true),
            mmr_lambda: Some(0.7),
            search_min_score: Some(0.4),
            dream_enabled: Some(false),
            ..Default::default()
        },
    );
    assert!(next.contains("[models]"), "{next}");
    assert!(next.contains("default = \"grok\""), "{next}");
    assert!(!next.contains("old-model"), "{next}");
    assert!(next.contains("dimensions = 1024"), "{next}");
    assert!(next.contains("[memory.search.mmr]"), "{next}");
    assert!(next.contains("enabled = true"), "{next}");
    assert!(
        next.contains("lambda = 0.7") || next.contains("lambda = 0.700"),
        "{next}"
    );
    assert!(next.contains("[memory.search]"), "{next}");
    assert!(
        next.contains("min_score = 0.4") || next.contains("min_score = 0.40"),
        "{next}"
    );
    assert!(next.contains("[memory.dream]"), "{next}");
    assert!(next.contains("enabled = false"), "{next}");
}

#[test]
fn extract_sections_keeps_memory_tables_only() {
    let text = r#"
[features]
telemetry = false

[memory.embedding]
model = "m"

[model.x]
api_key = "sk-abcdefghijklmnopqrstuvwxyz0123"
"#;
    let preview = extract_memory_embed_sections(text);
    assert!(preview.contains("[memory.embedding]"));
    assert!(preview.contains("model = \"m\""));
    assert!(!preview.contains("[features]"));
    assert!(!preview.contains("[model.x]"));
    assert!(!preview.contains("sk-"));
}

#[test]
fn load_and_save_roundtrip_independent() {
    let _lock = crate::paths::APP_HOME_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let tmp = temp_app_home("roundtrip");
    let prev = std::env::var("GROK_APP_HOME").ok();
    std::env::set_var("GROK_APP_HOME", &tmp);

    let _ = ensure_app_dirs();
    let mut s = store::load_settings();
    s.session_data_mode = "independent".into();
    store::save_settings(&s).unwrap();

    let snap = load_memory_embed_config().unwrap();
    assert!(snap.writable);
    assert!(snap.path.contains("agent-home"));
    assert!(!snap.embedding_configured);
    assert_eq!(snap.app_search_mode, "keyword");
    assert_eq!(snap.cli_search_mode, "keyword");
    assert_eq!(snap.embedding_model, None);

    let saved = save_memory_embed_config(&MemoryEmbedConfigPatch {
        embedding_model: Some("text-embedding-3-small".into()),
        embedding_dimensions: Some(1024),
        search_max_results: Some(6),
        search_min_score: Some(0.35),
        mmr_enabled: Some(false),
        dream_enabled: Some(true),
        dream_min_sessions: Some(3),
        watcher_enabled: Some(true),
        ..Default::default()
    })
    .unwrap();
    assert!(saved.embedding_configured);
    assert_eq!(saved.cli_search_mode, "hybrid");
    assert_eq!(
        saved.embedding_model.as_deref(),
        Some("text-embedding-3-small")
    );
    assert_eq!(saved.embedding_dimensions, Some(1024));
    assert_eq!(saved.mmr_enabled, Some(false));
    assert!(saved.file_exists);

    let cleared = save_memory_embed_config(&MemoryEmbedConfigPatch {
        clear_embedding_model: Some(true),
        ..Default::default()
    })
    .unwrap();
    assert!(!cleared.embedding_configured);
    assert_eq!(cleared.cli_search_mode, "keyword");
    assert_eq!(cleared.embedding_model, None);

    match prev {
        Some(v) => std::env::set_var("GROK_APP_HOME", v),
        None => std::env::remove_var("GROK_APP_HOME"),
    }
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn save_embedding_url_and_key_round_trip_keeps_other_sections() {
    let _lock = crate::paths::APP_HOME_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let tmp = temp_app_home("embed-url");
    let prev = std::env::var("GROK_APP_HOME").ok();
    std::env::set_var("GROK_APP_HOME", &tmp);

    let outcome = (|| -> Result<(), String> {
        let _ = ensure_app_dirs();
        let mut s = store::load_settings();
        s.session_data_mode = "independent".into();
        store::save_settings(&s)?;
        let path = agent_config_toml();
        let before = "\
# keep-me
[models]
default = \"grok\"

[memory]
enabled = false

[memory.embedding] # embed
provider = \"api\"
model = \"old-model\"
dimensions = 1024

[model.demo]
# channel note
model = \"demo-model\"
base_url = \"https://relay.example/v1\"
api_key = \"sk-channel-secret\"

[model.\"claude-glm-5.3[1M]\"]
model = \"claude-glm-5.3[1M]\"
base_url = \"http://relay/anthropic/v1\"
api_key = \"sk-alias-secret\"
";
        fs::write(&path, before).map_err(|e| e.to_string())?;
        let saved = save_memory_embed_config(&MemoryEmbedConfigPatch {
            embedding_model: Some("qwen3-embedding".into()),
            embedding_base_url: Some("https://api.example.test/v1".into()),
            embedding_api_key: Some("sk-embed-probe-secret".into()),
            ..Default::default()
        })?;
        assert_eq!(saved.embedding_model.as_deref(), Some("qwen3-embedding"));
        assert_eq!(
            saved.embedding_base_url.as_deref(),
            Some("https://api.example.test/v1")
        );
        assert!(saved.has_embedding_api_key);
        assert!(
            !saved.redacted_preview.contains("sk-embed-probe-secret"),
            "preview must not echo the embedding key"
        );

        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        assert!(text.contains("model = \"qwen3-embedding\""), "{text}");
        assert!(
            text.contains("base_url = \"https://api.example.test/v1\""),
            "{text}"
        );
        assert!(
            text.contains("api_key = \"sk-embed-probe-secret\""),
            "{text}"
        );
        assert!(text.contains("provider = \"api\""), "{text}");
        assert!(text.contains("dimensions = 1024"), "{text}");
        assert!(text.starts_with("# keep-me\n"), "{text}");
        assert!(text.contains("[memory]\nenabled = false"), "{text}");
        assert!(text.contains("# channel note"), "{text}");
        assert!(text.contains("api_key = \"sk-channel-secret\""), "{text}");
        assert!(text.contains("api_key = \"sk-alias-secret\""), "{text}");
        assert!(
            text.contains("base_url = \"https://relay.example/v1\""),
            "{text}"
        );
        assert!(text.contains("[model.\"claude-glm-5.3[1M]\"]"), "{text}");
        let i_keep = text.find("# keep-me").unwrap();
        let i_models = text.find("[models]").unwrap();
        let i_mem = text.find("[memory]\n").unwrap();
        let i_embed = text.find("[memory.embedding]").unwrap();
        let i_demo = text.find("[model.demo]").unwrap();
        let i_alias = text.find("[model.\"claude-glm-5.3[1M]\"]").unwrap();
        assert!(
            i_keep < i_models
                && i_models < i_mem
                && i_mem < i_embed
                && i_embed < i_demo
                && i_demo < i_alias,
            "{text}"
        );

        let reloaded = load_memory_embed_config()?;
        assert_eq!(
            reloaded.embedding_base_url.as_deref(),
            Some("https://api.example.test/v1")
        );
        assert!(reloaded.has_embedding_api_key);
        assert_eq!(reloaded.embedding_model.as_deref(), Some("qwen3-embedding"));

        let cleared = save_memory_embed_config(&MemoryEmbedConfigPatch {
            clear_embedding_base_url: Some(true),
            embedding_api_key: Some(String::new()),
            ..Default::default()
        })?;
        assert_eq!(cleared.embedding_base_url, None);
        assert!(!cleared.has_embedding_api_key);
        assert_eq!(cleared.embedding_model.as_deref(), Some("qwen3-embedding"));
        let after = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        assert!(!after.contains("sk-embed-probe-secret"), "{after}");
        assert!(!after.contains("api.example.test"), "{after}");
        assert!(after.contains("model = \"qwen3-embedding\""), "{after}");
        assert!(after.contains("sk-channel-secret"), "{after}");
        assert!(after.contains("sk-alias-secret"), "{after}");
        assert!(after.contains("# keep-me"), "{after}");
        assert!(after.contains("# channel note"), "{after}");
        assert!(after.contains("[model.\"claude-glm-5.3[1M]\"]"), "{after}");

        fn mask(raw: &str) -> String {
            raw.replace("sk-embed-probe-secret", "sk-****")
                .replace("sk-channel-secret", "sk-****")
                .replace("sk-alias-secret", "sk-****")
        }
        eprintln!("--- memory embed BEFORE ---\n{}", mask(before));
        eprintln!("--- memory embed AFTER SAVE ---\n{}", mask(&text));
        eprintln!("--- memory embed AFTER CLEAR ---\n{}", mask(&after));
        Ok(())
    })();

    match prev {
        Some(v) => std::env::set_var("GROK_APP_HOME", v),
        None => std::env::remove_var("GROK_APP_HOME"),
    }
    let _ = fs::remove_dir_all(&tmp);
    outcome.expect("embedding url/key round trip");
}

#[test]
fn save_refuses_shared_mode() {
    let _lock = crate::paths::APP_HOME_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let tmp = temp_app_home("shared");
    let prev = std::env::var("GROK_APP_HOME").ok();
    std::env::set_var("GROK_APP_HOME", &tmp);
    let _ = ensure_app_dirs();
    let mut s = store::load_settings();
    s.session_data_mode = "shared".into();
    store::save_settings(&s).unwrap();

    let err = save_memory_embed_config(&MemoryEmbedConfigPatch {
        mmr_enabled: Some(true),
        ..Default::default()
    })
    .unwrap_err();
    assert!(err.contains("shared"), "{err}");

    match prev {
        Some(v) => std::env::set_var("GROK_APP_HOME", v),
        None => std::env::remove_var("GROK_APP_HOME"),
    }
    let _ = fs::remove_dir_all(&tmp);
}
