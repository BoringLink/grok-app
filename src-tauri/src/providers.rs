//! Custom OpenAI-compatible providers → agent-readable config.toml under GROK_HOME.
//! Intentionally original implementation (not ported from other desktops).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::paths::{agent_config_toml, agent_home_dir, ensure_app_dirs};
use crate::provider_headers::{
    decode_extra_headers, encode_extra_headers_toml, normalize_extra_headers, EXTRA_HEADERS_KEY,
};
use crate::provider_model_profile::{
    encode_model_catalog, legacy_model_catalog, read_model_catalog, resolve_catalog_rows,
    resolve_model_catalog, ModelCatalogRead,
};

pub use crate::provider_headers::ProviderHeaderEntry;

/// One selectable request model under a custom provider channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelEntry {
    /// Upstream request body model id.
    pub id: String,
    /// Composer chip / menu display label. Missing → the id.
    #[serde(default)]
    pub name: String,
    /// Per-model context window (tokens). Missing → 1M fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Which layer produced `context_window`: `user`, `remote`, or `fallback`.
    /// A legacy row without this marker keeps a non-empty window as user-set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_source: Option<String>,
    /// Legacy per-model image-pixel flag. No Settings control; kept verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_vision: Option<bool>,
    /// Legacy per-model video-input flag. No Settings control; kept verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_video: Option<bool>,
    /// 模型专属档位为空时使用通用 fallback；旧式单模型路由仅在 id 匹配时用 channel `efforts`。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<ProviderEffortEntry>,
    /// Which layer produced `efforts`: `user`, `remote`, or `fallback`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub efforts_source: Option<String>,
    /// Whether this model accepts reasoning levels. Missing → supported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort: Option<bool>,
    /// Which layer produced `supports_reasoning_effort`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort_source: Option<String>,
    /// App-owned setting that lets Composer expose the raw `none` id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_off: Option<bool>,
}

impl ProviderModelEntry {
    pub fn named(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            ..Default::default()
        }
    }
}

/// One selectable reasoning-effort option for a custom channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEffortEntry {
    /// Value passed to `--reasoning-effort` / upstream `reasoning_effort`.
    pub id: String,
    /// Composer display label (optional; falls back to id).
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub id: String,
    /// Active request model (written to config `model = …`).
    pub model: String,
    pub base_url: String,
    pub name: String,
    pub has_api_key: bool,
    pub api_backend: String,
    /// `generic` writes a normal `[model.<id>]` relay. `grok_build_proxy`
    /// exposes the relay as Grok Build's native model catalog / chat proxy so
    /// the CLI can discover server-side capabilities from `/models`.
    #[serde(default = "default_provider_mode")]
    pub provider_mode: String,
    /// Legacy read-only: mirrors `[models].default` for the secrets compat path
    /// (`secrets_get_masked`, provider upsert mirroring) and Doctor display.
    /// Never use it to decide a chat's route.
    pub is_default: bool,
    /// Catalog of selectable models for this channel (App-managed).
    /// Legacy providers without `app_models` read as one row from `model`.
    #[serde(default)]
    pub models: Vec<ProviderModelEntry>,
    /// True when `app_models` on disk cannot be read. `models` carries the
    /// legacy fallback row, or the rows recovered from a partially invalid
    /// array, so the channel stays usable, but Settings must not resend that
    /// read-only view as a catalog: an edit that omits `models` keeps the
    /// stored text. Deliberately opaque — no parse detail or raw value here.
    #[serde(default)]
    pub model_catalog_corrupt: bool,
    /// `app_efforts` 仅用于匹配的旧式单模型路由；多模型目录不借用当前 channel 档位。
    #[serde(default)]
    pub efforts: Vec<ProviderEffortEntry>,
    /// Optional per-channel context window (tokens). None → App falls back to
    /// the model catalog window, then `DEFAULT_CUSTOM_CONTEXT_WINDOW`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// When true, treat `base_url` as a complete root path and never auto-append `/v1`.
    /// Default false preserves legacy OpenAI-compatible `/v1` normalization.
    #[serde(default)]
    pub base_url_full_path: bool,
    /// Extra instructions appended to the system prompt for this channel.
    ///
    /// Relays differ in what they need spelled out; this rides the CLI's
    /// `--rules` (append) rather than `--system-prompt-override` (replace), so
    /// the agent keeps its built-in prompt. Empty / unset = nothing appended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_prompt: Option<String>,
    /// Explicit: this relay accepts image pixels (`image_url`). Combined with
    /// name/model heuristics in `models_aux` to decide text-only vs vision.
    #[serde(default)]
    pub supports_vision: bool,
    /// Extra HTTP headers written as Grok Build `extra_headers` (verbatim).
    #[serde(default)]
    pub extra_headers: Vec<ProviderHeaderEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderInput {
    pub id: String,
    pub model: String,
    pub base_url: String,
    pub name: Option<String>,
    /// Empty / omitted = keep existing key on edit.
    pub api_key: Option<String>,
    pub api_backend: Option<String>,
    /// Explicit transport semantics. Never inferred from a provider hostname.
    pub provider_mode: Option<String>,
    pub create_only: Option<bool>,
    /// Optional multi-model catalog; when omitted on edit, keep previous `app_models`.
    pub models: Option<Vec<ProviderModelEntry>>,
    /// Optional effort catalog; when omitted on edit, keep previous `app_efforts`.
    pub efforts: Option<Vec<ProviderEffortEntry>>,
    /// Context window (tokens). `Some(0)` clears; `Some(n>0)` sets;
    /// `None` keeps the existing value on edit. Written to TOML as a string.
    #[serde(default)]
    pub context_window: Option<u64>,
    /// Full-path base URL mode. `None` keeps previous flag on edit; create defaults false.
    #[serde(default)]
    pub base_url_full_path: Option<bool>,
    /// Appended system-prompt rules. `Some("")` clears; `None` keeps existing on edit.
    #[serde(default)]
    pub append_prompt: Option<String>,
    /// Explicit vision capability. `None` keeps previous flag on edit; create defaults false.
    #[serde(default)]
    pub supports_vision: Option<bool>,
    /// Extra request headers. `None` keeps existing on edit; `Some([])` clears.
    #[serde(default)]
    pub extra_headers: Option<Vec<ProviderHeaderEntry>>,
}

/// Provenance markers for the per-model metadata that Settings may override.
const MODEL_SOURCE_USER: &str = "user";
const MODEL_SOURCE_REMOTE: &str = "remote";
const MODEL_SOURCE_FALLBACK: &str = "fallback";

/// TOML field (ignored by Grok Build) storing JSON array of `{id,name}`.
const APP_MODELS_KEY: &str = "app_models";
/// TOML field (ignored by Grok Build) storing JSON array of `{id,name,isDefault}`.
const APP_EFFORTS_KEY: &str = "app_efforts";
/// Grok Build capability gate for forwarding `--reasoning-effort` to inference.
const SUPPORTS_REASONING_EFFORT_KEY: &str = "supports_reasoning_effort";
/// CLI native effort menu. Without it the CLI rejects custom ids such as
/// `instant` and falls back to its default level.
const CLI_REASONING_EFFORTS_KEY: &str = "reasoning_efforts";
/// TOML field (ignored by Grok Build): when true, do not auto-append `/v1` to base_url.
const APP_BASE_URL_FULL_PATH_KEY: &str = "app_base_url_full_path";
/// TOML field (ignored by Grok Build): extra rules appended to the system prompt.
const APP_APPEND_PROMPT_KEY: &str = "app_append_prompt";
/// TOML field (ignored by Grok Build): relay accepts multimodal image_url.
const APP_SUPPORTS_VISION_KEY: &str = "app_supports_vision";
/// TOML field (ignored by Grok Build): relay transport semantics selected in App.
const APP_PROVIDER_MODE_KEY: &str = "app_provider_mode";
/// TOML field (ignored by Grok Build): this `[model.*]` section is one catalog
/// row of a generic channel, not a provider card. Value is the parent section id.
const APP_PARENT_PROVIDER_KEY: &str = "app_parent_provider";

pub const PROVIDER_MODE_GENERIC: &str = "generic";
pub const PROVIDER_MODE_GROK_BUILD_PROXY: &str = "grok_build_proxy";

/// Custom providers without a model-row or channel window use this size, the
/// same convenience default the App UI shows (`DEFAULT_CUSTOM_CONTEXT_WINDOW`
/// in `src/lib/grokCatalog.ts`). Applied on connect and model switch so the
/// CLI occupancy matches the Composer instead of the CLI's own default.
pub const DEFAULT_CUSTOM_CONTEXT_WINDOW: u64 = 1_000_000;

fn default_provider_mode() -> String {
    PROVIDER_MODE_GENERIC.to_string()
}

pub fn normalize_provider_mode(raw: Option<&str>) -> String {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        PROVIDER_MODE_GROK_BUILD_PROXY => PROVIDER_MODE_GROK_BUILD_PROXY.to_string(),
        _ => PROVIDER_MODE_GENERIC.to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersListResult {
    pub providers: Vec<CustomProvider>,
    /// Legacy read of `[models].default` for the secrets mirror / Doctor display.
    /// A chat's route comes from its own stored provider, never from this key.
    pub default_model: Option<String>,
    pub config_path: String,
    pub agent_home: String,
    /// True when this call forced `session_data_mode` shared → independent so
    /// App-written agent-home `config.toml` is visible to the spawned agent (#557).
    #[serde(default)]
    pub switched_to_independent: bool,
}

/// Built-in model id used when routing back to official Grok Build / SuperGrok.
pub const OFFICIAL_DEFAULT_MODEL: &str = "grok";

/// Catalog model preferred for composer / official spawn when none is set.
pub const OFFICIAL_CATALOG_MODEL: &str = "grok-4.7";
/// Same model on faster Grok Build infrastructure. Twice the token price.
/// Not on the public xAI API — official catalog / spawn only, never relay presets.
pub const OFFICIAL_CATALOG_MODEL_FAST: &str = "grok-4.7-build-fast";
/// Previous official catalog id — still a valid official aux / spawn target.
pub const OFFICIAL_CATALOG_MODEL_46: &str = "grok-4.6";
/// Older official catalog id — still a valid official aux / spawn target.
pub const OFFICIAL_CATALOG_MODEL_LEGACY: &str = "grok-4.5";

pub fn is_official_catalog_model(id: &str) -> bool {
    matches!(
        id.trim(),
        OFFICIAL_CATALOG_MODEL
            | OFFICIAL_CATALOG_MODEL_FAST
            | OFFICIAL_CATALOG_MODEL_46
            | OFFICIAL_CATALOG_MODEL_LEGACY
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPingResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub endpoint: String,
    pub status: Option<u16>,
    pub error: Option<String>,
}

/// Result of a per-model connection probe (mirrors ZCode's connectivity test):
/// sends one tiny non-streaming inference request and reports success = HTTP 2xx.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub endpoint: String,
    pub status: Option<u16>,
    /// `auth` | `model_not_found` | `rate_limit` | `server` | `network` | `timeout` | `unknown`
    pub error_kind: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelsResult {
    pub endpoint: String,
    pub models: Vec<RemoteModel>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModel {
    pub id: String,
    pub owned_by: Option<String>,
    /// Capability advertised by the live `/models` response. `None` means the
    /// endpoint did not make a claim, which must not be treated as supported.
    pub supports_backend_search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_vision: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_video: Option<bool>,
    /// Structured reasoning ladder advertised by an extended `/models` row.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reasoning_efforts: Vec<ProviderEffortEntry>,
    /// Reasoning support advertised by an extended `/models` row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort: Option<bool>,
}

/// Process-only native Grok Build relay binding. Deliberately not Debug or
/// Serialize because it contains the provider key.
pub struct GrokBuildProxySpawn {
    pub base_url: String,
    pub models_url: String,
    pub api_key: String,
    pub model: String,
}

/// Whether an upsert must re-check its model rows against the live `/models`.
///
/// `models: None` keeps whatever catalog is on disk. When that catalog is
/// unreadable or explicitly empty it fixes no rows, so the channel `model` is
/// only a display guess: re-checking it would reject an unrelated name / key
/// edit even though the catalog did not change. `models: Some([])` is the
/// explicit clear; on an existing section it also fixes no rows, so the Host
/// writes the empty catalog without a request. A create has no section yet and
/// must still select a model, so it always hits the live gate. A non-empty
/// `Some(rows)` keeps the full capability check.
pub fn grok_build_proxy_upsert_needs_live_models(
    models: Option<&[ProviderModelEntry]>,
    stored_catalog: Option<&ModelCatalogRead>,
) -> bool {
    match models {
        Some([]) => stored_catalog.is_none(),
        Some(_) => true,
        None => match stored_catalog {
            Some(catalog) => !catalog_fixes_no_model_rows(catalog),
            None => true,
        },
    }
}

/// A stored catalog that fixes no rows: unreadable text, or an explicit clear.
/// Consumers must not substitute the channel `model` for it.
fn catalog_fixes_no_model_rows(catalog: &ModelCatalogRead) -> bool {
    match catalog {
        ModelCatalogRead::Stored(rows) => rows.is_empty(),
        ModelCatalogRead::Corrupt(_) => true,
        ModelCatalogRead::LegacyChannel => false,
    }
}

pub fn validate_grok_build_proxy_models(
    remote: &[RemoteModel],
    selected: &[ProviderModelEntry],
) -> Result<(), String> {
    if selected.is_empty() {
        return Err("grok_build_proxy requires at least one model".into());
    }
    let mut missing = Vec::new();
    let mut unsupported = Vec::new();
    for model in selected {
        let id = model.id.trim();
        if id.is_empty() {
            continue;
        }
        match remote.iter().find(|m| m.id == id) {
            None => missing.push(id.to_string()),
            Some(m) if m.supports_backend_search != Some(true) => unsupported.push(id.to_string()),
            Some(_) => {}
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "grok_build_proxy models missing from live /models: {}",
            missing.join(", ")
        ));
    }
    if !unsupported.is_empty() {
        return Err(format!(
            "grok_build_proxy requires supports_backend_search=true for: {}",
            unsupported.join(", ")
        ));
    }
    Ok(())
}

/// Parsed `[model.*]` section (shared with relay stream proxy).
#[derive(Debug, Clone)]
pub struct ModelSection {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub fields: std::collections::HashMap<String, String>,
}

type Section = ModelSection;

/// Unquote a TOML basic string written by [`quote`].
///
/// Must reverse `serde_json::to_string` escapes (`\"`, `\\`, …). A naive
/// strip of the outer quotes leaves `\"` in `app_models` / `app_efforts` JSON
/// so `serde_json::from_str` fails and the UI falls back to Grok defaults.
fn unquote(v: &str) -> String {
    let t = v.trim();
    if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
        if let Ok(s) = serde_json::from_str::<String>(t) {
            return s;
        }
        // Fallback: strip quotes only (legacy / malformed values).
        return t[1..t.len() - 1].to_string();
    }
    if t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2 {
        return t[1..t.len() - 1].to_string();
    }
    t.to_string()
}

fn quote(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| format!("\"{v}\""))
}

/// `[model.*]` keys Grok Build expects as bare TOML integers (not strings).
///
/// Writing `context_window = "1000000"` makes CLI reject the field
/// (`context_window invalid type: string`) and silently fall back to 200k.
/// See GitHub #538.
const TOML_INTEGER_FIELD_KEYS: &[&str] = &["context_window"];

/// Encode a `[model.*]` field value for agent-home `config.toml`.
///
/// Strings stay JSON-quoted; integer keys write bare digits so the CLI type
/// check matches native `~/.grok/config.toml` (CLI writes integers).
fn format_toml_field_value(key: &str, value: &str) -> String {
    if TOML_INTEGER_FIELD_KEYS.contains(&key) {
        let raw = unquote(value.trim());
        if let Ok(n) = raw.parse::<u64>() {
            return n.to_string();
        }
    }
    // CLI inline table / array of tables — never JSON-quote (Grok would treat
    // it as a string and ignore the effort menu).
    if key == EXTRA_HEADERS_KEY {
        let raw = value.trim();
        if raw.starts_with('{') {
            return raw.to_string();
        }
    }
    if key == CLI_REASONING_EFFORTS_KEY {
        let raw = value.trim();
        if raw.starts_with('[') {
            return raw.to_string();
        }
    }
    // App-managed bool flags: write bare `true` / `false` when clearly boolean.
    if key == APP_BASE_URL_FULL_PATH_KEY || key == SUPPORTS_REASONING_EFFORT_KEY {
        let raw = unquote(value.trim());
        match raw.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => return "true".into(),
            "false" | "0" | "no" | "off" => return "false".into(),
            _ => {}
        }
    }
    quote(value)
}

/// Rewrite quoted integer fields (`context_window = "1000000"` → bare int).
/// Idempotent; preserves comments and non-matching lines.
pub(crate) fn repair_quoted_integer_fields(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some(eq) = trimmed.find('=') {
                let key = trimmed[..eq].trim();
                if TOML_INTEGER_FIELD_KEYS.contains(&key) {
                    let val = trimmed[eq + 1..].trim();
                    let bare = unquote(val);
                    if bare.parse::<u64>().is_ok()
                        && (val.starts_with('"') || val.starts_with('\''))
                    {
                        let indent_len = line.len() - line.trim_start().len();
                        let indent = &line[..indent_len];
                        out.push_str(indent);
                        out.push_str(key);
                        out.push_str(" = ");
                        out.push_str(&bare);
                        out.push('\n');
                        changed = true;
                        continue;
                    }
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    if !changed {
        return text.to_string();
    }
    if text.ends_with('\n') {
        out
    } else {
        out.trim_end_matches('\n').to_string()
    }
}

/// If agent-home config has string-typed integer fields, rewrite and save.
/// Returns true when the file was modified.
pub fn ensure_model_integer_fields() -> Result<bool, String> {
    let _ = ensure_agent_home()?;
    let path = agent_config_toml();
    if !path.exists() {
        return Ok(false);
    }
    let text = read_text(&path);
    let repaired = repair_quoted_integer_fields(&text);
    if repaired == text {
        return Ok(false);
    }
    write_text(&path, &repaired)?;
    tracing::info!(
        target: "providers",
        "repaired quoted integer fields (e.g. context_window) in agent-home config.toml"
    );
    Ok(true)
}

/// Enable Grok Build's native effort forwarding for existing custom providers
/// that already expose effort choices in the App.
fn ensure_reasoning_effort_support_fields() -> Result<bool, String> {
    let _ = ensure_agent_home()?;
    let path = agent_config_toml();
    if !path.exists() {
        return Ok(false);
    }

    let text = read_text(&path);
    let sections = parse_model_sections(&text);
    let lines = config_lines(&text);
    let mut updates = Vec::new();
    let mut insertions = Vec::new();
    for section in sections {
        if !is_custom(&section.fields) {
            continue;
        }
        let channel_efforts = decode_app_efforts(
            section
                .fields
                .get(APP_EFFORTS_KEY)
                .map(std::string::String::as_str),
        );
        let fallback_model = section
            .fields
            .get("model")
            .map(String::as_str)
            .unwrap_or(section.id.as_str());
        let models = decode_app_models(
            section.fields.get(APP_MODELS_KEY).map(String::as_str),
            fallback_model,
            fallback_model,
        );
        let has_model_efforts = models.iter().any(|model| {
            model.supports_reasoning_effort == Some(true)
                || model.supports_reasoning_off == Some(true)
                || !model.efforts.is_empty()
        });
        if channel_efforts.is_empty() && !has_model_efforts {
            continue;
        }
        if section
            .fields
            .get(SUPPORTS_REASONING_EFFORT_KEY)
            .is_some_and(|value| parse_app_bool_field(Some(value)))
        {
            continue;
        }

        if section.fields.contains_key(SUPPORTS_REASONING_EFFORT_KEY) {
            if let Some(index) = (section.start + 1..section.end).find(|&i| {
                assignment_key_exact(lines[i].trim()) == Some(SUPPORTS_REASONING_EFFORT_KEY)
            }) {
                updates.push(index);
            }
        } else {
            let index = (section.start + 1..section.end)
                .find(|&i| assignment_key_exact(lines[i].trim()) == Some(APP_EFFORTS_KEY))
                .map_or(section.end, |i| i + 1);
            insertions.push(index);
        }
    }
    if updates.is_empty() && insertions.is_empty() {
        return Ok(false);
    }

    let mut lines: Vec<_> = lines.into_iter().map(str::to_owned).collect();
    for index in updates {
        lines[index] = format!("{SUPPORTS_REASONING_EFFORT_KEY} = true");
    }
    for index in insertions.into_iter().rev() {
        lines.insert(index, format!("{SUPPORTS_REASONING_EFFORT_KEY} = true"));
    }
    let mut repaired = lines.join("\n");
    if text.ends_with('\n') {
        repaired.push('\n');
    }
    write_text(&path, &repaired)?;
    tracing::info!(
        target: "providers",
        "enabled reasoning-effort forwarding for existing custom providers"
    );
    Ok(true)
}

/// Normalize an external provider id with the same rules used by provider writes.
pub fn sanitize_provider_id(raw: &str) -> Result<String, String> {
    sanitize_id(raw)
}

fn sanitize_id(raw: &str) -> Result<String, String> {
    let id = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if id.is_empty() || !id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) {
        return Err("provider id must start with a letter or digit".into());
    }
    Ok(id)
}

pub fn normalize_backend(v: Option<&str>) -> String {
    match v.unwrap_or("").trim() {
        "responses" => "responses".into(),
        "messages" => "messages".into(),
        _ => "chat_completions".into(),
    }
}

/// Parse App-managed boolean TOML string fields (`"true"` / `"1"` / …).
pub fn parse_app_bool_field(raw: Option<&str>) -> bool {
    match raw.map(str::trim).unwrap_or("") {
        "" => false,
        s => matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on"),
    }
}

/// Whether this provider section opts out of automatic `/v1` base_url repair.
pub fn base_url_full_path_from_fields(fields: &std::collections::HashMap<String, String>) -> bool {
    parse_app_bool_field(fields.get(APP_BASE_URL_FULL_PATH_KEY).map(|s| s.as_str()))
}

/// Whether the user marked this section as vision-capable.
pub fn supports_vision_from_fields(fields: &std::collections::HashMap<String, String>) -> bool {
    parse_app_bool_field(fields.get(APP_SUPPORTS_VISION_KEY).map(|s| s.as_str()))
}

/// Grok Build joins `{base_url}/chat/completions` (or `/responses`).
/// OpenAI-compatible relays almost always expect `…/v1` as the base.
/// Without it, requests hit `https://host/chat/completions` (404/HTML) and the
/// agent may retry for minutes with no user-visible progress.
///
/// When `full_path` is true (UI「完整路径」), only trim trailing slashes — used
/// for gateways that already expose a non-`/v1` root (e.g. Volcengine Ark
/// Coding Plan `…/api/coding` or `…/api/coding/v3`).
pub fn normalize_openai_base_url(raw: &str, api_backend: &str, full_path: bool) -> String {
    let mut base = raw.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return base;
    }
    if full_path {
        return base;
    }
    // Anthropic-style messages often use bare host or /v1 already; still prefer /v1.
    let lower = base.to_ascii_lowercase();
    let needs_v1 = matches!(
        api_backend,
        "chat_completions" | "responses" | "messages" | ""
    );
    if needs_v1
        && !lower.ends_with("/v1")
        && !lower.contains("/v1/")
        && !lower.ends_with("/chat/completions")
        && !lower.ends_with("/responses")
        && !lower.ends_with("/messages")
    {
        base.push_str("/v1");
    }
    base
}

/// One-shot repair: rewrite stored custom base_url values that omit /v1.
///
/// When the section is already pointed at the stream-sanitize loopback proxy,
/// normalize `app_upstream_base_url` instead of the local `base_url`.
pub fn repair_custom_base_urls() -> Result<bool, String> {
    let path = agent_config_toml();
    if !path.is_file() {
        return Ok(false);
    }
    let text = read_text(&path);
    let sections = parse_model_sections(&text);
    let mut changed = false;
    let mut out = text.clone();
    for s in sections {
        if !is_custom(&s.fields) {
            continue;
        }
        let backend = normalize_backend(s.fields.get("api_backend").map(|x| x.as_str()));
        // Full-path providers intentionally skip /v1 auto-repair.
        if base_url_full_path_from_fields(&s.fields) {
            continue;
        }
        let Some(old_base) = s.fields.get("base_url").cloned() else {
            continue;
        };
        let is_proxy = crate::relay_stream_proxy::is_local_sanitize_proxy_url(&old_base);
        let upstream_key = crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY;
        if is_proxy {
            // Fix real upstream if it lost /v1; leave loopback base_url alone.
            let Some(old_up) = s.fields.get(upstream_key).cloned() else {
                continue;
            };
            let new_up = normalize_openai_base_url(&old_up, &backend, false);
            if new_up == old_up.trim().trim_end_matches('/') || new_up == old_up {
                continue;
            }
            out = rewrite_section_base_urls(&out, &s.id, &old_base, Some(&new_up))?;
            changed = true;
            tracing::info!(
                target: "providers",
                id = %s.id,
                "repaired app_upstream_base_url to include /v1"
            );
            continue;
        }
        let new = normalize_openai_base_url(&old_base, &backend, false);
        if new != old_base.trim().trim_end_matches('/') && new != old_base {
            let keep_up = s.fields.get(upstream_key).map(|x| x.as_str());
            out = rewrite_section_base_urls(&out, &s.id, &new, keep_up)?;
            changed = true;
            tracing::info!(
                target: "providers",
                id = %s.id,
                "repaired base_url to include /v1"
            );
        }
    }
    if changed {
        // Preserve [models].default
        let def = get_models_default(&text);
        if let Some(d) = def {
            out = set_models_default(&out, &d);
        }
        write_text(&path, &out)?;
    }
    Ok(changed)
}

/// Parse all `[model.*]` sections (for stream-proxy repair / lookup).
pub fn parse_model_sections_for_proxy(text: &str) -> Vec<ModelSection> {
    parse_model_sections(text)
}

/// Update `base_url` and optional `app_upstream_base_url` while keeping other fields.
pub fn rewrite_section_base_urls(
    text: &str,
    id: &str,
    cli_base: &str,
    upstream: Option<&str>,
) -> Result<String, String> {
    let sections = parse_model_sections(text);
    let Some(s) = sections.iter().find(|x| x.id == id) else {
        return Err(format!("provider `{id}` not found"));
    };
    let upstream_key = crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY;
    // Stable-ish field order: known keys first, then the rest alphabetically.
    let preferred = [
        "model",
        "base_url",
        "name",
        "api_key",
        "api_backend",
        APP_MODELS_KEY,
        APP_EFFORTS_KEY,
        "context_window",
        upstream_key,
    ];
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut used = std::collections::HashSet::new();
    for k in preferred {
        if k == "base_url" {
            fields.push(("base_url".into(), cli_base.to_string()));
            used.insert("base_url".to_string());
            continue;
        }
        if k == upstream_key {
            if let Some(up) = upstream.map(str::trim).filter(|s| !s.is_empty()) {
                fields.push((upstream_key.into(), up.to_string()));
            }
            used.insert(upstream_key.to_string());
            continue;
        }
        if let Some(v) = s.fields.get(k) {
            if !v.is_empty() {
                fields.push((k.into(), v.clone()));
                used.insert(k.to_string());
            }
        }
    }
    let mut rest: Vec<_> = s
        .fields
        .iter()
        .filter(|(k, _)| !used.contains(k.as_str()) && *k != upstream_key)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    fields.extend(rest);
    if let Some(up) = upstream.map(str::trim).filter(|s| !s.is_empty()) {
        if !fields.iter().any(|(k, _)| k == upstream_key) {
            fields.push((upstream_key.into(), up.to_string()));
        }
    }
    let mut out = remove_section(text, id);
    out = append_section(&out, id, &fields);
    // Preserve [models].default if remove_section somehow touched it (it doesn't).
    Ok(out)
}

fn model_header(id: &str) -> String {
    if id
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    {
        format!("[model.{}]", quote(id))
    } else {
        format!("[model.{id}]")
    }
}

fn parse_model_header_id(trimmed: &str) -> Option<String> {
    // Same header rules as the config writer (`[model.id] # note`, quoted ids
    // that contain `]`). `strip_suffix(']')` misses a trailing comment, so
    // remove + append would leave the old section (and its `app_append_prompt`)
    // in place and the save would look like it did not stick.
    let (is_array, name) = crate::agent_home_config::parse_table_header(trimmed)?;
    if is_array {
        return None;
    }
    let rest = name.strip_prefix("model.")?;
    Some(unquote(rest).trim().to_string()).filter(|s| !s.is_empty())
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, text).map_err(|e| e.to_string())
}

/// Split config text into lines for section indexing.
///
/// Must match [`remove_section`]: use `str::lines()` (not `split('\n')`).
/// `split('\n')` keeps a trailing empty element when the file ends with `\n`,
/// so `end = lines.len()` would be one past what `lines()` produces and panic
/// on `drain(start..end)`.
fn config_lines(text: &str) -> Vec<&str> {
    text.lines().collect()
}

fn parse_model_sections(text: &str) -> Vec<Section> {
    let lines = config_lines(text);
    let mut sections = Vec::new();
    let mut cur: Option<Section> = None;
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if let Some(hid) = parse_model_header_id(trimmed) {
            if let Some(mut c) = cur.take() {
                c.end = i;
                sections.push(c);
            }
            cur = Some(Section {
                id: hid,
                start: i,
                end: lines.len(),
                fields: std::collections::HashMap::new(),
            });
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some(mut c) = cur.take() {
                c.end = i;
                sections.push(c);
            }
            continue;
        }
        if let Some(ref mut c) = cur {
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some(eq) = trimmed.find('=') {
                let key = trimmed[..eq].trim().to_string();
                let val = unquote(trimmed[eq + 1..].trim());
                c.fields.insert(key, val);
            }
        }
    }
    if let Some(c) = cur {
        sections.push(c);
    }
    sections
}

fn is_models_table_header(trimmed: &str) -> bool {
    matches!(
        crate::agent_home_config::parse_table_header(trimmed),
        Some((false, "models"))
    )
}

fn assignment_key_exact(trimmed: &str) -> Option<&str> {
    crate::agent_home_config::assignment_key(trimmed)
}

/// Legacy read of `[models].default` for the secrets mirror / Doctor display.
/// Kept because section rewrites must preserve the key as-is; no App code
/// activates a route or writes it for activation any more.
fn get_models_default(text: &str) -> Option<String> {
    let mut in_models = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if crate::agent_home_config::parse_table_header(trimmed).is_some() {
            in_models = is_models_table_header(trimmed);
            continue;
        }
        if !in_models || trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        // Exact key match — never starts_with("default") (would hit default_model).
        if assignment_key_exact(trimmed) == Some("default") {
            let eq = trimmed.find('=')?;
            return Some(unquote(trimmed[eq + 1..].trim()));
        }
    }
    None
}

fn set_models_default(text: &str, model_id: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let mut in_models = false;
    let mut models_start: Option<usize> = None;
    let line_val = format!("default = {}", quote(model_id));
    for i in 0..lines.len() {
        let trimmed = lines[i].trim().to_string();
        if crate::agent_home_config::parse_table_header(&trimmed).is_some() {
            if is_models_table_header(&trimmed) {
                in_models = true;
                models_start = Some(i);
            } else if in_models {
                lines.insert(i, line_val);
                return lines.join("\n");
            } else {
                in_models = false;
            }
            continue;
        }
        if in_models && assignment_key_exact(&trimmed) == Some("default") {
            lines[i] = line_val;
            return lines.join("\n");
        }
    }
    if let Some(start) = models_start {
        lines.insert(start + 1, line_val);
        return lines.join("\n");
    }
    let block = format!("\n[models]\ndefault = {}\n", quote(model_id));
    let base = text.trim_end();
    if base.is_empty() {
        block.trim_start().to_string()
    } else {
        format!("{base}{block}")
    }
}

fn remove_section(text: &str, id: &str) -> String {
    let sections = parse_model_sections(text);
    let Some(hit) = sections.iter().find(|s| s.id == id) else {
        return text.to_string();
    };
    // Same line basis as parse_model_sections (str::lines).
    let mut lines: Vec<String> = config_lines(text)
        .into_iter()
        .map(|s| s.to_string())
        .collect();
    let start = hit.start.min(lines.len());
    let end = hit.end.min(lines.len()).max(start);
    if start < end {
        lines.drain(start..end);
    }
    let joined = lines.join("\n");
    // collapse excess blank lines
    let mut out = String::new();
    let mut blanks = 0;
    for line in joined.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks <= 2 {
                out.push('\n');
            }
        } else {
            blanks = 0;
            out.push_str(line);
            out.push('\n');
        }
    }
    // Preserve trailing newline if original file had one (common for config.toml).
    if text.ends_with('\n') && !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    out
}

fn append_section(text: &str, id: &str, fields: &[(String, String)]) -> String {
    let body = render_section_body(fields);
    let block = format!("\n{}\n{body}\n", model_header(id));
    let base = text.trim_end();
    if base.is_empty() {
        block.trim_start().to_string()
    } else {
        format!("{base}\n{block}")
    }
}

/// Keys whose blank value is still written as `key = ""`.
///
/// A blank `app_models` is a legacy provider, but an edit that omits `models`
/// must not turn a present field into a missing one.
const PRESERVED_BLANK_FIELD_KEYS: &[&str] = &[APP_MODELS_KEY];

fn render_section_body(fields: &[(String, String)]) -> String {
    fields
        .iter()
        .filter(|(k, v)| !v.is_empty() || PRESERVED_BLANK_FIELD_KEYS.contains(&k.as_str()))
        .map(|(k, v)| format!("{k} = {}", format_toml_field_value(k, v)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_section_block(id: &str, fields: &[(String, String)]) -> String {
    format!("{}\n{}", model_header(id), render_section_body(fields))
}

/// Replace `[model.<id>]` in place, or append it. A matching block is left
/// byte-for-byte so a second pass does not move comments or neighboring sections.
fn replace_or_append_section(text: &str, id: &str, fields: &[(String, String)]) -> String {
    let rendered = render_section_block(id, fields);
    let sections = parse_model_sections(text);
    let Some(hit) = sections.iter().find(|s| s.id == id) else {
        return append_section(text, id, fields);
    };
    let lines = config_lines(text);
    let existing = lines
        .get(hit.start..hit.end)
        .unwrap_or(&[])
        .join("\n")
        .trim_end()
        .to_string();
    if existing == rendered.trim_end() {
        return text.to_string();
    }
    let mut out_lines: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i == hit.start {
            out_lines.extend(rendered.split('\n').map(str::to_string));
        }
        if i >= hit.start && i < hit.end {
            continue;
        }
        out_lines.push((*line).to_string());
    }
    let mut out = out_lines.join("\n");
    if text.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn stable_suffix(s: &str) -> String {
    let mut h: u32 = 2_166_136_261;
    for b in s.as_bytes() {
        h ^= u32::from(*b);
        h = h.wrapping_mul(16_777_619);
    }
    format!("{h:08x}")
}

/// TOML-bare slug for an upstream model id. Dots, slashes, and spaces become
/// `-`. Case is kept so `GLM-A` and `glm-a` do not share a section.
pub fn slug_model_id(model_id: &str) -> String {
    let mut raw = String::new();
    let mut prev_dash = false;
    for c in model_id.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            raw.push(c);
            prev_dash = c == '-';
        } else if !prev_dash && !raw.is_empty() {
            raw.push('-');
            prev_dash = true;
        }
    }
    let raw = raw.trim_matches('-');
    let raw = if raw.is_empty() { "model" } else { raw };
    const MAX: usize = 48;
    if raw.len() <= MAX {
        return raw.to_string();
    }
    let hash = stable_suffix(model_id);
    let keep = MAX.saturating_sub(7).min(raw.len());
    let mut end = keep;
    while end > 0 && raw.as_bytes()[end - 1] == b'-' {
        end -= 1;
    }
    if end == 0 {
        return format!("m-{}", &hash[..6]);
    }
    format!("{}-{}", &raw[..end], &hash[..6])
}

/// `[model.<providerId>__<slug>]` for one generic catalog row.
pub fn generic_model_section_id(provider_id: &str, model_id: &str) -> String {
    format!("{}__{}", provider_id.trim(), slug_model_id(model_id))
}

/// One generic catalog row and the TOML section `session/set_model` must name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenericSectionBinding {
    pub section_id: String,
    pub model_id: String,
}

fn assign_generic_sections(
    provider_id: &str,
    models: &[ProviderModelEntry],
    foreign_ids: &std::collections::HashSet<String>,
    existing_by_model: &std::collections::HashMap<String, String>,
) -> Vec<GenericSectionBinding> {
    let mut used = foreign_ids.clone();
    let mut out = Vec::with_capacity(models.len());
    for model in models {
        if let Some(id) = existing_by_model.get(&model.id) {
            if !used.contains(id) {
                used.insert(id.clone());
                out.push(GenericSectionBinding {
                    section_id: id.clone(),
                    model_id: model.id.clone(),
                });
                continue;
            }
        }
        let base = generic_model_section_id(provider_id, &model.id);
        let mut candidate = base.clone();
        if used.contains(&candidate) {
            let mut n = 2u32;
            loop {
                candidate = format!("{base}-{n}");
                if !used.contains(&candidate) {
                    break;
                }
                n += 1;
                if n > 50 {
                    candidate = format!("{base}-{}", &stable_suffix(&model.id)[..6]);
                    break;
                }
            }
        }
        used.insert(candidate.clone());
        out.push(GenericSectionBinding {
            section_id: candidate,
            model_id: model.id.clone(),
        });
    }
    out
}

fn is_generic_parent(section: &Section) -> bool {
    if !is_custom(&section.fields) {
        return false;
    }
    if section
        .fields
        .get(APP_PARENT_PROVIDER_KEY)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }
    normalize_provider_mode(
        section
            .fields
            .get(APP_PROVIDER_MODE_KEY)
            .map(|s| s.as_str()),
    ) != PROVIDER_MODE_GROK_BUILD_PROXY
}

/// Channel `app_efforts` may back a legacy single-model catalog only.
fn single_model_channel_efforts(
    parent: &Section,
    models: &[ProviderModelEntry],
) -> Option<Vec<ProviderEffortEntry>> {
    let model = models.first().filter(|_| models.len() == 1)?;
    if parent
        .fields
        .get("model")
        .map(String::as_str)
        .map(str::trim)
        != Some(model.id.trim())
    {
        return None;
    }
    let efforts = decode_app_efforts(parent.fields.get(APP_EFFORTS_KEY).map(String::as_str));
    (!efforts.is_empty()).then_some(efforts)
}

fn generic_child_fields(
    parent: &Section,
    model: &ProviderModelEntry,
    parent_id: &str,
    channel_efforts: Option<&[ProviderEffortEntry]>,
) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = Vec::new();
    fields.push(("model".into(), model.id.clone()));
    if let Some(v) = parent.fields.get("base_url") {
        fields.push(("base_url".into(), v.clone()));
    }
    let display = model.name.trim();
    let display = if display.is_empty() {
        model.id.as_str()
    } else {
        display
    };
    fields.push(("name".into(), display.to_string()));
    if let Some(v) = parent.fields.get("api_key") {
        fields.push(("api_key".into(), v.clone()));
    }
    let backend = parent
        .fields
        .get("api_backend")
        .cloned()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "chat_completions".into());
    fields.push(("api_backend".into(), backend));
    let window = model.context_window.filter(|n| *n > 0).or_else(|| {
        parent
            .fields
            .get("context_window")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0)
    });
    if let Some(n) = window {
        fields.push(("context_window".into(), n.to_string()));
    }
    if let Some(v) = parent
        .fields
        .get(EXTRA_HEADERS_KEY)
        .filter(|s| !s.trim().is_empty())
    {
        fields.push((EXTRA_HEADERS_KEY.into(), v.clone()));
    }
    if let Some(v) = parent.fields.get(SUPPORTS_REASONING_EFFORT_KEY) {
        fields.push((SUPPORTS_REASONING_EFFORT_KEY.into(), v.clone()));
    }
    if let Some(efforts) = cli_efforts_for_model(model, channel_efforts) {
        let raw = encode_cli_reasoning_efforts(&efforts);
        if !raw.is_empty() {
            fields.push((CLI_REASONING_EFFORTS_KEY.into(), raw));
        }
    }
    fields.push((APP_PROVIDER_MODE_KEY.into(), PROVIDER_MODE_GENERIC.into()));
    fields.push((APP_PARENT_PROVIDER_KEY.into(), parent_id.to_string()));

    const MANAGED: &[&str] = &[
        "model",
        "base_url",
        "name",
        "api_key",
        "api_backend",
        "context_window",
        EXTRA_HEADERS_KEY,
        SUPPORTS_REASONING_EFFORT_KEY,
        CLI_REASONING_EFFORTS_KEY,
        APP_PROVIDER_MODE_KEY,
        APP_PARENT_PROVIDER_KEY,
        APP_MODELS_KEY,
        APP_EFFORTS_KEY,
        APP_APPEND_PROMPT_KEY,
        APP_SUPPORTS_VISION_KEY,
        APP_BASE_URL_FULL_PATH_KEY,
    ];
    let mut rest: Vec<(String, String)> = parent
        .fields
        .iter()
        .filter(|(k, v)| !v.is_empty() && !MANAGED.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    fields.extend(rest);
    fields
}

/// Channel route fields a generic child mirrors from its parent.
///
/// A parent value that is missing or blank drops the child's copy: those keys
/// belong to the channel, so keeping a stale endpoint or key there would make
/// old sessions talk to the previous upstream.
const CHILD_CHANNEL_KEYS: &[&str] = &[
    "base_url",
    "api_key",
    "api_backend",
    EXTRA_HEADERS_KEY,
    SUPPORTS_REASONING_EFFORT_KEY,
    crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY,
];

/// Rebuild one existing child's fields: channel route fields follow the parent,
/// while the section keeps its own `model` / `name` / `context_window` and any
/// model-only or unknown key.
fn refreshed_child_fields(
    parent: &Section,
    child: &Section,
    parent_id: &str,
    model: Option<&ProviderModelEntry>,
    channel_efforts: Option<&[ProviderEffortEntry]>,
) -> Vec<(String, String)> {
    let own = |key: &str| {
        child
            .fields
            .get(key)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let channel = |key: &str| {
        parent
            .fields
            .get(key)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    // Same order as `generic_child_fields`, so an already synced child keeps its
    // bytes and a second pass writes nothing.
    let mut fields: Vec<(String, String)> = Vec::new();
    if let Some(v) = own("model") {
        fields.push(("model".into(), v));
    }
    if let Some(v) = channel("base_url") {
        fields.push(("base_url".into(), v));
    }
    if let Some(v) = own("name") {
        fields.push(("name".into(), v));
    }
    if let Some(v) = channel("api_key") {
        fields.push(("api_key".into(), v));
    }
    fields.push((
        "api_backend".into(),
        channel("api_backend").unwrap_or_else(|| "chat_completions".into()),
    ));
    if let Some(v) = own("context_window") {
        fields.push(("context_window".into(), v));
    }
    for key in [EXTRA_HEADERS_KEY, SUPPORTS_REASONING_EFFORT_KEY] {
        if let Some(v) = channel(key) {
            fields.push((key.into(), v));
        }
    }
    if let Some(efforts) = model.and_then(|model| cli_efforts_for_model(model, channel_efforts)) {
        let raw = encode_cli_reasoning_efforts(&efforts);
        if !raw.is_empty() {
            fields.push((CLI_REASONING_EFFORTS_KEY.into(), raw));
        }
    } else if let Some(v) = own(CLI_REASONING_EFFORTS_KEY) {
        fields.push((CLI_REASONING_EFFORTS_KEY.into(), v));
    }
    fields.push((APP_PROVIDER_MODE_KEY.into(), PROVIDER_MODE_GENERIC.into()));
    fields.push((APP_PARENT_PROVIDER_KEY.into(), parent_id.to_string()));
    if let Some(v) = channel(crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY) {
        fields.push((
            crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY.into(),
            v,
        ));
    }

    let mut handled: std::collections::HashSet<&str> = CHILD_CHANNEL_KEYS.iter().copied().collect();
    handled.extend([
        "model",
        "name",
        "context_window",
        CLI_REASONING_EFFORTS_KEY,
        APP_PROVIDER_MODE_KEY,
        APP_PARENT_PROVIDER_KEY,
    ]);
    let mut rest: Vec<(String, String)> = child
        .fields
        .iter()
        .filter(|(k, v)| !v.is_empty() && !handled.contains(k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    fields.extend(rest);
    fields
}

/// Refresh channel route fields on the children that already exist.
///
/// Used when the parent has no readable model rows (corrupt `app_models` or an
/// explicit `app_models = "[]"`): the sections stay because older chats select
/// those ids, but their key / endpoint / backend must not lag behind the
/// channel. No child is created or removed here, and the channel `model` row is
/// never used to guess a catalog.
fn refresh_child_channel_fields(text: &str, parent: &Section, parent_id: &str) -> String {
    let children: Vec<Section> = parse_model_sections(text)
        .into_iter()
        .filter(|s| {
            s.fields
                .get(APP_PARENT_PROVIDER_KEY)
                .is_some_and(|p| p == parent_id)
        })
        .collect();
    let mut text = text.to_string();
    for child in children {
        let fields = refreshed_child_fields(parent, &child, parent_id, None, None);
        text = replace_or_append_section(&text, &child.id, &fields);
    }
    text
}

/// Give every row recovered from a partially invalid `app_models` the child
/// section that `--model` and `session/set_model` resolve.
///
/// `providers_list` exposes those rows, so a row without a section made the
/// picker's model fall back to the channel section and send the wrong upstream
/// model. Existing children keep their id, `model`, `name`, `context_window`,
/// and unknown keys; only channel route fields follow the parent. Children the
/// corrupt text does not name stay for older chats. Never rewrites the
/// catalog: `app_models` remains the original corrupt text.
fn ensure_recovered_child_sections(
    text: &str,
    parent: &Section,
    parent_id: &str,
    recovered_rows: &[ProviderModelEntry],
) -> String {
    let mut text = refresh_child_channel_fields(text, parent, parent_id);
    let sections = parse_model_sections(&text);
    let children: Vec<Section> = sections
        .iter()
        .filter(|s| {
            s.fields
                .get(APP_PARENT_PROVIDER_KEY)
                .is_some_and(|p| p == parent_id)
        })
        .cloned()
        .collect();
    let foreign_ids: std::collections::HashSet<String> = sections
        .iter()
        .filter(|s| {
            !s.fields
                .get(APP_PARENT_PROVIDER_KEY)
                .is_some_and(|p| p == parent_id)
        })
        .map(|s| s.id.clone())
        .collect();
    let mut existing_by_model = std::collections::HashMap::new();
    for child in &children {
        if let Some(model_id) = child.fields.get("model").filter(|s| !s.is_empty()) {
            existing_by_model
                .entry(model_id.clone())
                .or_insert_with(|| child.id.clone());
        }
    }
    let assigned =
        assign_generic_sections(parent_id, recovered_rows, &foreign_ids, &existing_by_model);
    for binding in &assigned {
        let Some(model) = recovered_rows.iter().find(|m| m.id == binding.model_id) else {
            continue;
        };
        let channel_efforts = single_model_channel_efforts(parent, recovered_rows);
        let fields = match children.iter().find(|c| c.id == binding.section_id) {
            Some(child) => refreshed_child_fields(
                parent,
                child,
                parent_id,
                Some(model),
                channel_efforts.as_deref(),
            ),
            None => generic_child_fields(parent, model, parent_id, channel_efforts.as_deref()),
        };
        text = replace_or_append_section(&text, &binding.section_id, &fields);
    }
    text
}

fn sync_parent_children(text: &str, parent_id: &str) -> String {
    let sections = parse_model_sections(text);
    let Some(parent) = sections.iter().find(|s| s.id == parent_id).cloned() else {
        return text.to_string();
    };
    let model_fallback = parent.fields.get("model").cloned().unwrap_or_default();
    // Missing / legacy rows display their request id, never the channel name;
    // `providers_list` and the child sections must show the same label.
    let models = match read_model_catalog(parent.fields.get(APP_MODELS_KEY).map(|s| s.as_str())) {
        ModelCatalogRead::Stored(rows) => rows,
        ModelCatalogRead::LegacyChannel => legacy_model_catalog(&model_fallback, &model_fallback),
        // A partially valid array still names selectable rows in
        // `providers_list`, so each recovered row needs a section the CLI can
        // route. The stored text stays untouched, and children it does not name
        // stay for older chats.
        ModelCatalogRead::Corrupt(corruption) if !corruption.recovered_rows.is_empty() => {
            return ensure_recovered_child_sections(
                text,
                &parent,
                parent_id,
                &corruption.recovered_rows,
            )
        }
        // Unreadable: the legacy row is only a display guess, not the stored
        // catalog. Rewriting children from it would drop sections that an older
        // session still references.
        ModelCatalogRead::Corrupt(_) => {
            return refresh_child_channel_fields(text, &parent, parent_id)
        }
    };
    if models.is_empty() {
        // `app_models = "[]"` is an explicit clear. Keep existing child sections:
        // old chats still reference those section ids, and re-seeding rows from
        // the channel `model` would undo the clear.
        return refresh_child_channel_fields(text, &parent, parent_id);
    }
    let children: Vec<Section> = sections
        .iter()
        .filter(|s| {
            s.fields
                .get(APP_PARENT_PROVIDER_KEY)
                .is_some_and(|p| p == parent_id)
        })
        .cloned()
        .collect();
    let foreign_ids: std::collections::HashSet<String> = sections
        .iter()
        .filter(|s| {
            !s.fields
                .get(APP_PARENT_PROVIDER_KEY)
                .is_some_and(|p| p == parent_id)
        })
        .map(|s| s.id.clone())
        .collect();
    let mut existing_by_model = std::collections::HashMap::new();
    for child in &children {
        if let Some(model_id) = child.fields.get("model").filter(|s| !s.is_empty()) {
            existing_by_model
                .entry(model_id.clone())
                .or_insert_with(|| child.id.clone());
        }
    }
    let assigned = assign_generic_sections(parent_id, &models, &foreign_ids, &existing_by_model);
    let keep: std::collections::HashSet<String> =
        assigned.iter().map(|b| b.section_id.clone()).collect();
    let mut text = text.to_string();
    for child in &children {
        if !keep.contains(&child.id) {
            text = remove_section(&text, &child.id);
        }
    }
    for binding in &assigned {
        let Some(model) = models.iter().find(|m| m.id == binding.model_id) else {
            continue;
        };
        let channel_efforts = single_model_channel_efforts(&parent, &models);
        let fields = generic_child_fields(&parent, model, parent_id, channel_efforts.as_deref());
        text = replace_or_append_section(&text, &binding.section_id, &fields);
    }
    text
}

fn drop_orphan_model_sections(text: &str) -> String {
    let sections = parse_model_sections(text);
    let parents: std::collections::HashSet<String> = sections
        .iter()
        .filter(|s| is_generic_parent(s))
        .map(|s| s.id.clone())
        .collect();
    let orphans: Vec<String> = sections
        .iter()
        .filter(|s| {
            s.fields
                .get(APP_PARENT_PROVIDER_KEY)
                .map(|p| !p.trim().is_empty() && !parents.contains(p.trim()))
                .unwrap_or(false)
        })
        .map(|s| s.id.clone())
        .collect();
    let mut text = text.to_string();
    for id in orphans {
        text = remove_section(&text, &id);
    }
    text
}

/// Give every generic catalog row its own `[model.<provider>__<slug>]` section.
///
/// The parent section stays the channel (settings, `[models].default`,
/// `app_models`). Child sections are what `session/set_model` names, so two
/// chats can send different upstream models without rewriting the shared
/// `model` field (#1337, #1394). Proxy channels are left alone. A second call
/// on an already-synced file returns the same text. Hand-written sections that
/// lack `app_parent_provider` are not rewritten.
pub fn sync_generic_model_sections_in_text(text: &str) -> String {
    let parent_ids: Vec<String> = parse_model_sections(text)
        .into_iter()
        .filter(is_generic_parent)
        .map(|s| s.id)
        .collect();
    let mut text = text.to_string();
    for id in parent_ids {
        text = sync_parent_children(&text, &id);
    }
    drop_orphan_model_sections(&text)
}

/// Write per-model sections into App agent-home only. Never touches `~/.grok`.
fn ensure_generic_model_sections() -> Result<(), String> {
    let path = agent_config_toml();
    let text = read_text(&path);
    let next = sync_generic_model_sections_in_text(&text);
    if next != text {
        write_text(&path, &next)?;
        let _ = ensure_custom_ids_in_allowed_models();
    }
    Ok(())
}

fn generic_sections_for_provider(provider_id: &str) -> Vec<GenericSectionBinding> {
    let text = read_text(&agent_config_toml());
    parse_model_sections(&text)
        .into_iter()
        .filter(|s| {
            s.fields
                .get(APP_PARENT_PROVIDER_KEY)
                .is_some_and(|p| p == provider_id)
        })
        .filter_map(|s| {
            let model_id = s.fields.get("model")?.trim();
            if model_id.is_empty() {
                return None;
            }
            Some(GenericSectionBinding {
                section_id: s.id,
                model_id: model_id.to_string(),
            })
        })
        .collect()
}

fn is_custom(fields: &std::collections::HashMap<String, String>) -> bool {
    fields
        .get("base_url")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

fn encode_app_models(models: &[ProviderModelEntry]) -> Result<String, String> {
    encode_model_catalog(models).map_err(|error| format!("failed to encode app_models: {error}"))
}

/// Keep only the three provenance markers the App writes. Unknown values are
/// ignored: an existing non-empty value is then treated as user-set, which can
/// never cause a refresh to overwrite it.
fn normalize_model_source(raw: Option<&str>) -> Option<&'static str> {
    match raw?.trim().to_ascii_lowercase().as_str() {
        MODEL_SOURCE_USER => Some(MODEL_SOURCE_USER),
        MODEL_SOURCE_REMOTE => Some(MODEL_SOURCE_REMOTE),
        MODEL_SOURCE_FALLBACK => Some(MODEL_SOURCE_FALLBACK),
        _ => None,
    }
}

fn model_source_for_value(raw: Option<&str>, has_value: bool) -> Option<String> {
    has_value.then(|| {
        normalize_model_source(raw)
            .unwrap_or(MODEL_SOURCE_USER)
            .to_string()
    })
}

/// Normalize a models catalog; drop empty ids; default blank names to id.
pub fn normalize_provider_models(models: &[ProviderModelEntry]) -> Vec<ProviderModelEntry> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in models {
        let id = m.id.trim().to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let name = m.name.trim();
        let context_window = m.context_window.filter(|n| *n > 0);
        let efforts = normalize_provider_efforts(&m.efforts);
        let efforts_source =
            model_source_for_value(m.efforts_source.as_deref(), !efforts.is_empty());
        out.push(ProviderModelEntry {
            name: if name.is_empty() {
                id.clone()
            } else {
                name.to_string()
            },
            id,
            context_window,
            context_window_source: model_source_for_value(
                m.context_window_source.as_deref(),
                context_window.is_some(),
            ),
            supports_vision: m.supports_vision,
            supports_video: m.supports_video,
            efforts,
            efforts_source,
            supports_reasoning_effort: m.supports_reasoning_effort,
            supports_reasoning_effort_source: model_source_for_value(
                m.supports_reasoning_effort_source.as_deref(),
                m.supports_reasoning_effort.is_some(),
            ),
            supports_reasoning_off: m.supports_reasoning_off,
        });
    }
    out
}

fn decode_app_models(
    raw: Option<&str>,
    fallback_model: &str,
    fallback_display: &str,
) -> Vec<ProviderModelEntry> {
    resolve_model_catalog(raw, fallback_model, fallback_display)
}

/// Ensure `active_model` is in `models`; pick first when missing.
fn resolve_active_model(models: &[ProviderModelEntry], preferred: &str) -> String {
    let pref = preferred.trim();
    if !pref.is_empty() && models.iter().any(|m| m.id == pref) {
        return pref.to_string();
    }
    models
        .first()
        .map(|m| m.id.clone())
        .unwrap_or_else(|| pref.to_string())
}

fn encode_app_efforts(efforts: &[ProviderEffortEntry]) -> String {
    serde_json::to_string(efforts).unwrap_or_else(|_| "[]".into())
}

/// Canonical wire effort Grok Build accepts for an App-owned option id.
///
/// CLI 1.x validates `model.<id>.reasoning_efforts[].value` against its fixed
/// tier list, so a provider-only id such as `instant` must map to the nearest
/// tier; the menu keeps the raw id as the option `id`.
fn canonical_wire_effort(id: &str) -> &'static str {
    match id.trim().to_ascii_lowercase().as_str() {
        "none" | "off" | "disabled" | "disable" => "none",
        "minimal" | "minimum" | "instant" | "fastest" => "minimal",
        "low" | "fast" | "light" => "low",
        "high" | "deep" | "think" | "thinking" => "high",
        "xhigh" | "extra-high" | "extra_high" => "xhigh",
        "max" | "maximum" | "ultra" => "max",
        _ => "medium",
    }
}

/// TOML inline array of tables for Grok Build's `model.<id>.reasoning_efforts`.
///
/// `id` is the raw Composer option the App passes to `--reasoning-effort`;
/// `value` is the canonical tier the CLI maps it to.
fn encode_cli_reasoning_efforts(efforts: &[ProviderEffortEntry]) -> String {
    if efforts.is_empty() {
        return String::new();
    }
    let rows: Vec<String> = efforts
        .iter()
        .map(|effort| {
            let id = effort.id.trim();
            format!(
                "{{ id = {}, value = {}, label = {}, default = {} }}",
                quote(id),
                quote(canonical_wire_effort(id)),
                quote(effort.name.trim()),
                effort.is_default
            )
        })
        .collect();
    format!("[{}]", rows.join(", "))
}

/// Normalize efforts: unique ids, blank names → id.
pub fn normalize_provider_efforts(efforts: &[ProviderEffortEntry]) -> Vec<ProviderEffortEntry> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut any_default = false;
    for e in efforts {
        let id = e.id.trim().to_string();
        if !crate::acp_client::is_spawnable_reasoning_effort(&id) || !seen.insert(id.clone()) {
            continue;
        }
        let name = e.name.trim();
        let is_default = e.is_default && !any_default;
        if is_default {
            any_default = true;
        }
        out.push(ProviderEffortEntry {
            name: if name.is_empty() {
                id.clone()
            } else {
                name.to_string()
            },
            id,
            is_default,
        });
    }
    out
}

fn decode_app_efforts(raw: Option<&str>) -> Vec<ProviderEffortEntry> {
    if let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(list) = serde_json::from_str::<Vec<ProviderEffortEntry>>(s) {
            return normalize_provider_efforts(&list);
        }
    }
    Vec::new()
}

fn ensure_agent_home() -> Result<PathBuf, String> {
    ensure_app_dirs().map_err(|e| e.to_string())?;
    let home = agent_home_dir();
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    Ok(home)
}

/// Migrate legacy single-slot secrets.relay_* into config.toml once.
pub fn maybe_migrate_legacy_relay(
    relay_base: Option<&str>,
    relay_key: Option<&str>,
    default_model: Option<&str>,
) -> Result<(), String> {
    let base = relay_base.map(str::trim).filter(|s| !s.is_empty());
    let key = relay_key.map(str::trim).filter(|s| !s.is_empty());
    let (Some(base), Some(key)) = (base, key) else {
        return Ok(());
    };
    let list = list_custom_providers()?;
    if !list.providers.is_empty() {
        return Ok(());
    }
    let model = default_model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(OFFICIAL_CATALOG_MODEL);
    let _ = upsert_custom_provider(UpsertProviderInput {
        id: "relay".into(),
        model: model.into(),
        base_url: base.into(),
        name: Some("Imported relay".into()),
        api_key: Some(key.into()),
        api_backend: Some("responses".into()),
        provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
        create_only: Some(true),
        models: None,
        efforts: None,
        context_window: None,
        base_url_full_path: None,
        append_prompt: None,
        supports_vision: None,
        extra_headers: None,
    })?;
    Ok(())
}

/// Cap CLI transport retries for flaky custom relays / 中转.
/// Host circuit-breaks at [`crate::acp_client::HOST_PROVIDER_MAX_RETRIES`].
pub const PROVIDER_MAX_RETRIES: u32 = 12;

/// Ensure `[models] max_retries` is at least [`PROVIDER_MAX_RETRIES`].
/// Never *lower* a user-raised value; only bump when missing or too small.
pub fn ensure_models_retry_cap() -> Result<(), String> {
    let _ = ensure_agent_home()?;
    let path = agent_config_toml();
    let text = read_text(&path);
    let current = read_models_u32_field(&text, "max_retries");
    if current.is_some_and(|n| n >= PROVIDER_MAX_RETRIES) {
        return Ok(());
    }
    let next = set_models_u32_field(&text, "max_retries", PROVIDER_MAX_RETRIES);
    if next != text {
        write_text(&path, &next)?;
        tracing::info!(
            target: "providers",
            "set [models].max_retries = {PROVIDER_MAX_RETRIES}"
        );
    }
    Ok(())
}

/// Read a u32 field under `[models]` if present (not under `[models.*]`).
fn read_models_u32_field(text: &str, key: &str) -> Option<u32> {
    let mut in_models = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if crate::agent_home_config::parse_table_header(trimmed).is_some() {
            // Only the root `[models]` table — not `[models.foo]` sections.
            in_models = is_models_table_header(trimmed);
            continue;
        }
        if !in_models {
            continue;
        }
        if assignment_key_exact(trimmed) != Some(key) {
            continue;
        }
        let eq = trimmed.find('=')?;
        let raw = trimmed[eq + 1..]
            .trim()
            .trim_matches('"')
            .trim_matches('\'');
        if let Ok(n) = raw.parse::<u32>() {
            return Some(n);
        }
    }
    None
}

fn set_models_u32_field(text: &str, key: &str, value: u32) -> String {
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let mut in_models = false;
    let mut models_start: Option<usize> = None;
    let line_val = format!("{key} = {value}");
    for i in 0..lines.len() {
        let trimmed = lines[i].trim().to_string();
        if crate::agent_home_config::parse_table_header(&trimmed).is_some() {
            if is_models_table_header(&trimmed) {
                in_models = true;
                models_start = Some(i);
            } else if in_models {
                lines.insert(i, line_val);
                return lines.join("\n");
            } else {
                in_models = false;
            }
            continue;
        }
        // Exact key match — never starts_with(key) (would hit max_retries_extra).
        if in_models && assignment_key_exact(&trimmed) == Some(key) {
            lines[i] = line_val;
            return lines.join("\n");
        }
    }
    if let Some(start) = models_start {
        lines.insert(start + 1, line_val);
        return lines.join("\n");
    }
    let block = format!("\n[models]\n{key} = {value}\n");
    let base = text.trim_end();
    if base.is_empty() {
        block.trim_start().to_string()
    } else {
        format!("{base}{block}")
    }
}

/// If agent-home `[models].allowed_models` already exists, add every custom
/// section id those patterns do not cover. Never creates the key, and never
/// reads or writes shared `~/.grok` — the path is always App `agent-home`.
pub fn ensure_custom_ids_in_allowed_models() -> Result<(), String> {
    let _ = ensure_agent_home()?;
    let path = agent_config_toml();
    let text = read_text(&path);
    let ids = custom_section_ids(&text);
    let Some(next) = union_custom_ids_into_allowed_models(&text, &ids) else {
        return Ok(());
    };
    if next != text {
        write_text(&path, &next)?;
        tracing::info!(
            target: "providers",
            "added custom section ids to existing [models].allowed_models"
        );
    }
    Ok(())
}

fn custom_section_ids(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = parse_model_sections(text)
        .into_iter()
        .filter(|section| is_custom(&section.fields))
        .map(|section| section.id)
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// `Some(rewritten)` when the existing allowlist gained ids.
/// `None` when the key is absent, already covers every id, or the value is
/// not a string array we can rewrite without guessing.
pub(crate) fn union_custom_ids_into_allowed_models(text: &str, ids: &[String]) -> Option<String> {
    let (start, end) = allowed_models_array_span(text)?;
    let patterns = parse_toml_string_array(&text[start..end])?;
    let mut missing: Vec<String> = ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .filter(|id| {
            !patterns
                .iter()
                .any(|pattern| allowed_model_pattern_covers(pattern, id))
        })
        .map(str::to_string)
        .collect();
    missing.sort();
    missing.dedup();
    if missing.is_empty() {
        return None;
    }
    let mut combined = patterns;
    combined.extend(missing);
    let rendered = render_toml_string_array(&combined);
    let mut out = String::with_capacity(text.len() + rendered.len());
    out.push_str(&text[..start]);
    out.push_str(&rendered);
    out.push_str(&text[end..]);
    Some(out)
}

fn render_toml_string_array(items: &[String]) -> String {
    let body = items
        .iter()
        .map(|item| quote(item))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{body}]")
}

/// Full-string glob: `*` is any run (including empty), `?` is one byte.
fn allowed_model_pattern_covers(pattern: &str, id: &str) -> bool {
    fn rec(pat: &[u8], text: &[u8]) -> bool {
        let mut pi = 0;
        let mut ti = 0;
        while pi < pat.len() {
            if pat[pi] == b'*' {
                if rec(&pat[pi + 1..], &text[ti..]) {
                    return true;
                }
                if ti >= text.len() {
                    return false;
                }
                ti += 1;
                continue;
            }
            if ti >= text.len() {
                return false;
            }
            if pat[pi] != b'?' && pat[pi] != text[ti] {
                return false;
            }
            pi += 1;
            ti += 1;
        }
        ti == text.len()
    }
    rec(pattern.as_bytes(), id.as_bytes())
}

/// Byte span of the `[models].allowed_models` array, including brackets.
fn allowed_models_array_span(text: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut in_models = false;
    let mut i = 0;
    while i < text.len() {
        let line_end = text[i..].find('\n').map(|n| i + n).unwrap_or(text.len());
        let line = &text[i..line_end];
        let trimmed = line.trim();
        if crate::agent_home_config::parse_table_header(trimmed).is_some() {
            in_models = is_models_table_header(trimmed);
        } else if in_models && assignment_key_exact(trimmed) == Some("allowed_models") {
            let eq = line.find('=')?;
            let mut j = i + eq + 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if bytes.get(j) != Some(&b'[') {
                return None;
            }
            let end = scan_toml_array_end(bytes, j)?;
            return Some((j, end));
        }
        i = if line_end < text.len() {
            line_end + 1
        } else {
            text.len()
        };
    }
    None
}

fn scan_toml_array_end(bytes: &[u8], open: usize) -> Option<usize> {
    if bytes.get(open) != Some(&b'[') {
        return None;
    }
    let mut i = open + 1;
    let mut depth = 1i32;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => i = skip_basic_string(bytes, i)?,
            b'\'' => i = skip_literal_string(bytes, i)?,
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'#' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    None
}

fn skip_basic_string(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    if bytes.get(start + 1) == Some(&b'"') && bytes.get(start + 2) == Some(&b'"') {
        return None;
    }
    let mut j = start + 1;
    while j < bytes.len() {
        match bytes[j] {
            b'\\' => {
                if j + 1 >= bytes.len() {
                    return None;
                }
                j += 2;
            }
            b'"' => return Some(j + 1),
            b'\n' => return None,
            _ => j += 1,
        }
    }
    None
}

fn skip_literal_string(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'\'') {
        return None;
    }
    if bytes.get(start + 1) == Some(&b'\'') && bytes.get(start + 2) == Some(&b'\'') {
        return None;
    }
    let mut j = start + 1;
    while j < bytes.len() {
        match bytes[j] {
            b'\'' => return Some(j + 1),
            b'\n' => return None,
            _ => j += 1,
        }
    }
    None
}

fn parse_toml_string_array(array: &str) -> Option<Vec<String>> {
    let bytes = array.as_bytes();
    if bytes.first() != Some(&b'[') {
        return None;
    }
    let mut i = 1;
    let mut out = Vec::new();
    let mut expect_value = true;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b'#' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b',' => {
                if expect_value {
                    return None;
                }
                expect_value = true;
                i += 1;
            }
            b']' => {
                let rest_ok = array[i + 1..].chars().all(char::is_whitespace);
                if rest_ok {
                    return Some(out);
                }
                return None;
            }
            b'"' => {
                if !expect_value {
                    return None;
                }
                let end = skip_basic_string(bytes, i)?;
                let raw = &array[i..end];
                out.push(unquote(raw));
                i = end;
                expect_value = false;
            }
            b'\'' => {
                if !expect_value {
                    return None;
                }
                let end = skip_literal_string(bytes, i)?;
                out.push(unquote(&array[i..end]));
                i = end;
                expect_value = false;
            }
            _ => return None,
        }
    }
    None
}

/// `grok` is the official `[models].default` token. A custom `[model.grok]`
/// section must not steal Official Use (#1214).
pub fn is_reserved_custom_provider_id(id: &str) -> bool {
    let t = id.trim().to_ascii_lowercase();
    t == OFFICIAL_DEFAULT_MODEL || t == "official"
}

fn build_list_result(home: PathBuf, path: PathBuf, text: &str) -> ProvidersListResult {
    let def = get_models_default(text);
    let mut providers = Vec::new();
    for s in parse_model_sections(text) {
        if !is_custom(&s.fields) {
            continue;
        }
        // Per-model sections are CLI targets, not provider cards (#1394).
        if s.fields
            .get(APP_PARENT_PROVIDER_KEY)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            continue;
        }
        let model = s
            .fields
            .get("model")
            .cloned()
            .unwrap_or_else(|| s.id.clone());
        // UI shows the real upstream; CLI may use loopback sanitize proxy.
        let base_url = crate::relay_stream_proxy::effective_upstream_base(&s.fields);
        let name = s
            .fields
            .get("name")
            .cloned()
            .unwrap_or_else(|| s.id.clone());
        let has_api_key = s
            .fields
            .get("api_key")
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false);
        let api_backend = normalize_backend(s.fields.get("api_backend").map(|s| s.as_str()));
        let provider_mode =
            normalize_provider_mode(s.fields.get(APP_PROVIDER_MODE_KEY).map(|s| s.as_str()));
        let is_default = def.as_deref() == Some(s.id.as_str());
        // Prefer model display names from catalog; fall back to request id (not
        // channel name) so multi-model rows stay distinct from the provider card.
        let raw_models = s.fields.get(APP_MODELS_KEY).map(String::as_str);
        let model_catalog_corrupt =
            matches!(read_model_catalog(raw_models), ModelCatalogRead::Corrupt(_));
        let models = decode_app_models(raw_models, &model, &model);
        let efforts = decode_app_efforts(s.fields.get(APP_EFFORTS_KEY).map(|x| x.as_str()));
        let context_window = s
            .fields
            .get("context_window")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0);
        let base_url_full_path = base_url_full_path_from_fields(&s.fields);
        let append_prompt =
            crate::store::sanitize_extra_rules(s.fields.get(APP_APPEND_PROMPT_KEY).cloned());
        let supports_vision = supports_vision_from_fields(&s.fields);
        let extra_headers =
            decode_extra_headers(s.fields.get(EXTRA_HEADERS_KEY).map(|s| s.as_str()));
        providers.push(CustomProvider {
            id: s.id,
            model,
            base_url,
            name,
            has_api_key,
            api_backend,
            provider_mode,
            is_default,
            models,
            model_catalog_corrupt,
            efforts,
            context_window,
            base_url_full_path,
            append_prompt,
            supports_vision,
            extra_headers,
        });
    }
    ProvidersListResult {
        providers,
        default_model: def,
        config_path: path.display().to_string(),
        agent_home: home.display().to_string(),
        switched_to_independent: false,
    }
}

pub fn list_custom_providers() -> Result<ProvidersListResult, String> {
    let home = ensure_agent_home()?;
    let path = agent_config_toml();
    // Heal legacy App writes that stringified context_window (#538).
    let _ = ensure_model_integer_fields();
    // Existing App-only effort choices need the native Grok Build capability gate.
    let _ = ensure_reasoning_effort_support_fields();
    // One TOML section per generic catalog row, so a menu pick can be sent (#1394).
    let _ = ensure_generic_model_sections();
    let text = read_text(&path);
    Ok(build_list_result(home, path, &text))
}

/// Whether `id` is a configured custom provider route (not an official catalog model).
pub fn is_custom_provider_id(id: &str) -> bool {
    let id = id.trim();
    if id.is_empty() {
        return false;
    }
    list_custom_providers()
        .map(|list| list.providers.iter().any(|p| p.id == id))
        .unwrap_or(false)
}

pub fn provider_mode_for_id(id: &str) -> String {
    let id = id.trim();
    if id.is_empty() {
        return default_provider_mode();
    }
    list_custom_providers()
        .ok()
        .and_then(|list| list.providers.into_iter().find(|p| p.id == id))
        .map(|p| p.provider_mode)
        .unwrap_or_else(default_provider_mode)
}

/// Preserve the complete-path contract when callers edit only the active model
/// or context window and omit the provider form's URL toggle.
pub fn provider_base_url_full_path_for_id(id: &str) -> bool {
    let id = id.trim();
    if id.is_empty() {
        return false;
    }
    list_custom_providers()
        .ok()
        .and_then(|list| list.providers.into_iter().find(|p| p.id == id))
        .map(|p| p.base_url_full_path)
        .unwrap_or(false)
}

/// Read one provider's stored `app_models` exactly as it sits on disk.
///
/// Read-only: no migration, normalization, or write. `None` means no such
/// provider section exists (create path). Editing another field must decide
/// from this value, not from a re-encoded catalog.
pub fn stored_provider_model_catalog(provider_id: &str) -> Option<ModelCatalogRead> {
    // Match the section id `upsert_custom_provider` resolves the edit to.
    let id = sanitize_id(provider_id).ok()?;
    let text = read_text(&agent_config_toml());
    let sections = parse_model_sections(&text);
    let section = sections.iter().find(|s| s.id == id)?;
    Some(read_model_catalog(
        section.fields.get(APP_MODELS_KEY).map(String::as_str),
    ))
}

/// Extra system-prompt rules configured on one custom channel.
///
/// Relays vary in what they need spelled out (tool syntax, language, refusal
/// style), so this rides `--rules` — appended to the agent's prompt rather than
/// replacing it. `None` for an official / unknown provider or an empty value.
pub fn provider_append_prompt(provider_id: &str) -> Option<String> {
    let id = provider_id.trim();
    if is_session_provider_official(id) {
        return None;
    }
    list_custom_providers()
        .ok()?
        .providers
        .into_iter()
        .find(|p| p.id == id)
        .and_then(|p| p.append_prompt)
}

/// Provider that uniquely lists `model`, for scheduling legacy rows.
///
/// Ambiguous matches return `None`: a guessed route would silently send the
/// model to the wrong relay.
pub fn custom_provider_id_for_model_unique(model: &str) -> Option<String> {
    let model = model.trim();
    if model.is_empty() || is_official_catalog_model(model) {
        return None;
    }
    let list = list_custom_providers().ok()?;
    unique_model_owner(&list.providers, model)
}

/// [`list_custom_providers`] that never writes the agent config.
///
/// One-shot migrations must not heal or rewrite `config.toml` as a side effect
/// (that belongs to the interactive provider list). A missing file means "no
/// custom providers"; any other read error is reported so a caller holding a
/// one-shot flag can retry instead of latching "no owner".
pub fn list_custom_providers_readonly() -> Result<ProvidersListResult, String> {
    let path = agent_config_toml();
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("agent config read failed: {error}")),
    };
    Ok(build_list_result(agent_home_dir(), path, &text))
}

/// Provider that uniquely lists `model` in an already-read provider list.
///
/// Pair with [`list_custom_providers_readonly`] so a caller resolving many
/// model ids parses `config.toml` once.
pub(crate) fn unique_model_owner(providers: &[CustomProvider], model: &str) -> Option<String> {
    let mut hits = providers.iter().filter(|p| {
        // A stored id equal to a provider's own section id is the channel alias
        // the CLI sends, not a catalog model pick, so it never names an owner;
        // such rows keep the official fallback.
        p.id != model && (p.model == model || p.models.iter().any(|m| m.id == model))
    });
    let first = hits.next()?;
    if hits.next().is_some() {
        return None;
    }
    Some(first.id.clone())
}

/// Model flag for `grok agent --model` and ACP `session/set_model`.
///
/// Grok Build behavior:
/// - Generic custom route: pass the **provider section id** (e.g. `yunyi`) and
///   do not keep OIDC `auth.json` in GROK_HOME.
/// - Explicit Grok Build proxy route: `AcpClient::spawn` replaces this alias
///   with the selected real catalog model after binding the native endpoint.
/// - Official route: pass a catalog id (`grok-4.7`); needs `auth.json`.
/// - Official route + stale custom `app_models[].id` (#1000): map back to the
///   owning section id so spawn `--model` and later `session/set_model` agree.
///   CLI `--model` does not resolve App-only `app_models` ids; ACP set_model can,
///   which previously caused turn-1 official / turn-2 custom silent switches.
///
/// `session/set_model` on a generic custom route sends that same section id.
/// The CLI picker name is the TOML header (`[model.api-top]`), and the `model`
/// field is only the id sent upstream. Passing the upstream id looks up a
/// missing section, falls through to the built-in Grok catalog, and 401s
/// because the custom home has no OIDC (#1294). A Grok Build-compatible relay
/// is the exception: spawn already binds the real catalog id, and set_model
/// repeats that id.
pub const SESSION_PROVIDER_OFFICIAL: &str = "official";

pub fn is_session_provider_official(id: &str) -> bool {
    let id = id.trim();
    id.is_empty() || id.eq_ignore_ascii_case(SESSION_PROVIDER_OFFICIAL)
}

/// Provider this chat should connect with. Missing → official.
///
/// Composer selection is the only authority for a session route; a legacy
/// `[models].default` must not decide a session route.
pub fn session_route_provider_id(stored: Option<&str>) -> String {
    match stored.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) if is_session_provider_official(id) => SESSION_PROVIDER_OFFICIAL.into(),
        Some(id) => id.to_string(),
        None => SESSION_PROVIDER_OFFICIAL.into(),
    }
}

/// 删除的 provider 或显式清空且无会话 model id 时回退 official。
pub fn existing_session_route(
    route: &str,
    composer_model: &str,
    session_model_is_stored: bool,
) -> String {
    let id = route.trim();
    if is_session_provider_official(id) {
        return SESSION_PROVIDER_OFFICIAL.into();
    }
    let list = match list_custom_providers() {
        Ok(list) => list,
        Err(error) => {
            tracing::warn!(
                provider = %id,
                error = %error,
                "could not resolve saved session route; keeping provider id"
            );
            return id.to_string();
        }
    };
    let Some(provider) = list.providers.iter().find(|provider| provider.id == id) else {
        return SESSION_PROVIDER_OFFICIAL.into();
    };
    if composer_model.trim().is_empty() || (provider.models.is_empty() && !session_model_is_stored)
    {
        SESSION_PROVIDER_OFFICIAL.into()
    } else {
        id.to_string()
    }
}

fn official_default_model_id() -> String {
    crate::models_catalog::list_available_models().default_model_id
}

/// Model to connect with after resolving a chat's saved provider.
///
/// If its custom provider was removed, the official route must discard the
/// relay's model id—even when that id also exists in the official catalog.
pub fn session_model_id_for_route(
    stored_provider: Option<&str>,
    resolved_route: &str,
    composer_model: &str,
) -> String {
    let stored_id = stored_provider.map(str::trim).filter(|id| !id.is_empty());
    let removed_provider = stored_id.is_some_and(|id| {
        !is_session_provider_official(id)
            && is_session_provider_official(resolved_route)
            && !is_custom_provider_id(id)
    });
    if removed_provider {
        return official_default_model_id();
    }
    session_set_model_id_for(resolved_route, composer_model)
}

/// 用于推理目录查询的模型 id：官方使用已解析 id，自定义路由使用上游模型 id。
pub fn effort_model_id_for_route(
    provider_id: &str,
    composer_model: &str,
    session_model: &str,
) -> String {
    let composer_model = composer_model.trim();
    if is_session_provider_official(provider_id) {
        return session_model.trim().to_string();
    }
    let Ok(list) = list_custom_providers() else {
        return if composer_model.is_empty() {
            session_model.trim().to_string()
        } else {
            composer_model.to_string()
        };
    };
    if let Some(provider) = list
        .providers
        .iter()
        .find(|provider| provider.id == provider_id.trim())
    {
        return resolved_custom_effort_model_id(provider, composer_model);
    }
    if composer_model.is_empty() {
        session_model.trim().to_string()
    } else {
        composer_model.to_string()
    }
}

/// How a composer provider pick relates to the route this chat already uses.
///
/// An empty stored id resolves to the official route. Writing that same route
/// onto the row is not a switch: respawning would drop the CLI resume id and
/// skip `session/set_model`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionProviderPick {
    SameRoute,
    RouteChanged,
}

/// Route a connect or a composer pick actually runs on.
///
/// SSH is always official (`connect_route_id(true, _)`), including when the
/// row or the pick names a custom provider.
pub fn connect_route_id(ssh: bool, stored_provider: Option<&str>) -> String {
    if ssh {
        SESSION_PROVIDER_OFFICIAL.to_string()
    } else {
        session_route_provider_id(stored_provider)
    }
}

pub fn session_provider_pick(
    ssh: bool,
    stored: Option<&str>,
    picked: Option<&str>,
) -> SessionProviderPick {
    let Some(picked) = picked.map(str::trim).filter(|s| !s.is_empty()) else {
        return SessionProviderPick::SameRoute;
    };
    let before = connect_route_id(ssh, stored);
    let after = connect_route_id(ssh, Some(picked));
    if before == after {
        SessionProviderPick::SameRoute
    } else {
        SessionProviderPick::RouteChanged
    }
}

/// Provider id to write for this pick. SSH never stores a custom id.
pub fn provider_id_to_persist(ssh: bool, picked: Option<&str>) -> Option<String> {
    let picked = picked.map(str::trim).filter(|s| !s.is_empty())?;
    if ssh {
        Some(SESSION_PROVIDER_OFFICIAL.into())
    } else {
        Some(picked.to_string())
    }
}

/// Model id to send with `session/set_model` after a provider pick.
///
/// A route change cold-spawns instead. SSH never sends a custom provider id.
pub fn set_model_id_after_provider_pick(
    ssh: bool,
    model_id: Option<&str>,
    picked_provider: Option<&str>,
) -> Option<String> {
    let model = model_id.map(str::trim).filter(|s| !s.is_empty())?;
    if ssh {
        let custom_provider = picked_provider
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some_and(|id| !is_session_provider_official(id));
        if custom_provider || is_custom_provider_id(model) {
            return None;
        }
    }
    Some(model.to_string())
}

/// What `composer_prefs_set` should do with one provider/model pick.
pub struct ComposerProviderPick {
    pub route_changed: bool,
    pub provider_to_persist: Option<String>,
    pub set_model_id: Option<String>,
}

pub fn composer_provider_pick(
    ssh: bool,
    stored: Option<&str>,
    picked_provider: Option<&str>,
    model_id: Option<&str>,
) -> ComposerProviderPick {
    let route_changed = matches!(
        session_provider_pick(ssh, stored, picked_provider),
        SessionProviderPick::RouteChanged
    );
    let provider_to_persist = provider_id_to_persist(ssh, picked_provider);
    let set_model_id = if route_changed {
        None
    } else {
        set_model_id_after_provider_pick(ssh, model_id, picked_provider)
    };
    ComposerProviderPick {
        route_changed,
        provider_to_persist,
        set_model_id,
    }
}

/// Default id for a reasoning ladder: explicit `isDefault`, then `medium`,
/// then the first non-blank id. Mirrors the composer's raw-id default rule.
/// 梯子无显式 `isDefault` 时的默认档：首个非空且非 `none` 的档位。
/// Off 永远不做隐式默认；不再凭空回退 `medium`（与前端
/// `pickDefaultEffort` 保持同一规则，避免两端默认档分歧）。
pub fn reasoning_effort_ladder_default(efforts: &[ProviderEffortEntry]) -> Option<String> {
    efforts
        .iter()
        .find(|entry| entry.is_default && !entry.id.trim().is_empty())
        .or_else(|| {
            efforts.iter().find(|entry| {
                !entry.id.trim().is_empty() && !entry.id.trim().eq_ignore_ascii_case("none")
            })
        })
        .map(|entry| entry.id.trim().to_string())
}

/// 判断模型目录是否显式声明指定的推理档位。
pub fn model_advertises_reasoning_effort(
    provider_id: &str,
    composer_model: &str,
    effort_id: &str,
) -> bool {
    let effort_id = effort_id.trim();
    if !crate::acp_client::is_spawnable_reasoning_effort(effort_id) {
        return false;
    }
    if is_session_provider_official(provider_id) {
        return crate::models_catalog::list_available_models()
            .models
            .into_iter()
            .find(|model| model.id == composer_model.trim())
            .is_some_and(|model| {
                model
                    .reasoning_efforts
                    .iter()
                    .any(|effort| effort.id == effort_id)
            });
    }
    let Ok(list) = list_custom_providers() else {
        return false;
    };
    let Some(provider) = list
        .providers
        .into_iter()
        .find(|provider| provider.id == provider_id.trim())
    else {
        return false;
    };
    let model_id = resolved_custom_effort_model_id(&provider, composer_model);
    let model = provider
        .models
        .iter()
        .find(|model| model.id.trim() == model_id.as_str());
    if model.is_some_and(|model| !model_supports_reasoning_effort(model)) {
        return false;
    }
    custom_model_effort_ladder(&provider, &model_id)
        .is_some_and(|ladder| ladder.iter().any(|effort| effort.id.trim() == effort_id))
}

const CUSTOM_FALLBACK_REASONING_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh"];

/// 根据 provider 目录将已保存的 model id 解析到实际可用的推理档位行。
fn resolved_custom_effort_model_id(provider: &CustomProvider, composer_model: &str) -> String {
    let requested = composer_model.trim();
    if !requested.is_empty()
        && provider
            .models
            .iter()
            .any(|model| model.id.trim() == requested)
    {
        return requested.to_string();
    }
    if !requested.is_empty() && (provider.model_catalog_corrupt || provider.models.is_empty()) {
        return requested.to_string();
    }
    let active = provider.model.trim();
    if !active.is_empty()
        && provider
            .models
            .iter()
            .any(|model| model.id.trim() == active)
    {
        return active.to_string();
    }
    provider
        .models
        .first()
        .map(|model| model.id.trim().to_string())
        .filter(|model| !model.is_empty())
        .or_else(|| (!requested.is_empty()).then(|| requested.to_string()))
        .unwrap_or_else(|| active.to_string())
}

fn resolved_custom_model_id_for_session(
    provider: &CustomProvider,
    composer_model: &str,
    session_model_is_stored: bool,
) -> String {
    let requested = composer_model.trim();
    if provider.model_catalog_corrupt && !session_model_is_stored {
        if provider
            .models
            .iter()
            .any(|model| model.id.trim() == requested)
        {
            return requested.to_string();
        }
        let active = provider.model.trim();
        if provider
            .models
            .iter()
            .any(|model| model.id.trim() == active)
        {
            return active.to_string();
        }
        if let Some(first) = provider.models.first().map(|model| model.id.trim()) {
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    resolved_custom_effort_model_id(provider, requested)
}

/// 返回当前会话路由实际选择的自定义模型 identity。
pub fn session_composer_model_id_for_route(
    stored_provider: Option<&str>,
    resolved_route: &str,
    composer_model: &str,
    session_model_is_stored: bool,
) -> String {
    if is_session_provider_official(resolved_route) {
        return session_model_id_for_route(stored_provider, resolved_route, composer_model);
    }
    let id = resolved_route.trim();
    let provider = list_custom_providers().ok().and_then(|list| {
        list.providers
            .into_iter()
            .find(|provider| provider.id == id)
    });
    provider.map_or_else(
        || composer_model.trim().to_string(),
        |provider| {
            resolved_custom_model_id_for_session(&provider, composer_model, session_model_is_stored)
        },
    )
}

fn model_supports_reasoning_effort(model: &ProviderModelEntry) -> bool {
    let has_configured_ladder =
        !model.efforts.is_empty() && model.efforts_source.as_deref() != Some(MODEL_SOURCE_FALLBACK);
    has_configured_ladder
        || model.supports_reasoning_off == Some(true)
        || model.supports_reasoning_effort != Some(false)
}

/// Append or drop the raw `none` row according to the model setting.
fn with_reasoning_off(
    mut ladder: Vec<ProviderEffortEntry>,
    model: &ProviderModelEntry,
) -> Vec<ProviderEffortEntry> {
    let catalog_advertises_off = ladder
        .iter()
        .any(|effort| effort.id.trim().eq_ignore_ascii_case("none"));
    let supports_off = model
        .supports_reasoning_off
        .unwrap_or(catalog_advertises_off);
    if supports_off && !catalog_advertises_off {
        ladder.push(ProviderEffortEntry {
            id: "none".into(),
            name: "none".into(),
            is_default: false,
        });
    } else if !supports_off {
        ladder.retain(|effort| !effort.id.trim().eq_ignore_ascii_case("none"));
    }
    ladder
}

fn fallback_reasoning_efforts() -> Vec<ProviderEffortEntry> {
    CUSTOM_FALLBACK_REASONING_EFFORTS
        .iter()
        .map(|id| ProviderEffortEntry {
            id: (*id).to_string(),
            name: (*id).to_string(),
            is_default: *id == "medium",
        })
        .collect()
}

/// The row's own ladder, including the optional Off entry.
fn model_own_efforts(model: &ProviderModelEntry) -> Option<Vec<ProviderEffortEntry>> {
    if !model_supports_reasoning_effort(model) {
        return None;
    }
    let ladder = if !model.efforts.is_empty() {
        normalize_provider_efforts(&model.efforts)
    } else if model.supports_reasoning_off == Some(true) {
        fallback_reasoning_efforts()
    } else {
        return None;
    };
    Some(with_reasoning_off(ladder, model))
}

/// Ladder sent to the CLI for one generic child section.
///
/// A legacy single-model channel may lend its `app_efforts` when the catalog
/// row is the same model; multi-model channels never borrow another row.
fn cli_efforts_for_model(
    model: &ProviderModelEntry,
    channel_efforts: Option<&[ProviderEffortEntry]>,
) -> Option<Vec<ProviderEffortEntry>> {
    if !model_supports_reasoning_effort(model) {
        return None;
    }
    if !model.efforts.is_empty() || model.supports_reasoning_off == Some(true) {
        return model_own_efforts(model);
    }
    let channel = channel_efforts.filter(|efforts| !efforts.is_empty())?;
    Some(with_reasoning_off(
        normalize_provider_efforts(channel),
        model,
    ))
}

fn custom_model_effort_ladder(
    provider: &CustomProvider,
    model_id: &str,
) -> Option<Vec<ProviderEffortEntry>> {
    let model_id = model_id.trim();
    let model = provider
        .models
        .iter()
        .find(|model| model.id.trim() == model_id)?;
    if !model_supports_reasoning_effort(model) {
        return None;
    }
    if !model.efforts.is_empty() || model.supports_reasoning_off == Some(true) {
        return model_own_efforts(model);
    }
    if provider.models.len() == 1
        && provider.model.trim() == model_id
        && !provider.efforts.is_empty()
    {
        return Some(with_reasoning_off(
            normalize_provider_efforts(&provider.efforts),
            model,
        ));
    }
    None
}

fn official_fallback_efforts(model_id: &str) -> &'static [&'static str] {
    if matches!(
        model_id.trim(),
        "grok-4.7" | "grok-4.7-build-fast" | "grok-4.6"
    ) {
        &["low", "medium", "high", "xhigh"]
    } else {
        &["low", "medium", "high"]
    }
}

/// 模型档位目录的默认档：显式 `isDefault` 优先；否则取首个可 spawn 且
/// 非 `none` 的档位（Off 不做隐式默认；API 提供了档位但未标默认）。
/// 完全没有档位信息时由调用方回退 `medium`（CLI 固定 wire 枚举内）。
fn reasoning_effort_catalog_default(
    efforts: &[crate::models_catalog::ReasoningEffort],
) -> Option<String> {
    efforts
        .iter()
        .filter(|effort| crate::acp_client::is_spawnable_reasoning_effort(&effort.id))
        .find(|effort| effort.is_default)
        .or_else(|| {
            efforts.iter().find(|effort| {
                crate::acp_client::is_spawnable_reasoning_effort(&effort.id)
                    && !effort.id.trim().eq_ignore_ascii_case("none")
            })
        })
        .map(|effort| effort.id.trim().to_string())
}

/// 按路由校验推理档位：有目录时必须匹配目录，无目录时沿用产品 fallback。
pub fn is_valid_reasoning_effort_for_model(
    provider_id: &str,
    composer_model: &str,
    effort_id: &str,
) -> bool {
    let effort_id = effort_id.trim();
    if !crate::acp_client::is_spawnable_reasoning_effort(effort_id) {
        return false;
    }
    if effort_id == "none" {
        return model_advertises_reasoning_effort(provider_id, composer_model, effort_id);
    }
    if is_session_provider_official(provider_id) {
        let available = crate::models_catalog::list_available_models();
        let Some(model) = available
            .models
            .iter()
            .find(|model| model.id == composer_model.trim())
        else {
            return official_fallback_efforts(composer_model).contains(&effort_id);
        };
        if model.reasoning_efforts.is_empty() {
            return official_fallback_efforts(composer_model).contains(&effort_id);
        }
        return model
            .reasoning_efforts
            .iter()
            .any(|effort| effort.id == effort_id);
    }
    let Ok(list) = list_custom_providers() else {
        return false;
    };
    let Some(provider) = list
        .providers
        .iter()
        .find(|provider| provider.id == provider_id.trim())
    else {
        return false;
    };
    let model_id = resolved_custom_effort_model_id(provider, composer_model);
    let model = provider
        .models
        .iter()
        .find(|model| model.id.trim() == model_id.as_str());
    if model.is_some_and(|model| !model_supports_reasoning_effort(model)) {
        return false;
    }
    if let Some(ladder) = custom_model_effort_ladder(provider, &model_id) {
        return ladder.iter().any(|effort| effort.id.trim() == effort_id);
    }
    CUSTOM_FALLBACK_REASONING_EFFORTS.contains(&effort_id)
}

/// Effective context window for one custom-provider model.
///
/// `model_id` may be a catalog row id or a generic child section id. The
/// model row wins over the channel field; when neither declares a window the
/// custom-provider default applies. `None` is returned only when the route is
/// official or the provider no longer exists, so the caller leaves the CLI
/// default alone for a route the App cannot resolve.
pub fn provider_model_context_window(provider_id: &str, model_id: &str) -> Option<u64> {
    let route = provider_id.trim();
    if route.is_empty() || is_session_provider_official(route) {
        return None;
    }
    let provider = list_custom_providers()
        .ok()?
        .providers
        .into_iter()
        .find(|provider| provider.id == route)?;
    let requested = model_id.trim();
    let section_model = generic_sections_for_provider(route)
        .into_iter()
        .find(|section| section.section_id == requested)
        .map(|section| section.model_id);
    let lookup = if requested.is_empty() {
        provider.model.trim().to_string()
    } else {
        requested.to_string()
    };
    Some(custom_window_from_row(
        &provider,
        &lookup,
        section_model.as_deref(),
    ))
}

/// Row window, then channel window, then [`DEFAULT_CUSTOM_CONTEXT_WINDOW`].
fn custom_window_from_row(
    provider: &CustomProvider,
    model_id: &str,
    section_model: Option<&str>,
) -> u64 {
    let row = provider
        .models
        .iter()
        .find(|model| model.id.trim() == model_id)
        .or_else(|| {
            section_model.and_then(|id| provider.models.iter().find(|model| model.id.trim() == id))
        });
    row.and_then(|model| model.context_window.filter(|window| *window > 0))
        .or_else(|| provider.context_window.filter(|window| *window > 0))
        .unwrap_or(DEFAULT_CUSTOM_CONTEXT_WINDOW)
}

/// 按 provider/model 解析 CLI 实际使用的推理档位。
///
/// 显式模型档位里的过期 id 回退到该模型默认值；未配置模型档位时使用
/// 自定义通用 fallback。单行旧目录仅在它与活动模型相同时使用 channel 档位。
/// 只有精确模型档位声明 `none` 才会向 CLI 传 Off。
pub fn effective_reasoning_effort(
    provider_id: &str,
    composer_model: &str,
    stored_effort: &str,
) -> Option<String> {
    let stored = stored_effort.trim();
    let stored_is_spawnable = crate::acp_client::is_spawnable_reasoning_effort(stored);
    if is_session_provider_official(provider_id) {
        let available = crate::models_catalog::list_available_models();
        let model = available
            .models
            .iter()
            .find(|model| model.id == composer_model.trim());
        if stored == "none" {
            return model
                .filter(|model| {
                    model
                        .reasoning_efforts
                        .iter()
                        .any(|effort| effort.id == "none")
                })
                .map(|_| stored.to_string());
        }
        if let Some(model) = model.filter(|model| !model.reasoning_efforts.is_empty()) {
            if stored_is_spawnable
                && model
                    .reasoning_efforts
                    .iter()
                    .any(|effort| effort.id == stored)
            {
                return Some(stored.to_string());
            }
            return reasoning_effort_catalog_default(&model.reasoning_efforts);
        }
        let fallback = official_fallback_efforts(composer_model);
        if fallback.contains(&stored) {
            return stored_is_spawnable.then(|| stored.to_string());
        }
        return fallback
            .iter()
            .find(|effort| **effort == "xhigh")
            .or_else(|| fallback.iter().find(|effort| **effort == "high"))
            .map(|effort| (*effort).to_string());
    }
    let Ok(list) = list_custom_providers() else {
        return if stored == "none" {
            Some("medium".to_string())
        } else {
            stored_is_spawnable.then(|| stored.to_string())
        };
    };
    let Some(provider) = list
        .providers
        .into_iter()
        .find(|provider| provider.id == provider_id.trim())
    else {
        return if stored == "none" {
            Some("medium".to_string())
        } else {
            stored_is_spawnable.then(|| stored.to_string())
        };
    };
    let model_id = resolved_custom_effort_model_id(&provider, composer_model);
    let model = provider
        .models
        .iter()
        .find(|model| model.id.trim() == model_id.as_str());
    if model.is_some_and(|model| !model_supports_reasoning_effort(model)) {
        return None;
    }
    if stored == "none" {
        if let Some(ladder) = custom_model_effort_ladder(&provider, &model_id) {
            return if ladder.iter().any(|entry| entry.id.trim() == "none") {
                Some(stored.to_string())
            } else {
                reasoning_effort_ladder_default(&ladder)
            };
        }
        return Some("medium".to_string());
    }
    if let Some(ladder) = custom_model_effort_ladder(&provider, &model_id) {
        if ladder.iter().any(|entry| entry.id.trim() == stored) {
            return stored_is_spawnable.then(|| stored.to_string());
        }
        return reasoning_effort_ladder_default(&ladder);
    }
    Some(if CUSTOM_FALLBACK_REASONING_EFFORTS.contains(&stored) {
        stored.to_string()
    } else {
        "medium".to_string()
    })
}

/// `--model` for a process bound to `provider_id`.
///
/// Official routes spawn with a catalog id. A generic custom route spawns with
/// the per-model section when one exists, otherwise the provider section.
/// A Grok Build-compatible relay spawns with the catalog id, with the id the
/// chat stored when its catalog fixes no rows, or with the active row (#152).
pub fn spawn_model_for_provider(provider_id: &str, composer_model: &str) -> String {
    session_set_model_id_for(provider_id, composer_model)
}

/// Official model id for one chat.
///
/// A saved id from a deleted relay, or any id the official catalog no longer
/// lists, must not be sent to xAI. Fall back to the catalog default so the
/// chat opens instead of failing every turn.
pub fn official_model_id_for(requested: &str) -> String {
    let model = requested.trim();
    if model.is_empty() || model == OFFICIAL_DEFAULT_MODEL {
        return official_default_model_id();
    }
    if is_official_catalog_model(model) {
        return model.into();
    }
    let available = crate::models_catalog::list_available_models();
    if available.models.iter().any(|row| row.id == model) {
        return model.into();
    }
    available.default_model_id
}

/// `session/set_model` id for one chat on `provider_id`.
pub fn session_set_model_id_for(provider_id: &str, composer_model: &str) -> String {
    if is_session_provider_official(provider_id) {
        return official_model_id_for(composer_model);
    }
    let id = provider_id.trim();
    let found = list_custom_providers()
        .ok()
        .and_then(|list| list.providers.into_iter().find(|p| p.id == id));
    let Some(provider) = found else {
        return resolve_session_set_model_id(Some(id), composer_model, &[]);
    };
    if provider.provider_mode == PROVIDER_MODE_GROK_BUILD_PROXY {
        // A corrupt or explicitly cleared catalog fixes no rows, which is
        // exactly when the native spawn keeps the chat's stored id.
        return resolve_grok_build_proxy_session_model_id(
            id,
            composer_model,
            &provider.models,
            &provider.model,
            provider.model_catalog_corrupt || provider.models.is_empty(),
        );
    }
    let generic_sections = generic_sections_for_provider(id);
    let requested = composer_model.trim();
    if generic_sections
        .iter()
        .any(|section| section.section_id == requested)
    {
        return requested.to_string();
    }
    let resolved_model_id = resolved_custom_effort_model_id(&provider, requested);
    resolve_session_set_model_id(Some(id), &resolved_model_id, &generic_sections)
}

/// Pure half of [`session_set_model_id_for`] for a Grok Build-compatible relay.
///
/// Must repeat what [`grok_build_proxy_spawn_from_section`] binds as `--model`,
/// because one chat cannot switch model between its spawn and its next
/// `session/set_model`: a listed row passes through verbatim, a stored id
/// passes through when the catalog fixes no rows, and everything else falls
/// back to the spawn's active row (the channel `model` when it is a row,
/// otherwise the first row).
///
/// `catalog_rows` is the readable catalog (recovered rows included),
/// `configured_model` the channel `model`, and `catalog_fixes_no_rows` is true
/// for an unreadable or explicitly cleared catalog.
pub fn resolve_grok_build_proxy_session_model_id(
    provider_id: &str,
    requested: &str,
    catalog_rows: &[ProviderModelEntry],
    configured_model: &str,
    catalog_fixes_no_rows: bool,
) -> String {
    let id = provider_id.trim();
    let configured = configured_model.trim();
    // The spawn falls back to the section id when the channel has no model.
    let configured = if configured.is_empty() {
        id
    } else {
        configured
    };
    let requested = requested.trim();
    if !requested.is_empty() && requested != id && catalog_fixes_no_rows {
        return requested.to_string();
    }
    if !requested.is_empty() && catalog_rows.iter().any(|row| row.id == requested) {
        return requested.to_string();
    }
    resolve_active_model(catalog_rows, configured)
}

/// Pure half of [`session_set_model_id_for`] for a generic relay. `None` route
/// means official; the caller passes an already resolved official id.
///
/// A generic relay's request body comes from `[model.<section>].model`.
/// CLI 1.0.70 accepts `session/set_model` of that section name (`matched by
/// map key`) and rejects an id that is neither a section nor some section's
/// `model` field (`unknown model id`). `generic_sections` lists the per-model
/// sections for this channel. When it is empty (old single-section config),
/// the provider id is still the right send — that section's `model` field is
/// what the CLI will put in the body (#1337, #1394).
pub fn resolve_session_set_model_id(
    custom_provider_id: Option<&str>,
    composer_model: &str,
    generic_sections: &[GenericSectionBinding],
) -> String {
    let m = composer_model.trim();
    let Some(id) = custom_provider_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return if m.is_empty() {
            OFFICIAL_CATALOG_MODEL.into()
        } else {
            m.to_string()
        };
    };
    if !m.is_empty() {
        if let Some(hit) = generic_sections.iter().find(|s| s.section_id == m) {
            return hit.section_id.clone();
        }
        if let Some(hit) = generic_sections.iter().find(|s| s.model_id == m) {
            return hit.section_id.clone();
        }
    }
    id.to_string()
}

fn grok_build_proxy_spawn_from_section(
    section: &ModelSection,
    composer_model: &str,
) -> Option<GrokBuildProxySpawn> {
    if normalize_provider_mode(
        section
            .fields
            .get(APP_PROVIDER_MODE_KEY)
            .map(|s| s.as_str()),
    ) != PROVIDER_MODE_GROK_BUILD_PROXY
    {
        return None;
    }
    let base_url = crate::relay_stream_proxy::effective_upstream_base(&section.fields)
        .trim()
        .trim_end_matches('/')
        .to_string();
    let api_key = section.fields.get("api_key")?.trim().to_string();
    if base_url.is_empty() || api_key.is_empty() {
        return None;
    }
    let configured_model = section
        .fields
        .get("model")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(section.id.as_str());
    let catalog = read_model_catalog(section.fields.get(APP_MODELS_KEY).map(|s| s.as_str()));
    let requested = composer_model.trim();
    // The section id is a route name, never an upstream model to send.
    let requested_model = !requested.is_empty() && requested != section.id;
    let model = if requested_model && catalog_fixes_no_model_rows(&catalog) {
        // The catalog cannot confirm the id, but this chat was stored on it.
        // Falling back to the first row would silently retarget the upstream
        // request; only an explicit model from the chat is passed here.
        requested.to_string()
    } else {
        let models = resolve_catalog_rows(&catalog, configured_model, configured_model);
        if !requested.is_empty() && models.iter().any(|m| m.id == requested) {
            requested.to_string()
        } else {
            resolve_active_model(&models, configured_model)
        }
    };
    let models_url = models_list_endpoint(&base_url).ok()?;
    Some(GrokBuildProxySpawn {
        base_url,
        models_url,
        api_key,
        model,
    })
}

#[cfg(test)]
fn grok_build_proxy_spawn_from_text(
    text: &str,
    composer_model: &str,
) -> Option<GrokBuildProxySpawn> {
    let default = get_models_default(text)?;
    let section = parse_model_sections(text)
        .into_iter()
        .find(|s| s.id == default)?;
    grok_build_proxy_spawn_from_section(&section, composer_model)
}

/// Proxy spawn for one chat's provider. Official, and any non-proxy section,
/// return `None` so a global proxy default cannot leak onto another chat.
fn grok_build_proxy_spawn_for_provider_text(
    text: &str,
    provider_id: &str,
    composer_model: &str,
) -> Option<GrokBuildProxySpawn> {
    if is_session_provider_official(provider_id) {
        return None;
    }
    let section = parse_model_sections(text)
        .into_iter()
        .find(|s| s.id == provider_id.trim())?;
    grok_build_proxy_spawn_from_section(&section, composer_model)
}

/// Proxy env for a chat bound to `provider_id`, ignoring `[models].default`.
pub fn session_grok_build_proxy_spawn(
    provider_id: &str,
    composer_model: &str,
) -> Option<GrokBuildProxySpawn> {
    let text = read_text(&agent_config_toml());
    grok_build_proxy_spawn_for_provider_text(&text, provider_id, composer_model)
}

/// Serializes agent-home `auth.json` preparation so spawns on different routes
/// never interleave the write.
pub fn route_auth_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    &LOCK
}

/// Headless / account callers have no session context; they are official-only.
pub fn prepare_route_auth_for_agent() {
    prepare_route_auth(false);
}

/// Prepare agent-home auth for one spawn. `custom` strips `auth.json` so the
/// process uses that provider's `api_key`. Official copies OIDC in: it is the
/// only route that may mirror `~/.grok/auth.json` into agent-home, so a custom
/// relay never receives OIDC. Callers that spawn different providers must not
/// overlap this write.
pub fn prepare_route_auth(custom: bool) {
    if custom {
        crate::account::clear_agent_home_auth();
        tracing::info!(
            target: "providers",
            "custom route spawn: cleared agent-home auth.json (api_key only)"
        );
    } else {
        if let Err(e) = crate::account::sync_cli_auth_to_agent_home() {
            tracing::warn!(
                target: "providers",
                "official route: auth sync failed: {e}"
            );
        }
    }
    // Never import Claude/Cursor MCP catalogs into App agent-home sessions.
    let mode = crate::store::load_settings().session_data_mode;
    if let Err(e) = crate::agent_home_config::apply_compat_mcp_disabled(&mode) {
        tracing::warn!(
            target: "providers",
            "compat.claude/cursor mcps=false pin failed: {e}"
        );
    }
}

pub fn upsert_custom_provider(input: UpsertProviderInput) -> Result<ProvidersListResult, String> {
    let id = sanitize_id(&input.id)?;
    let model = {
        let m = input.model.trim();
        if m.is_empty() {
            id.clone()
        } else {
            m.to_string()
        }
    };
    let api_backend = normalize_backend(input.api_backend.as_deref());

    let _ = ensure_agent_home()?;
    let path = agent_config_toml();
    let mut text = read_text(&path);
    let sections = parse_model_sections(&text);
    let existing = sections.iter().find(|s| s.id == id);
    let prev_app_models = existing.and_then(|s| s.fields.get(APP_MODELS_KEY)).cloned();
    let catalog_read = read_model_catalog(prev_app_models.as_deref());
    // An edit that omits `models` does not repair an unreadable catalog, so the
    // channel keeps the `model` already on disk. The caller only saw recovery
    // rows then, and adopting the first of them would silently retarget the
    // provider on an unrelated save.
    let model = match (&input.models, &catalog_read) {
        (None, ModelCatalogRead::Corrupt(_)) => existing
            .and_then(|s| s.fields.get("model"))
            .map(|m| m.trim())
            .filter(|m| !m.is_empty())
            .map(str::to_string)
            .unwrap_or(model),
        _ => model,
    };
    let models = match (&input.models, &catalog_read) {
        (Some(list), _) => {
            // A blank row is a half-finished form edit, not a clear. Reject it
            // before normalization can drop it and quietly shrink the catalog
            // (or turn a single blank row into the explicit-clear path).
            if list.iter().any(|m| m.id.trim().is_empty()) {
                return Err("each models row must have a non-empty id".into());
            }
            normalize_provider_models(list)
        }
        (None, ModelCatalogRead::Stored(rows)) => rows.clone(),
        (None, ModelCatalogRead::LegacyChannel) => legacy_model_catalog(&model, &model),
        (None, ModelCatalogRead::Corrupt(_)) => legacy_model_catalog(&model, &model),
    };
    let model = resolve_active_model(&models, &model);
    let provider_mode = match input.provider_mode.as_deref() {
        Some(raw) => normalize_provider_mode(Some(raw)),
        None => normalize_provider_mode(
            existing
                .and_then(|s| s.fields.get(APP_PROVIDER_MODE_KEY))
                .map(|s| s.as_str()),
        ),
    };

    // Full-path mode: UI switch. Omitted on edit keeps previous; create defaults false.
    let full_path = match input.base_url_full_path {
        Some(v) => v,
        None => existing
            .map(|s| base_url_full_path_from_fields(&s.fields))
            .unwrap_or(false),
    };
    let user_base = normalize_openai_base_url(input.base_url.trim(), &api_backend, full_path);
    if user_base.is_empty() {
        return Err("base_url is required".into());
    }
    if !(user_base.starts_with("http://") || user_base.starts_with("https://")) {
        return Err("base_url must start with http:// or https://".into());
    }
    // OpenCode Zen Go etc.: CLI talks to loopback sanitize proxy; real host in
    // app_upstream_base_url (ignored by Grok Build).
    let (base_url, app_upstream) = if provider_mode == PROVIDER_MODE_GROK_BUILD_PROXY {
        // Native catalog/proxy mode talks straight to the configured endpoint;
        // the generic SSE sanitizer is a different provider contract.
        (user_base.clone(), None)
    } else {
        crate::relay_stream_proxy::rewrite_base_for_cli(&id, &user_base, &api_backend, full_path)?
    };
    // The key only exists while `base_url` is our loopback sanitize rewrite, so a
    // re-saved local proxy without a new upstream keeps the previous real host.
    let keep_prev_upstream = app_upstream.is_none()
        && provider_mode != PROVIDER_MODE_GROK_BUILD_PROXY
        && crate::relay_stream_proxy::is_local_sanitize_proxy_url(&base_url);
    let create_only = input.create_only.unwrap_or(false);
    if create_only && existing.is_some() {
        return Err(format!("provider id `{id}` already exists"));
    }
    if is_reserved_custom_provider_id(&id) && existing.is_none() {
        return Err(format!(
            "provider id `{id}` is reserved for Official Grok — pick another id"
        ));
    }
    let prev_key = existing
        .and_then(|s| s.fields.get("api_key"))
        .cloned()
        .unwrap_or_default();
    // On create, never inherit a ghost key from a stale section (should not
    // exist when create_only, but keep the path explicit for overwrite upserts).
    let next_key = match input.api_key.as_deref() {
        None | Some("") => {
            if create_only {
                String::new()
            } else {
                prev_key
            }
        }
        Some(k) => k.trim().to_string(),
    };
    if next_key.is_empty() {
        return Err("api_key is required for custom providers".into());
    }

    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(id.as_str())
        .to_string();

    // `models: None` means the caller did not edit the catalog. Whatever the
    // parent holds is then carried over as the original decoded field value, so
    // unknown per-row fields and surrounding whitespace survive an unrelated
    // save; a parent without the key keeps no key. Only an explicit
    // `models: Some(rows)` writes a normalized catalog (`Some([])` clears).
    let app_models_field: Option<String> = match &input.models {
        Some(_) => Some(encode_app_models(&models)?),
        None => {
            if let ModelCatalogRead::Corrupt(defect) = &catalog_read {
                tracing::warn!(
                    target: "providers",
                    provider = %id,
                    category = %defect.kind,
                    "app_models is unusable; keeping the stored value because this edit omits `models`"
                );
            }
            prev_app_models.clone()
        }
    };
    let active_model = models.iter().find(|m| m.id == model);

    // Fields the caller explicitly cleared (`Some(0)` / `Some(false)` /
    // `Some([])` / `Some("")`) must not be copied back from the previous
    // section during the merge below.
    let context_window_explicit = input.context_window.is_some();
    let supports_vision_explicit =
        input.supports_vision.is_some() || active_model.and_then(|m| m.supports_vision).is_some();
    let efforts_explicit = input.efforts.is_some();
    let base_url_full_path_explicit = input.base_url_full_path.is_some();

    let prev_app_efforts = existing
        .and_then(|s| s.fields.get(APP_EFFORTS_KEY))
        .cloned();
    let efforts = if let Some(ref list) = input.efforts {
        normalize_provider_efforts(list)
    } else if let Some(m) = active_model.filter(|m| !m.efforts.is_empty()) {
        normalize_provider_efforts(&m.efforts)
    } else {
        decode_app_efforts(prev_app_efforts.as_deref())
    };
    let app_efforts_json = encode_app_efforts(&efforts);

    // Context window: `Some(0)` clears → None; `Some(n>0)` sets;
    // `None` prefers the active model's window, else keeps the existing
    // channel value on edit (create-only → None).
    let resolved_context_window: Option<u64> = match input.context_window {
        Some(0) => None,
        Some(n) => Some(n),
        None => active_model
            .and_then(|m| m.context_window)
            .filter(|n| *n > 0)
            .or_else(|| {
                existing
                    .and_then(|s| s.fields.get("context_window"))
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|n| *n > 0)
            }),
    };

    // Appended system-prompt rules: `Some("")` clears; `None` keeps the value
    // already on disk so an edit that omits the field is not a silent wipe.
    // `Some` is explicit even when sanitize turns "" into None — the old key
    // must not be copied back from the previous section.
    let append_prompt_explicit = input.append_prompt.is_some();
    let resolved_append_prompt: Option<String> = match input.append_prompt {
        Some(ref raw) => crate::store::sanitize_extra_rules(Some(raw.clone())),
        None => crate::store::sanitize_extra_rules(
            existing
                .and_then(|s| s.fields.get(APP_APPEND_PROMPT_KEY))
                .cloned(),
        ),
    };

    let supports_vision = match input.supports_vision {
        Some(v) => v,
        None => active_model
            .and_then(|m| m.supports_vision)
            .unwrap_or_else(|| {
                existing
                    .map(|s| supports_vision_from_fields(&s.fields))
                    .unwrap_or(false)
            }),
    };

    let extra_headers = match input.extra_headers {
        Some(ref list) => normalize_extra_headers(list),
        None => decode_extra_headers(
            existing
                .and_then(|s| s.fields.get(EXTRA_HEADERS_KEY))
                .map(|s| s.as_str()),
        ),
    };

    text = remove_section(&text, &id);
    let mut fields: Vec<(String, String)> = vec![
        ("model".into(), model),
        ("base_url".into(), base_url.clone()),
        ("name".into(), name),
        ("api_key".into(), next_key),
        ("api_backend".into(), api_backend),
        (APP_PROVIDER_MODE_KEY.into(), provider_mode),
    ];
    // The merge below copies unknown previous fields back; listing the kept
    // catalog here keeps its line position stable across saves.
    if let Some(raw) = app_models_field {
        fields.push((APP_MODELS_KEY.into(), raw));
    }
    if full_path {
        fields.push((APP_BASE_URL_FULL_PATH_KEY.into(), "true".into()));
    }
    if supports_vision {
        fields.push((APP_SUPPORTS_VISION_KEY.into(), "true".into()));
    }
    if !app_efforts_json.is_empty() && app_efforts_json != "[]" {
        fields.push((APP_EFFORTS_KEY.into(), app_efforts_json));
    }
    let models_support_reasoning = models.iter().any(|row| {
        row.supports_reasoning_effort == Some(true)
            || row.supports_reasoning_off == Some(true)
            || !row.efforts.is_empty()
    });
    fields.push((
        SUPPORTS_REASONING_EFFORT_KEY.into(),
        (!efforts.is_empty() || models_support_reasoning).to_string(),
    ));
    let channel_efforts = if models.len() == 1 && active_model.is_some() {
        normalize_provider_efforts(&efforts)
    } else {
        Vec::new()
    };
    let parent_cli_efforts = active_model
        .and_then(|model| {
            cli_efforts_for_model(
                model,
                (!channel_efforts.is_empty()).then_some(channel_efforts.as_slice()),
            )
        })
        .or_else(|| (!channel_efforts.is_empty()).then(|| channel_efforts.clone()));
    if let Some(list) = parent_cli_efforts {
        let raw = encode_cli_reasoning_efforts(&list);
        if !raw.is_empty() {
            fields.push((CLI_REASONING_EFFORTS_KEY.into(), raw));
        }
    }
    if let Some(ref p) = resolved_append_prompt {
        fields.push((APP_APPEND_PROMPT_KEY.into(), p.clone()));
    }
    if let Some(n) = resolved_context_window {
        fields.push(("context_window".into(), n.to_string()));
    }
    let extra_headers_toml = encode_extra_headers_toml(&extra_headers);
    if !extra_headers_toml.is_empty() {
        fields.push((EXTRA_HEADERS_KEY.into(), extra_headers_toml));
    }
    if let Some(up) = app_upstream {
        fields.push((
            crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY.into(),
            up,
        ));
    } else if keep_prev_upstream {
        if let Some(prev) = existing
            .and_then(|s| {
                s.fields
                    .get(crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY)
            })
            .cloned()
            .filter(|s| !s.trim().is_empty())
        {
            fields.push((
                crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY.into(),
                prev,
            ));
        }
    }
    if let Some(ex) = existing {
        let mut known: std::collections::HashSet<String> =
            fields.iter().map(|(k, _)| k.clone()).collect();
        // Always treated as managed — empty list must not copy the old table back.
        known.insert(EXTRA_HEADERS_KEY.into());
        // The CLI effort menu is derived from the active catalog row.
        known.insert(CLI_REASONING_EFFORTS_KEY.into());
        // `app_upstream_base_url` belongs to the loopback sanitize rewrite only;
        // a direct endpoint or the native proxy must not inherit the real host a
        // previous sanitize save stored. The one kept copy is pushed above.
        known.insert(crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY.into());
        // Explicit clear (`Some("")` → None) must drop the previous prompt.
        // Omitted (`None`) stays out of `known` so the kept value is copied.
        if append_prompt_explicit {
            known.insert(APP_APPEND_PROMPT_KEY.into());
        }
        // Omitted fields keep their previous value; explicit clears drop it.
        if context_window_explicit {
            known.insert("context_window".into());
        }
        if supports_vision_explicit {
            known.insert(APP_SUPPORTS_VISION_KEY.into());
        }
        if efforts_explicit {
            known.insert(APP_EFFORTS_KEY.into());
        }
        if base_url_full_path_explicit {
            known.insert(APP_BASE_URL_FULL_PATH_KEY.into());
        }
        for (k, v) in &ex.fields {
            if !known.contains(k) {
                fields.push((k.clone(), v.clone()));
            }
        }
    }
    text = append_section(&text, &id, &fields);

    write_text(&path, &text)?;
    let _ = ensure_custom_ids_in_allowed_models();
    list_custom_providers()
}

pub fn remove_custom_provider(id: &str) -> Result<ProvidersListResult, String> {
    let id = sanitize_id(id)?;
    let path = agent_config_toml();
    let mut text = read_text(&path);
    let sections = parse_model_sections(&text);
    if !sections.iter().any(|s| s.id == id) {
        // Fail loudly so the UI cannot think a delete succeeded when the
        // section was already gone or the id did not match (re-add ghosts).
        return Err(format!("provider `{id}` not found"));
    }
    text = remove_section(&text, &id);
    // Verify the section is actually gone before reporting success.
    if parse_model_sections(&text).iter().any(|s| s.id == id) {
        return Err(format!("failed to remove provider `{id}` from config"));
    }
    // `[models].default` is a legacy CLI key the App never writes to route a
    // chat, so a default naming another provider stays as stored. Only a
    // default pointing at the section just removed is reset: left dangling, a
    // spawn without `--model` would make the CLI read a deleted section.
    if get_models_default(&text).as_deref() == Some(id.as_str()) {
        text = set_models_default(&text, OFFICIAL_DEFAULT_MODEL);
    }
    write_text(&path, &text)?;
    // The next connect for a chat on this provider falls back to official and
    // prepares its own auth under the spawn lock.
    list_custom_providers()
}

fn resolve_stored_key(provider_id: Option<&str>) -> String {
    let Some(pid) = provider_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let Ok(sid) = sanitize_id(pid) else {
        return String::new();
    };
    let text = read_text(&agent_config_toml());
    parse_model_sections(&text)
        .into_iter()
        .find(|s| s.id == sid)
        .and_then(|s| s.fields.get("api_key").cloned())
        .unwrap_or_default()
}

fn resolve_stored_base(provider_id: Option<&str>) -> String {
    let Some(pid) = provider_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let Ok(sid) = sanitize_id(pid) else {
        return String::new();
    };
    let text = read_text(&agent_config_toml());
    parse_model_sections(&text)
        .into_iter()
        .find(|s| s.id == sid)
        .and_then(|s| s.fields.get("base_url").cloned())
        .unwrap_or_default()
}

pub fn models_list_endpoint(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("base_url is required".into());
    }
    if base.to_ascii_lowercase().ends_with("/models") {
        return Ok(base.to_string());
    }
    Ok(format!("{base}/models"))
}

pub async fn ping_provider(
    base_url: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<ProviderPingResult, String> {
    let mut base = base_url.unwrap_or_default().trim().to_string();
    if base.is_empty() {
        base = resolve_stored_base(provider_id.as_deref());
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("base_url must start with http:// or https://".into());
    }
    let mut key = api_key.unwrap_or_default().trim().to_string();
    if key.is_empty() {
        key = resolve_stored_key(provider_id.as_deref());
    }
    let endpoint = models_list_endpoint(&base)?;
    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let mut req = client.get(&endpoint).header("Accept", "application/json");
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    match req.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let _ = res.bytes().await;
            Ok(ProviderPingResult {
                ok: true,
                latency_ms: t0.elapsed().as_millis() as u64,
                endpoint,
                status: Some(status),
                error: None,
            })
        }
        Err(e) => Ok(ProviderPingResult {
            ok: false,
            latency_ms: t0.elapsed().as_millis() as u64,
            endpoint,
            status: None,
            error: Some(e.to_string()),
        }),
    }
}

pub async fn list_remote_models(
    base_url: String,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<RemoteModelsResult, String> {
    let base = base_url.trim().to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("base_url must start with http:// or https://".into());
    }
    let mut key = api_key.unwrap_or_default().trim().to_string();
    if key.is_empty() {
        key = resolve_stored_key(provider_id.as_deref());
    }
    if key.is_empty() {
        return Err("api_key is required to list models".into());
    }
    let endpoint = models_list_endpoint(&base)?;
    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "models HTTP {}: {}",
            status.as_u16(),
            text.chars().take(240).collect::<String>()
        ));
    }
    parse_remote_models_response(endpoint, &text)
}

/// Blocking model-catalog probe for import paths that already run on a
/// dedicated blocking worker. The key is request-only and must never be logged.
pub fn list_remote_models_blocking(
    base_url: &str,
    api_key: &str,
) -> Result<RemoteModelsResult, String> {
    let base = base_url.trim();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("base_url must start with http:// or https://".into());
    }
    let key = api_key.trim();
    if key.is_empty() {
        return Err("api_key is required to list models".into());
    }
    let endpoint = models_list_endpoint(base)?;
    let client = crate::proxy::apply_to_reqwest_blocking(
        reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(20)),
    )
    .build()
    .map_err(|e| e.to_string())?;
    let res = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let text = res.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "models HTTP {}: {}",
            status.as_u16(),
            text.chars().take(240).collect::<String>()
        ));
    }
    parse_remote_models_response(endpoint, &text)
}

fn parse_remote_models_response(
    endpoint: String,
    text: &str,
) -> Result<RemoteModelsResult, String> {
    let data: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "models response is not JSON".to_string())?;
    let arr = if let Some(a) = data.as_array() {
        a.clone()
    } else if let Some(a) = data.get("data").and_then(|d| d.as_array()) {
        a.clone()
    } else {
        Vec::new()
    };
    let mut models = Vec::new();
    for item in arr {
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(id) = id else { continue };
        let (supports_vision, supports_video) = remote_modalities(&item);
        let reasoning_efforts = remote_reasoning_efforts(&item);
        models.push(RemoteModel {
            id: id.to_string(),
            owned_by: item
                .get("owned_by")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            supports_backend_search: item
                .get("supports_backend_search")
                .and_then(|x| x.as_bool()),
            context_window: remote_context_window(&item),
            supports_vision,
            supports_video,
            supports_reasoning_effort: remote_supports_reasoning_effort(
                &item,
                !reasoning_efforts.is_empty(),
            ),
            reasoning_efforts,
        });
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    // A model id is the picker and routing identity; the first advertised row
    // wins so a duplicated id cannot appear twice with different metadata.
    models.dedup_by(|a, b| a.id == b.id);
    Ok(RemoteModelsResult { endpoint, models })
}

fn json_positive_u64(v: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        let Some(raw) = v.get(*key) else { continue };
        let n = if let Some(n) = raw.as_u64() {
            n
        } else if let Some(f) = raw.as_f64() {
            if f.is_finite() && f > 0.0 {
                f as u64
            } else {
                continue;
            }
        } else if let Some(s) = raw.as_str() {
            match s.replace(['_', ','], "").parse::<u64>() {
                Ok(n) => n,
                Err(_) => continue,
            }
        } else {
            continue;
        };
        if n > 0 {
            return Some(n);
        }
    }
    None
}

fn remote_context_window(item: &serde_json::Value) -> Option<u64> {
    const KEYS: &[&str] = &[
        "context_window",
        "contextWindow",
        "context_length",
        "contextLength",
        "max_model_len",
        "max_context_length",
    ];
    if let Some(n) = json_positive_u64(item, KEYS) {
        return Some(n);
    }
    if let Some(arch) = item.get("architecture") {
        if let Some(n) = json_positive_u64(arch, KEYS) {
            return Some(n);
        }
    }
    if let Some(top) = item.get("top_provider") {
        if let Some(n) = json_positive_u64(top, KEYS) {
            return Some(n);
        }
    }
    None
}

fn collect_modality_tokens(item: &serde_json::Value) -> String {
    let mut bits = String::new();
    let push = |out: &mut String, s: &str| {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&s.to_ascii_lowercase());
    };
    if let Some(s) = item
        .get("architecture")
        .and_then(|a| a.get("modality"))
        .and_then(|x| x.as_str())
    {
        push(&mut bits, s);
    }
    if let Some(arr) = item
        .get("architecture")
        .and_then(|a| a.get("input_modalities"))
        .and_then(|x| x.as_array())
    {
        for v in arr {
            if let Some(s) = v.as_str() {
                push(&mut bits, s);
            }
        }
    }
    for key in [
        "supports_vision",
        "vision",
        "supports_image",
        "supports_video",
    ] {
        if item.get(key).and_then(|x| x.as_bool()) == Some(true) {
            push(&mut bits, key);
        }
    }
    bits
}

/// Upper bounds for vendor-provided reasoning metadata. These fields are
/// extensions, not part of the OpenAI `/models` shape, so a long or repeated
/// list must not be able to grow the stored catalog without limit.
const MAX_REMOTE_REASONING_EFFORTS: usize = 32;
const MAX_REMOTE_EFFORT_ID_CHARS: usize = 64;
const MAX_REMOTE_EFFORT_NAME_CHARS: usize = 80;

fn bounded_remote_text(raw: &str, max_chars: usize) -> String {
    raw.trim().chars().take(max_chars).collect()
}

fn remote_effort_text(
    entry: &serde_json::Value,
    keys: &[&str],
    max_chars: usize,
) -> Option<String> {
    keys.iter()
        .find_map(|key| entry.get(*key).and_then(|value| value.as_str()))
        .map(|raw| bounded_remote_text(raw, max_chars))
        .filter(|value| !value.is_empty())
}

fn remote_reasoning_efforts(item: &serde_json::Value) -> Vec<ProviderEffortEntry> {
    let Some(entries) = ["reasoning_efforts", "reasoningEfforts"]
        .iter()
        .find_map(|key| item.get(*key).and_then(|value| value.as_array()))
    else {
        return Vec::new();
    };
    let efforts: Vec<ProviderEffortEntry> = entries
        .iter()
        .take(MAX_REMOTE_REASONING_EFFORTS)
        .filter_map(|entry| {
            let id = entry
                .as_str()
                .map(|raw| bounded_remote_text(raw, MAX_REMOTE_EFFORT_ID_CHARS))
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    remote_effort_text(
                        entry,
                        &["id", "value", "effort"],
                        MAX_REMOTE_EFFORT_ID_CHARS,
                    )
                })?;
            let name = remote_effort_text(entry, &["name", "label"], MAX_REMOTE_EFFORT_NAME_CHARS)
                .unwrap_or_else(|| id.clone());
            let is_default = ["isDefault", "is_default", "default"]
                .iter()
                .find_map(|key| entry.get(*key).and_then(|value| value.as_bool()))
                .unwrap_or(false);
            Some(ProviderEffortEntry {
                id,
                name,
                is_default,
            })
        })
        .collect();
    normalize_provider_efforts(&efforts)
}

fn remote_supports_reasoning_effort(item: &serde_json::Value, has_ladder: bool) -> Option<bool> {
    if has_ladder {
        return Some(true);
    }
    ["supports_reasoning_effort", "supportsReasoningEffort"]
        .iter()
        .find_map(|key| item.get(*key).and_then(|value| value.as_bool()))
}

fn remote_modalities(item: &serde_json::Value) -> (Option<bool>, Option<bool>) {
    let tokens = collect_modality_tokens(item);
    if tokens.is_empty() {
        return (None, None);
    }
    let vision =
        if tokens.contains("image") || tokens.contains("vision") || tokens.contains("multimodal") {
            Some(true)
        } else if item.get("supports_vision").and_then(|x| x.as_bool()) == Some(false) {
            Some(false)
        } else {
            None
        };
    let video = if tokens.contains("video") {
        Some(true)
    } else {
        None
    };
    (vision, video)
}

// ── Per-model connection probe (mirrors ZCode "测试模型") ─────────────────────

fn classify_test_status(status: u16) -> &'static str {
    match status {
        401 | 403 => "auth",
        404 => "model_not_found",
        429 => "rate_limit",
        s if s >= 500 => "server",
        _ => "unknown",
    }
}

/// Pull a human-readable reason out of an error response body.
///
/// Mirrors ZCode's `readHttpErrorMessage`: tries JSON `error` / `error.message`
/// / `message` / `detail`, strips HTML tags, collapses whitespace, truncates to
/// 240 chars. Falls back to `None` when nothing usable is present.
fn extract_http_error_message(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        v.get("error")
            .and_then(|e| {
                e.as_str().map(str::to_string).or_else(|| {
                    e.get("message")
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                })
            })
            .or_else(|| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .or_else(|| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
    } else {
        None
    };
    let raw = candidate.unwrap_or_else(|| trimmed.to_string());
    // strip HTML tags
    let no_tags = raw
        .chars()
        .fold((String::new(), false), |(mut out, mut in_tag), c| {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(c),
                _ => {}
            }
            (out, in_tag)
        })
        .0;
    // collapse whitespace
    let collapsed: String = no_tags.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed.chars().take(240).collect())
    }
}

/// Test whether a specific model id is usable on a custom provider by sending
/// one tiny non-streaming inference request. Success = HTTP 2xx (mirrors ZCode).
///
/// Honors each channel's `api_backend` (`chat_completions` | `responses` |
/// `messages`) so a responses-only relay is not falsely flagged as failing.
/// Probes the **real upstream**, unwrapping the loopback SSE-sanitize proxy
/// the same way the balance probe does.
pub async fn test_model_connection(
    base_url: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
    model: String,
    api_backend: Option<String>,
    base_url_full_path: Option<bool>,
) -> Result<ProviderTestResult, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("model id is required to test connection".into());
    }

    // Resolve base URL; unwrap loopback SSE-sanitize proxy → real upstream.
    let mut base = base_url.unwrap_or_default().trim().to_string();
    let mut fields_opt: Option<std::collections::HashMap<String, String>> = None;
    if base.is_empty() {
        fields_opt = resolve_provider_fields(provider_id.as_deref());
        if let Some(ref fields) = fields_opt {
            base = crate::relay_stream_proxy::effective_upstream_base(fields);
        }
    } else if crate::relay_stream_proxy::is_local_sanitize_proxy_url(&base) {
        fields_opt = resolve_provider_fields(provider_id.as_deref());
        if let Some(ref fields) = fields_opt {
            let up = crate::relay_stream_proxy::effective_upstream_base(fields);
            if !up.is_empty() {
                base = up;
            }
        }
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("base_url must start with http:// or https://".into());
    }

    // Resolve api key (form value wins; else stored config).
    let mut key = api_key.unwrap_or_default().trim().to_string();
    if key.is_empty() {
        key = resolve_stored_key(provider_id.as_deref());
    }

    // Resolve backend + full_path (form value wins; else stored config).
    let caller_backend = api_backend
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut backend = normalize_backend(caller_backend);
    let mut full_path = base_url_full_path.unwrap_or(false);
    if let Some(ref fields) = fields_opt {
        if caller_backend.is_none() {
            if let Some(b) = fields.get("api_backend") {
                backend = normalize_backend(Some(b));
            }
        }
        if !full_path {
            full_path = base_url_full_path_from_fields(fields);
        }
    }

    let root = normalize_openai_base_url(&base, &backend, full_path);
    // Per-backend endpoint path + minimal body (matches ZCode connectivity probe).
    let (path, body) = match backend.as_str() {
        "responses" => (
            "/responses",
            serde_json::json!({ "model": model, "input": "hi", "max_output_tokens": 1 })
                .to_string(),
        ),
        "messages" => (
            // Anthropic-style: normalize_openai_base_url already ensured `/v1`.
            "/messages",
            serde_json::json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "hi" }]
            })
            .to_string(),
        ),
        _ => (
            // chat_completions (default)
            "/chat/completions",
            serde_json::json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "hi" }]
            })
            .to_string(),
        ),
    };
    let endpoint = format!("{root}{path}");

    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let mut req = client
        .post(&endpoint)
        .header("content-type", "application/json")
        .header("accept", "application/json");
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    // Anthropic-style channels need the version header + x-api-key (ZCode sends both).
    if backend == "messages" {
        req = req
            .header("anthropic-version", "2023-06-01")
            .header("x-api-key", &key);
    }

    match req.body(body).send().await {
        Ok(res) => {
            let status_code = res.status().as_u16();
            let text = res.text().await.unwrap_or_default();
            let latency_ms = t0.elapsed().as_millis() as u64;
            if res_is_success(status_code) {
                return Ok(ProviderTestResult {
                    ok: true,
                    latency_ms,
                    endpoint,
                    status: Some(status_code),
                    error_kind: None,
                    error: None,
                });
            }
            let error_kind = classify_test_status(status_code).to_string();
            let error =
                extract_http_error_message(&text).unwrap_or_else(|| format!("HTTP {status_code}"));
            Ok(ProviderTestResult {
                ok: false,
                latency_ms,
                endpoint,
                status: Some(status_code),
                error_kind: Some(error_kind),
                error: Some(error),
            })
        }
        Err(e) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            let error_kind = if e.is_timeout() { "timeout" } else { "network" };
            Ok(ProviderTestResult {
                ok: false,
                latency_ms,
                endpoint,
                status: None,
                error_kind: Some(error_kind.into()),
                error: Some(e.to_string()),
            })
        }
    }
}

fn res_is_success(status: u16) -> bool {
    (200..300).contains(&status)
}

// ── Provider balance probe (DeepSeek first; extensible adapters) ─────────────

/// One currency row from a balance/plan probe (amounts stay strings).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBalanceLine {
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
}

/// Normalized balance / plan probe result for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBalanceResult {
    /// `balance` | `plan` | `unsupported`
    pub kind: String,
    pub provider: String,
    pub endpoint: String,
    pub ok: bool,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// `auth` | `network` | `timeout` | `unsupported` | `other`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balances: Option<Vec<ProviderBalanceLine>>,
}

const DEEPSEEK_BALANCE_HOST: &str = "api.deepseek.com";
const DEEPSEEK_BALANCE_FIXED: &str = "https://api.deepseek.com/user/balance";

/// Host component of a URL (lowercase), empty if unparseable.
pub fn url_host_lower(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    // Prefer full URL parse; fall back to stripping scheme manually.
    if let Ok(u) = url::Url::parse(t) {
        return u.host_str().unwrap_or("").to_ascii_lowercase();
    }
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))
        .unwrap_or(t);
    rest.split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Whether this channel can use DeepSeek's official balance API.
pub fn is_deepseek_balance_target(provider_id: Option<&str>, base_url: &str) -> bool {
    let host = url_host_lower(base_url);
    if host == DEEPSEEK_BALANCE_HOST || host.ends_with(&format!(".{DEEPSEEK_BALANCE_HOST}")) {
        return true;
    }
    let id = provider_id.unwrap_or("").trim().to_ascii_lowercase();
    if id.is_empty() {
        return false;
    }
    id == "deepseek" || id.starts_with("deepseek-") || id.ends_with("-deepseek")
}

/// Build DeepSeek balance URL from a stored OpenAI-compatible base.
///
/// Balance lives at origin root (`/user/balance`), **not** under `/v1`.
pub fn deepseek_balance_endpoint(base_url: &str) -> Result<String, String> {
    let t = base_url.trim();
    if t.is_empty() {
        return Ok(DEEPSEEK_BALANCE_FIXED.to_string());
    }
    let host = url_host_lower(t);
    if !host.is_empty()
        && host != DEEPSEEK_BALANCE_HOST
        && !host.ends_with(&format!(".{DEEPSEEK_BALANCE_HOST}"))
    {
        // Id-matched DeepSeek with a non-DeepSeek host → still hit official API.
        return Ok(DEEPSEEK_BALANCE_FIXED.to_string());
    }
    if let Ok(u) = url::Url::parse(t) {
        let mut origin = format!(
            "{}://{}",
            u.scheme(),
            u.host_str().unwrap_or(DEEPSEEK_BALANCE_HOST)
        );
        if let Some(port) = u.port() {
            origin.push(':');
            origin.push_str(&port.to_string());
        }
        return Ok(format!("{origin}/user/balance"));
    }
    // Manual strip: remove path after host, especially trailing /v1.
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))
        .unwrap_or(t);
    let scheme = if t.starts_with("http://") {
        "http"
    } else {
        "https"
    };
    let host_part = rest.split('/').next().unwrap_or(DEEPSEEK_BALANCE_HOST);
    Ok(format!("{scheme}://{host_part}/user/balance"))
}

/// Parse DeepSeek `GET /user/balance` JSON. Amounts stay strings.
pub fn parse_deepseek_balance_json(body: &str) -> Result<(bool, Vec<ProviderBalanceLine>), String> {
    let data: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "balance response is not JSON".to_string())?;
    let is_available = data
        .get("is_available")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| "balance response missing is_available".to_string())?;
    let mut lines = Vec::new();
    if let Some(arr) = data.get("balance_infos").and_then(|v| v.as_array()) {
        for item in arr {
            let currency = item
                .get("currency")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("")
                .to_string();
            // Amounts may arrive as string or number — always store as string.
            let as_str = |key: &str| -> Option<String> {
                let v = item.get(key)?;
                if let Some(s) = v.as_str() {
                    let t = s.trim();
                    if t.is_empty() {
                        return None;
                    }
                    return Some(t.to_string());
                }
                if let Some(n) = v.as_f64() {
                    // Avoid inventing trailing zeros; keep compact display.
                    return Some(n.to_string());
                }
                if let Some(n) = v.as_i64() {
                    return Some(n.to_string());
                }
                None
            };
            let Some(total) = as_str("total_balance") else {
                continue;
            };
            lines.push(ProviderBalanceLine {
                currency,
                total_balance: total,
                granted_balance: as_str("granted_balance").unwrap_or_default(),
                topped_up_balance: as_str("topped_up_balance").unwrap_or_default(),
            });
        }
    }
    Ok((is_available, lines))
}

fn resolve_provider_fields(
    provider_id: Option<&str>,
) -> Option<std::collections::HashMap<String, String>> {
    let pid = provider_id.map(str::trim).filter(|s| !s.is_empty())?;
    let sid = sanitize_id(pid).ok()?;
    let text = read_text(&agent_config_toml());
    parse_model_sections(&text)
        .into_iter()
        .find(|s| s.id == sid)
        .map(|s| s.fields)
}

fn resolve_balance_base(base_url: Option<&str>, provider_id: Option<&str>) -> String {
    let mut base = base_url.unwrap_or("").trim().to_string();
    if base.is_empty() {
        if let Some(fields) = resolve_provider_fields(provider_id) {
            base = crate::relay_stream_proxy::effective_upstream_base(&fields);
        }
    } else if crate::relay_stream_proxy::is_local_sanitize_proxy_url(&base) {
        if let Some(fields) = resolve_provider_fields(provider_id) {
            let up = crate::relay_stream_proxy::effective_upstream_base(&fields);
            if !up.is_empty() {
                base = up;
            }
        }
    }
    base
}

/// Query provider balance (Phase 1: DeepSeek only).
pub async fn query_provider_balance(
    base_url: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<ProviderBalanceResult, String> {
    let base = resolve_balance_base(base_url.as_deref(), provider_id.as_deref());
    let pid = provider_id.as_deref();

    if !is_deepseek_balance_target(pid, &base) {
        return Ok(ProviderBalanceResult {
            kind: "unsupported".into(),
            provider: "unknown".into(),
            endpoint: String::new(),
            ok: false,
            latency_ms: 0,
            status: None,
            error: Some("Balance probe is only supported for DeepSeek (api.deepseek.com)".into()),
            error_kind: Some("unsupported".into()),
            is_available: None,
            balances: None,
        });
    }

    let mut key = api_key.unwrap_or_default().trim().to_string();
    if key.is_empty() {
        key = resolve_stored_key(pid);
    }
    if key.is_empty() {
        return Ok(ProviderBalanceResult {
            kind: "balance".into(),
            provider: "deepseek".into(),
            endpoint: deepseek_balance_endpoint(&base)
                .unwrap_or_else(|_| DEEPSEEK_BALANCE_FIXED.into()),
            ok: false,
            latency_ms: 0,
            status: None,
            error: Some("api_key is required to query balance".into()),
            error_kind: Some("auth".into()),
            is_available: None,
            balances: None,
        });
    }

    let endpoint = deepseek_balance_endpoint(&base)?;
    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let req = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json");

    match req.send().await {
        Ok(res) => {
            let status = res.status();
            let code = status.as_u16();
            let text = res.text().await.unwrap_or_default();
            let latency_ms = t0.elapsed().as_millis() as u64;
            if code == 401 || code == 403 {
                return Ok(ProviderBalanceResult {
                    kind: "balance".into(),
                    provider: "deepseek".into(),
                    endpoint,
                    ok: false,
                    latency_ms,
                    status: Some(code),
                    error: Some(format!(
                        "balance HTTP {}: {}",
                        code,
                        text.chars().take(200).collect::<String>()
                    )),
                    error_kind: Some("auth".into()),
                    is_available: None,
                    balances: None,
                });
            }
            if !status.is_success() {
                return Ok(ProviderBalanceResult {
                    kind: "balance".into(),
                    provider: "deepseek".into(),
                    endpoint,
                    ok: false,
                    latency_ms,
                    status: Some(code),
                    error: Some(format!(
                        "balance HTTP {}: {}",
                        code,
                        text.chars().take(200).collect::<String>()
                    )),
                    error_kind: Some("other".into()),
                    is_available: None,
                    balances: None,
                });
            }
            match parse_deepseek_balance_json(&text) {
                Ok((is_available, balances)) => Ok(ProviderBalanceResult {
                    kind: "balance".into(),
                    provider: "deepseek".into(),
                    endpoint,
                    ok: true,
                    latency_ms,
                    status: Some(code),
                    error: None,
                    error_kind: None,
                    is_available: Some(is_available),
                    balances: Some(balances),
                }),
                Err(e) => Ok(ProviderBalanceResult {
                    kind: "balance".into(),
                    provider: "deepseek".into(),
                    endpoint,
                    ok: false,
                    latency_ms,
                    status: Some(code),
                    error: Some(e),
                    error_kind: Some("other".into()),
                    is_available: None,
                    balances: None,
                }),
            }
        }
        Err(e) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            let msg = e.to_string();
            let kind = if e.is_timeout() || msg.to_ascii_lowercase().contains("timed out") {
                "timeout"
            } else {
                "network"
            };
            Ok(ProviderBalanceResult {
                kind: "balance".into(),
                provider: "deepseek".into(),
                endpoint,
                ok: false,
                latency_ms,
                status: None,
                error: Some(msg),
                error_kind: Some(kind.into()),
                is_available: None,
                balances: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_default_prefers_flag_then_first_spawnable() {
        let mk = |id: &str, is_default: bool| crate::models_catalog::ReasoningEffort {
            id: id.into(),
            value: id.into(),
            label: id.into(),
            description: String::new(),
            is_default,
        };
        // 有显式 default → default。
        let flagged = vec![mk("low", false), mk("high", true)];
        assert_eq!(
            reasoning_effort_catalog_default(&flagged).as_deref(),
            Some("high")
        );
        // 无 default → 首个非空且非 `none` 的档位（不再优先 medium）。
        let no_default = vec![mk("low", false), mk("medium", false), mk("high", false)];
        assert_eq!(
            reasoning_effort_catalog_default(&no_default).as_deref(),
            Some("low")
        );
        // Off 前置（模型行显式开启 Off 或目录把 none 排在最前）时，
        // 默认档跳过 `none`，与前端 `pickDefaultEffort` 同一规则。
        let off_first = vec![mk("none", false), mk("low", false), mk("high", false)];
        assert_eq!(
            reasoning_effort_catalog_default(&off_first).as_deref(),
            Some("low")
        );
        let ladder_off_first: Vec<ProviderEffortEntry> = off_first
            .iter()
            .map(|e| ProviderEffortEntry {
                id: e.id.clone(),
                name: e.id.clone(),
                is_default: e.is_default,
            })
            .collect();
        assert_eq!(
            reasoning_effort_ladder_default(&ladder_off_first).as_deref(),
            Some("low"),
            "Off 永不做隐式默认档"
        );
        // 完全没有可 spawn 档 → None，由调用方回退 medium。
        assert_eq!(reasoning_effort_catalog_default(&[mk(" ", false)]), None);
    }

    #[test]
    fn canonical_wire_effort_maps_aliases_to_tiers() {
        // ladder 表编码用的 canonical 映射：raw id → 最近固定档。
        assert_eq!(canonical_wire_effort("low"), "low");
        assert_eq!(canonical_wire_effort("medium"), "medium");
        assert_eq!(canonical_wire_effort("high"), "high");
        assert_eq!(canonical_wire_effort("minimal"), "minimal");
        assert_eq!(canonical_wire_effort("xhigh"), "xhigh");
        // instant 是 App 菜单 id，canonical 映射到 minimal。
        assert_eq!(canonical_wire_effort("instant"), "minimal");
        assert_eq!(canonical_wire_effort("none"), "none");
        assert_eq!(canonical_wire_effort("off"), "none");
        assert_eq!(canonical_wire_effort("max"), "max");
        // 未知 id canonical 兜到 medium。
        assert_eq!(canonical_wire_effort("bogus"), "medium");
    }

    #[test]
    fn hot_apply_is_wire_exact_for_duplicate_value_ladder_ids() {
        // 同 value 多原始 id 的 ladder：spawn 腿 `--reasoning-effort <raw>` 由
        // CLI 按 reasoning_efforts 表映射到 value；RPC 腿原样透传 raw id，
        // CLI 侧同样经表映射。两条腿线级一致，热切换精确，不需要为消除
        // "歧义"而强制 respawn。
        let ladder = [
            ProviderEffortEntry {
                id: "instant".into(),
                name: "Instant".into(),
                is_default: false,
            },
            ProviderEffortEntry {
                id: "balanced".into(),
                name: "Balanced".into(),
                is_default: true,
            },
            ProviderEffortEntry {
                id: "deliberate".into(),
                name: "Deliberate".into(),
                is_default: false,
            },
        ];
        let table = encode_cli_reasoning_efforts(&ladder);
        // 表中每个 id 的 value 必须存在：CLI 侧 raw id → value 映射的
        // 唯一来源。
        for effort in &ladder {
            let needle = format!(
                "id = \"{}\", value = \"{}\"",
                effort.id,
                canonical_wire_effort(&effort.id)
            );
            assert!(table.contains(&needle), "missing row: {needle} in {table}");
        }
        // balanced 与 deliberate 共享 value = medium：线级无差异。
        assert_eq!(
            canonical_wire_effort("balanced"),
            canonical_wire_effort("deliberate")
        );
    }

    #[test]
    fn sanitize_and_endpoint() {
        assert_eq!(sanitize_id("My Relay").unwrap(), "my-relay");
        assert!(models_list_endpoint("https://x.example/v1")
            .unwrap()
            .ends_with("/v1/models"));
    }

    #[test]
    fn allowlist_absent_is_left_alone() {
        let text = "\
[models]
default = \"kiro\"

[model.kiro]
model = \"simple-task\"
base_url = \"http://127.0.0.1:8080/v1\"
";
        assert!(union_custom_ids_into_allowed_models(text, &["kiro".into()]).is_none());
    }

    #[test]
    fn allowlist_gains_uncovered_section_ids_and_keeps_patterns() {
        let text = "\
[models]
default = \"kiro\"
allowed_models = [\"claude-*\", \"gpt-*\", \"auto*\"]

[model.kiro]
model = \"simple-task\"
base_url = \"http://127.0.0.1:8080/v1\"
";
        let next = union_custom_ids_into_allowed_models(text, &["kiro".into(), "auto".into()])
            .expect("kiro is not covered");
        let allow_line = next
            .lines()
            .find(|line| line.contains("allowed_models"))
            .unwrap();
        assert!(allow_line.contains("\"claude-*\""));
        assert!(allow_line.contains("\"gpt-*\""));
        assert!(allow_line.contains("\"auto*\""));
        assert!(allow_line.contains("\"kiro\""));
        assert!(!allow_line.contains("simple-task"));
        assert!(
            union_custom_ids_into_allowed_models(&next, &["kiro".into(), "auto".into()]).is_none()
        );
    }

    #[test]
    fn allowlist_multiline_array_and_non_array_are_safe() {
        let text = "\
[models]
allowed_models = [
  \"claude-*\",
  # user note
]

[model.ada-openai]
base_url = \"http://example/v1\"
model = \"auto\"
";
        let ids = custom_section_ids(text);
        assert_eq!(ids, vec!["ada-openai".to_string()]);
        let next = union_custom_ids_into_allowed_models(text, &ids).expect("append");
        assert!(next.contains("ada-openai"));
        assert!(next.contains("claude-*"));
        assert!(union_custom_ids_into_allowed_models(
            "[models]\nallowed_models = \"kiro\"\n",
            &["kiro".into()],
        )
        .is_none());
    }

    #[test]
    fn allowlist_file_edit_stays_in_agent_home() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!(
            "grok-app-allowlist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("agent-home")).unwrap();
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &tmp);
        let decoy = tmp.join("shared-grok-config.toml");
        std::fs::write(&decoy, "allowed_models = [\"claude-*\"]\n").unwrap();
        std::fs::write(
            crate::paths::agent_config_toml(),
            "\
[models]
allowed_models = [\"claude-*\"]

[model.kiro]
model = \"simple-task\"
base_url = \"http://127.0.0.1:8080/v1\"
",
        )
        .unwrap();
        ensure_custom_ids_in_allowed_models().unwrap();
        let home = std::fs::read_to_string(crate::paths::agent_config_toml()).unwrap();
        let allow_line = home
            .lines()
            .find(|line| line.contains("allowed_models"))
            .unwrap();
        assert!(allow_line.contains("\"kiro\""));
        assert!(allow_line.contains("\"claude-*\""));
        assert!(!allow_line.contains("simple-task"));
        assert_eq!(
            std::fs::read_to_string(&decoy).unwrap(),
            "allowed_models = [\"claude-*\"]\n"
        );
        ensure_custom_ids_in_allowed_models().unwrap();
        assert_eq!(
            std::fs::read_to_string(crate::paths::agent_config_toml()).unwrap(),
            home
        );
        match previous {
            Some(v) => std::env::set_var("GROK_APP_HOME", v),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn sample_provider(id: &str) -> CustomProvider {
        CustomProvider {
            id: id.into(),
            model: "m".into(),
            base_url: "https://ex/v1".into(),
            name: id.into(),
            has_api_key: true,
            api_backend: "responses".into(),
            provider_mode: PROVIDER_MODE_GENERIC.into(),
            is_default: false,
            models: vec![],
            model_catalog_corrupt: false,
            efforts: vec![],
            context_window: None,
            base_url_full_path: false,
            append_prompt: None,
            supports_vision: false,
            extra_headers: vec![],
        }
    }

    #[test]
    fn provider_model_context_window_prefers_row_then_channel() {
        let mut provider = sample_provider("relay");
        provider.model = "m".into();
        provider.context_window = Some(900_000);
        let mut row = ProviderModelEntry::named("m", "Model");
        row.context_window = Some(1_000_000);
        provider.models = vec![row];

        assert_eq!(
            custom_window_from_row(&provider, "m", None),
            1_000_000,
            "the catalog row wins over the channel field"
        );
        assert_eq!(
            custom_window_from_row(&provider, "relay__m", Some("m")),
            1_000_000,
            "a generic child section resolves back to its catalog row"
        );

        provider.models.clear();
        assert_eq!(
            custom_window_from_row(&provider, "relay__m", Some("m")),
            900_000,
            "without a row the channel window applies"
        );
        provider.context_window = Some(0);
        assert_eq!(
            custom_window_from_row(&provider, "m", None),
            DEFAULT_CUSTOM_CONTEXT_WINDOW,
            "an unconfigured custom provider still applies the 1M default"
        );
    }

    #[test]
    fn custom_window_from_row_ignores_empty_row_window() {
        let mut provider = sample_provider("relay");
        provider.model = "m".into();
        provider.context_window = None;
        let mut row = ProviderModelEntry::named("m", "Model");
        row.context_window = Some(0);
        provider.models = vec![row];

        assert_eq!(
            custom_window_from_row(&provider, "m", None),
            DEFAULT_CUSTOM_CONTEXT_WINDOW,
            "a zero row window falls through to the 1M default"
        );
    }

    #[test]
    fn custom_model_effort_ladder_filters_invalid_ids_before_defaulting() {
        let mut provider = sample_provider("relay");
        provider.model = "m".into();
        provider.models = vec![ProviderModelEntry {
            id: "m".into(),
            name: "Model".into(),
            efforts: vec![
                ProviderEffortEntry {
                    id: "two words".into(),
                    name: "Invalid".into(),
                    is_default: true,
                },
                ProviderEffortEntry {
                    id: "medium".into(),
                    name: "Medium".into(),
                    is_default: false,
                },
            ],
            ..Default::default()
        }];

        let ladder = custom_model_effort_ladder(&provider, "m").expect("valid ladder");
        assert_eq!(
            ladder
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["medium"]
        );
        assert_eq!(
            reasoning_effort_ladder_default(&ladder).as_deref(),
            Some("medium")
        );
    }

    #[test]
    fn corrupt_catalog_uses_recovered_row_for_inherited_models_only() {
        let mut provider = sample_provider("relay");
        provider.model = "stale-channel-model".into();
        provider.model_catalog_corrupt = true;
        provider.models = vec![
            ProviderModelEntry::named("m1", "Model 1"),
            ProviderModelEntry::named("m2", "Model 2"),
        ];

        assert_eq!(
            resolved_custom_model_id_for_session(&provider, "grok-4.7", false),
            "m1"
        );
        assert_eq!(
            resolved_custom_model_id_for_session(&provider, "grok-4.7", true),
            "grok-4.7"
        );
    }

    #[test]
    fn reserved_custom_ids() {
        assert!(is_reserved_custom_provider_id("grok"));
        assert!(is_reserved_custom_provider_id("GROK"));
        assert!(is_reserved_custom_provider_id("official"));
        assert!(!is_reserved_custom_provider_id("grok-relay"));
        assert!(!is_reserved_custom_provider_id("relay"));
    }

    #[test]
    fn deepseek_balance_endpoint_strips_v1() {
        assert_eq!(
            deepseek_balance_endpoint("https://api.deepseek.com/v1").unwrap(),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            deepseek_balance_endpoint("https://api.deepseek.com/v1/").unwrap(),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            deepseek_balance_endpoint("https://api.deepseek.com").unwrap(),
            "https://api.deepseek.com/user/balance"
        );
        // Id-only path with non-DeepSeek host still uses official endpoint.
        assert_eq!(
            deepseek_balance_endpoint("https://relay.example.com/v1").unwrap(),
            "https://api.deepseek.com/user/balance"
        );
    }

    #[test]
    fn deepseek_balance_target_detect() {
        assert!(is_deepseek_balance_target(
            Some("deepseek"),
            "https://api.deepseek.com/v1"
        ));
        assert!(is_deepseek_balance_target(
            None,
            "https://api.deepseek.com/v1"
        ));
        assert!(is_deepseek_balance_target(Some("deepseek"), ""));
        assert!(!is_deepseek_balance_target(
            Some("amux"),
            "https://api.amux.ai/v1"
        ));
        assert!(!is_deepseek_balance_target(
            Some("opencode-go"),
            "https://opencode.ai/zen/go/v1"
        ));
        assert!(!is_deepseek_balance_target(
            Some("volcano-ark"),
            "https://ark.cn-beijing.volces.com/api/plan/v3"
        ));
    }

    #[test]
    fn parse_deepseek_balance_cny_fixture() {
        let body = r#"{
            "is_available": true,
            "balance_infos": [
                {
                    "currency": "CNY",
                    "total_balance": "110.00",
                    "granted_balance": "10.00",
                    "topped_up_balance": "100.00"
                }
            ]
        }"#;
        let (avail, lines) = parse_deepseek_balance_json(body).unwrap();
        assert!(avail);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].currency, "CNY");
        assert_eq!(lines[0].total_balance, "110.00");
        assert_eq!(lines[0].granted_balance, "10.00");
        assert_eq!(lines[0].topped_up_balance, "100.00");
    }

    #[test]
    fn parse_deepseek_balance_empty_infos() {
        let body = r#"{"is_available": false, "balance_infos": []}"#;
        let (avail, lines) = parse_deepseek_balance_json(body).unwrap();
        assert!(!avail);
        assert!(lines.is_empty());
    }

    #[test]
    fn normalizes_missing_v1() {
        assert_eq!(
            normalize_openai_base_url("https://api.yunyi.ai", "chat_completions", false),
            "https://api.yunyi.ai/v1"
        );
        assert_eq!(
            normalize_openai_base_url("https://api.yunyi.ai/v1", "chat_completions", false),
            "https://api.yunyi.ai/v1"
        );
        assert_eq!(
            normalize_openai_base_url("https://api.yunyi.ai/v1/", "chat_completions", false),
            "https://api.yunyi.ai/v1"
        );
    }

    #[test]
    fn full_path_skips_v1_append() {
        // Volcengine Ark Coding Plan roots must not gain trailing /v1.
        assert_eq!(
            normalize_openai_base_url(
                "https://ark.cn-beijing.volces.com/api/coding",
                "messages",
                true
            ),
            "https://ark.cn-beijing.volces.com/api/coding"
        );
        assert_eq!(
            normalize_openai_base_url(
                "https://ark.cn-beijing.volces.com/api/coding/v3/",
                "responses",
                true
            ),
            "https://ark.cn-beijing.volces.com/api/coding/v3"
        );
        // Legacy default still appends.
        assert_eq!(
            normalize_openai_base_url(
                "https://ark.cn-beijing.volces.com/api/coding",
                "messages",
                false
            ),
            "https://ark.cn-beijing.volces.com/api/coding/v1"
        );
    }

    #[test]
    fn parses_full_path_bool_fields() {
        assert!(!parse_app_bool_field(None));
        assert!(!parse_app_bool_field(Some("")));
        assert!(parse_app_bool_field(Some("true")));
        assert!(parse_app_bool_field(Some("1")));
        assert!(parse_app_bool_field(Some("YES")));
        assert!(!parse_app_bool_field(Some("false")));
        let mut m = std::collections::HashMap::new();
        m.insert(APP_BASE_URL_FULL_PATH_KEY.into(), "true".into());
        assert!(base_url_full_path_from_fields(&m));
    }

    #[test]
    fn provider_mode_is_explicit_and_defaults_generic() {
        assert_eq!(normalize_provider_mode(None), PROVIDER_MODE_GENERIC);
        assert_eq!(
            normalize_provider_mode(Some("grok_build_proxy")),
            PROVIDER_MODE_GROK_BUILD_PROXY
        );
        assert_eq!(
            normalize_provider_mode(Some("beefapi")),
            PROVIDER_MODE_GENERIC,
            "provider host or id must never opt into native semantics"
        );
    }

    #[test]
    fn native_proxy_requires_live_backend_search_capability() {
        let remote = vec![
            RemoteModel {
                id: "grok-4.6".into(),
                owned_by: None,
                supports_backend_search: Some(true),
                ..Default::default()
            },
            RemoteModel {
                id: "grok-4.5".into(),
                owned_by: None,
                supports_backend_search: None,
                ..Default::default()
            },
        ];
        let selected = vec![ProviderModelEntry::named("grok-4.6", "Grok 4.6")];
        assert!(validate_grok_build_proxy_models(&remote, &selected).is_ok());

        let unsupported = vec![ProviderModelEntry::named("grok-4.5", "Grok 4.5")];
        assert!(validate_grok_build_proxy_models(&remote, &unsupported)
            .unwrap_err()
            .contains("supports_backend_search=true"));
    }

    #[test]
    fn native_proxy_upsert_live_gate_skips_a_catalog_it_cannot_recheck() {
        let readable = ModelCatalogRead::Stored(vec![ProviderModelEntry::named("m1", "M1")]);
        let corrupt = read_model_catalog(Some("{not json"));
        let cleared = ModelCatalogRead::Stored(Vec::new());

        // `models: None` keeps the stored catalog: an unreadable or explicitly
        // cleared one has no row the channel `model` may stand in for.
        assert!(!grok_build_proxy_upsert_needs_live_models(
            None,
            Some(&corrupt)
        ));
        assert!(!grok_build_proxy_upsert_needs_live_models(
            None,
            Some(&cleared)
        ));
        // Create, legacy, and readable catalogs are still checked live.
        assert!(grok_build_proxy_upsert_needs_live_models(None, None));
        assert!(grok_build_proxy_upsert_needs_live_models(
            None,
            Some(&ModelCatalogRead::LegacyChannel)
        ));
        assert!(grok_build_proxy_upsert_needs_live_models(
            None,
            Some(&readable)
        ));

        // A non-empty edit claims capabilities and is checked live.
        let edited = vec![ProviderModelEntry::named("m2", "M2")];
        assert!(grok_build_proxy_upsert_needs_live_models(
            Some(&edited),
            Some(&corrupt)
        ));
        assert!(grok_build_proxy_upsert_needs_live_models(
            Some(&edited),
            None
        ));

        // `Some([])` is the explicit clear: an existing section fixes no rows,
        // so there is nothing to re-check. A create still has to select one.
        let no_rows: Vec<ProviderModelEntry> = Vec::new();
        assert!(!grok_build_proxy_upsert_needs_live_models(
            Some(&no_rows),
            Some(&cleared)
        ));
        assert!(!grok_build_proxy_upsert_needs_live_models(
            Some(&no_rows),
            Some(&corrupt)
        ));
        assert!(!grok_build_proxy_upsert_needs_live_models(
            Some(&no_rows),
            Some(&readable)
        ));
        assert!(grok_build_proxy_upsert_needs_live_models(
            Some(&no_rows),
            None
        ));
    }

    /// One pick for the native proxy spawn and `session/set_model`, across every
    /// `app_models` state.
    #[test]
    fn proxy_session_model_matches_the_native_spawn_pick() {
        let readable = ["m2", "m1"].map(|id| ProviderModelEntry::named(id, id));
        // A listed row passes through; empty, unknown, or channel-alias requests
        // take the active row.
        assert_eq!(
            resolve_grok_build_proxy_session_model_id("relay", "m1", &readable, "m2", false),
            "m1"
        );
        ["", "relay", "m9"].iter().for_each(|requested| {
            assert_eq!(
                resolve_grok_build_proxy_session_model_id(
                    "relay", requested, &readable, "m2", false
                ),
                "m2",
                "a readable catalog falls back to the active row for `{requested}`"
            );
        });
        assert_eq!(
            resolve_grok_build_proxy_session_model_id("relay", "m9", &readable, "gone", false),
            "m2",
            "a channel model outside the catalog falls back to the first row"
        );

        // A catalog that fixes no rows cannot vet the chat's stored id, so a
        // non-empty non-alias id is repeated; only empty / alias requests take
        // the active row.
        let recovered = [ProviderModelEntry::named("m2", "M2")];
        assert_eq!(
            resolve_grok_build_proxy_session_model_id("relay", "m3", &recovered, "m1", true),
            "m3"
        );
        ["", "relay"].iter().for_each(|requested| {
            assert_eq!(
                resolve_grok_build_proxy_session_model_id(
                    "relay", requested, &recovered, "m1", true
                ),
                "m2",
                "corrupt catalog: `{requested}` takes the recovered row"
            );
        });
        let cleared: [ProviderModelEntry; 0] = [];
        assert_eq!(
            resolve_grok_build_proxy_session_model_id("relay", "m2", &cleared, "m1", true),
            "m2"
        );
        ["", "relay"].iter().for_each(|requested| {
            assert_eq!(
                resolve_grok_build_proxy_session_model_id("relay", requested, &cleared, "m1", true),
                "m1",
                "cleared catalog: `{requested}` keeps the channel model"
            );
        });
        assert_eq!(
            resolve_grok_build_proxy_session_model_id("relay", "", &cleared, "", true),
            "relay",
            "a channel without a model falls back to the section id"
        );

        // Legacy channel singleton: the channel row is the whole catalog.
        let legacy = [ProviderModelEntry::named("m1", "m1")];
        ["", "m3"].iter().for_each(|requested| {
            assert_eq!(
                resolve_grok_build_proxy_session_model_id("relay", requested, &legacy, "m1", false),
                "m1"
            );
        });
    }

    #[test]
    fn native_proxy_spawn_uses_real_model_and_process_only_binding() {
        let models = encode_app_models(&[
            ProviderModelEntry::named("grok-4.6", "Grok 4.6"),
            ProviderModelEntry::named("grok-4.5", "Grok 4.5"),
        ])
        .expect("encode app models");
        let text = set_models_default(
            &append_section(
                "",
                "beef-relay",
                &[
                    ("model".into(), "grok-4.6".into()),
                    ("base_url".into(), "https://relay.example/v1".into()),
                    ("api_key".into(), "runtime-key".into()),
                    ("api_backend".into(), "responses".into()),
                    (
                        APP_PROVIDER_MODE_KEY.into(),
                        PROVIDER_MODE_GROK_BUILD_PROXY.into(),
                    ),
                    (APP_MODELS_KEY.into(), models),
                ],
            ),
            "beef-relay",
        );
        let spawn = grok_build_proxy_spawn_from_text(&text, "grok-4.5").expect("spawn");
        assert_eq!(spawn.model, "grok-4.5");
        assert_ne!(spawn.model, "beef-relay");
        assert_eq!(spawn.base_url, "https://relay.example/v1");
        assert_eq!(spawn.models_url, "https://relay.example/v1/models");
        assert_eq!(spawn.api_key, "runtime-key");

        let generic = text.replace(
            "app_provider_mode = \"grok_build_proxy\"",
            "app_provider_mode = \"generic\"",
        );
        assert!(grok_build_proxy_spawn_from_text(&generic, "grok-4.5").is_none());

        // A chat bound to this section still resolves when it is not the global default.
        let other_default = set_models_default(&text, "grok-4.7");
        let spawned =
            grok_build_proxy_spawn_for_provider_text(&other_default, "beef-relay", "grok-4.5")
                .expect("section spawn");
        assert_eq!(spawned.model, "grok-4.5");
        assert!(grok_build_proxy_spawn_for_provider_text(&text, "official", "grok-4.5").is_none());
        assert!(grok_build_proxy_spawn_from_text(&other_default, "grok-4.5").is_none());
    }

    fn grok_build_proxy_text(app_models: Option<&str>) -> String {
        let mut fields = vec![
            ("model".into(), "m1".into()),
            ("base_url".into(), "https://relay.example/v1".into()),
            ("api_key".into(), "dummy-relay-key".into()),
            ("api_backend".into(), "responses".into()),
            (
                APP_PROVIDER_MODE_KEY.into(),
                PROVIDER_MODE_GROK_BUILD_PROXY.into(),
            ),
        ];
        if let Some(raw) = app_models {
            fields.push((APP_MODELS_KEY.into(), raw.to_string()));
        }
        set_models_default(&append_section("", "beef-relay", &fields), "beef-relay")
    }

    #[test]
    fn native_proxy_spawn_keeps_a_stored_model_the_catalog_cannot_confirm() {
        // m2 still reads as a row, but the array is corrupt. A chat stored on m3
        // must keep m3 instead of retargeting to the first row.
        let corrupt = grok_build_proxy_text(Some(r#"[{"id":"m2","name":"M2"},"oops"]"#));
        assert_eq!(
            grok_build_proxy_spawn_from_text(&corrupt, "m3")
                .expect("spawn")
                .model,
            "m3"
        );
        assert_eq!(
            grok_build_proxy_spawn_from_text(&corrupt, "m2")
                .expect("spawn")
                .model,
            "m2"
        );
        assert_eq!(
            grok_build_proxy_spawn_from_text(&corrupt, "")
                .expect("spawn")
                .model,
            "m2",
            "no requested model keeps the readable-row fallback"
        );
        assert_eq!(
            grok_build_proxy_spawn_from_text(&corrupt, "beef-relay")
                .expect("spawn")
                .model,
            "m2",
            "the provider section alias is not a stored upstream model"
        );

        // Nothing readable in the value at all: the channel row is the fallback.
        let unreadable = grok_build_proxy_text(Some(r#"{"id":"m2"}"#));
        assert_eq!(
            grok_build_proxy_spawn_from_text(&unreadable, "m3")
                .expect("spawn")
                .model,
            "m3"
        );
        assert_eq!(
            grok_build_proxy_spawn_from_text(&unreadable, "")
                .expect("spawn")
                .model,
            "m1"
        );

        // An explicitly cleared catalog behaves the same way, and keeps the
        // same fallback when the chat stored no model.
        let cleared = grok_build_proxy_text(Some("[]"));
        assert_eq!(
            grok_build_proxy_spawn_from_text(&cleared, "m2")
                .expect("spawn")
                .model,
            "m2"
        );
        assert_eq!(
            grok_build_proxy_spawn_from_text(&cleared, "")
                .expect("spawn")
                .model,
            "m1"
        );
    }

    #[test]
    fn native_proxy_spawn_validates_a_readable_catalog_and_legacy_channel() {
        let models = encode_app_models(&[
            ProviderModelEntry::named("m1", "M1"),
            ProviderModelEntry::named("m2", "M2"),
        ])
        .expect("encode app models");
        let readable = grok_build_proxy_text(Some(&models));
        assert_eq!(
            grok_build_proxy_spawn_from_text(&readable, "m2")
                .expect("spawn")
                .model,
            "m2"
        );
        assert_eq!(
            grok_build_proxy_spawn_from_text(&readable, "m3")
                .expect("spawn")
                .model,
            "m1",
            "an id outside a readable catalog keeps the active-row fallback"
        );

        // A legacy provider has no stored catalog; its channel row is the catalog.
        let legacy = grok_build_proxy_text(None);
        assert_eq!(
            grok_build_proxy_spawn_from_text(&legacy, "m3")
                .expect("spawn")
                .model,
            "m1"
        );
    }

    #[test]
    fn generic_section_resolution() {
        // Generic relay with no per-model section yet: the API model id is not
        // a CLI section. Sending it falls through to the built-in catalog (#1294).
        assert_eq!(
            resolve_session_set_model_id(Some("api-top"), "grok-4.6", &[]),
            "api-top"
        );
        assert_eq!(
            resolve_session_set_model_id(Some("relay"), "deepseek-v4-pro", &[]),
            "relay"
        );
        assert_eq!(
            resolve_session_set_model_id(None, "grok-4.7", &[]),
            "grok-4.7"
        );
        // #1337 / #1394: a generic chat names the section whose `model` field
        // is the picked catalog id. Two chats do not share one section.
        // Without those sections, the provider id remains the safe send.
        let kiro_sections = [
            GenericSectionBinding {
                section_id: "kiro__auto".into(),
                model_id: "auto".into(),
            },
            GenericSectionBinding {
                section_id: "kiro__gpt-5-6-luna".into(),
                model_id: "gpt-5.6-luna".into(),
            },
            GenericSectionBinding {
                section_id: "kiro__gpt-5-6-sol".into(),
                model_id: "gpt-5.6-sol".into(),
            },
        ];
        assert_eq!(
            resolve_session_set_model_id(Some("kiro"), "gpt-5.6-luna", &kiro_sections),
            "kiro__gpt-5-6-luna"
        );
        assert_eq!(
            resolve_session_set_model_id(Some("kiro"), "kiro__gpt-5-6-luna", &kiro_sections),
            "kiro__gpt-5-6-luna"
        );
        assert_eq!(
            resolve_session_set_model_id(Some("kiro"), "gpt-5.6-luna", &[]),
            "kiro"
        );
        let other_sections = [GenericSectionBinding {
            section_id: "other__gpt-5-6-sol".into(),
            model_id: "gpt-5.6-sol".into(),
        }];
        assert_eq!(
            resolve_session_set_model_id(Some("other"), "gpt-5.6-sol", &other_sections),
            "other__gpt-5-6-sol"
        );
    }

    #[test]
    fn roundtrip_section_text() {
        let text = "";
        let text = append_section(
            text,
            "demo",
            &[
                ("model".into(), "m1".into()),
                ("base_url".into(), "https://ex/v1".into()),
                ("name".into(), "Demo".into()),
                ("api_key".into(), "sk-test".into()),
                ("api_backend".into(), "chat_completions".into()),
            ],
        );
        let text = set_models_default(&text, "demo");
        let sections = parse_model_sections(&text);
        assert_eq!(sections.len(), 1);
        assert_eq!(get_models_default(&text).as_deref(), Some("demo"));
        assert!(is_custom(&sections[0].fields));
    }

    #[test]
    fn app_models_roundtrip_and_normalize() {
        let list = normalize_provider_models(&[
            ProviderModelEntry::named(" deepseek-v4-flash ", "DeepSeek V4"),
            ProviderModelEntry::named("deepseek-v4-flash", "dup"),
            ProviderModelEntry::named("", "skip"),
            ProviderModelEntry::named("other", "  "),
        ]);
        assert_eq!(
            list,
            vec![
                ProviderModelEntry::named("deepseek-v4-flash", "DeepSeek V4"),
                ProviderModelEntry::named("other", "other"),
            ]
        );
        let json = encode_app_models(&list).expect("encode app models");
        let decoded = decode_app_models(Some(&json), "fallback", "Fallback");
        assert_eq!(decoded, list);
        assert_eq!(resolve_active_model(&list, "other"), "other");
        assert_eq!(resolve_active_model(&list, "missing"), "deepseek-v4-flash");
    }

    #[test]
    fn app_models_preserves_per_model_caps_and_efforts() {
        let list = normalize_provider_models(&[ProviderModelEntry {
            id: "vision".into(),
            name: "Vision".into(),
            context_window: Some(128_000),
            supports_vision: Some(true),
            supports_video: Some(true),
            efforts: vec![ProviderEffortEntry {
                id: "high".into(),
                name: "high".into(),
                is_default: true,
            }],
            ..Default::default()
        }]);
        assert_eq!(list[0].context_window, Some(128_000));
        assert_eq!(list[0].supports_vision, Some(true));
        assert_eq!(list[0].supports_video, Some(true));
        assert_eq!(list[0].efforts[0].id, "high");
        assert_eq!(list[0].context_window_source.as_deref(), Some("user"));
        assert_eq!(list[0].efforts_source.as_deref(), Some("user"));
        let json = encode_app_models(&list).expect("encode app models");
        let decoded = decode_app_models(Some(&json), "fallback", "Fallback");
        assert_eq!(decoded, list);
        let legacy = decode_app_models(
            Some(r#"[{"id":"plain","name":"Plain"}]"#),
            "fallback",
            "Fallback",
        );
        assert_eq!(legacy[0].id, "plain");
        assert_eq!(legacy[0].context_window, None);
        assert!(legacy[0].efforts.is_empty());
        assert_eq!(legacy[0].context_window_source, None);
        assert_eq!(legacy[0].efforts_source, None);
    }

    #[test]
    fn model_source_markers_are_validated_and_kept_with_their_values() {
        let list = normalize_provider_models(&[
            ProviderModelEntry {
                id: "remote".into(),
                name: "Remote".into(),
                context_window: Some(1_000_000),
                context_window_source: Some(" REMOTE ".into()),
                efforts: vec![ProviderEffortEntry {
                    id: "low".into(),
                    name: "low".into(),
                    is_default: true,
                }],
                efforts_source: Some("fallback".into()),
                supports_reasoning_effort: Some(false),
                supports_reasoning_effort_source: Some("remote".into()),
                ..Default::default()
            },
            ProviderModelEntry {
                id: "unknown".into(),
                name: "Unknown".into(),
                context_window: Some(8_000),
                context_window_source: Some("vendor-specific".into()),
                supports_reasoning_effort: Some(true),
                supports_reasoning_effort_source: Some("vendor-specific".into()),
                ..Default::default()
            },
        ]);
        assert_eq!(list[0].context_window_source.as_deref(), Some("remote"));
        assert_eq!(list[0].efforts_source.as_deref(), Some("fallback"));
        assert_eq!(list[0].supports_reasoning_effort, Some(false));
        assert_eq!(
            list[0].supports_reasoning_effort_source.as_deref(),
            Some("remote")
        );
        assert_eq!(
            list[1].context_window_source.as_deref(),
            Some("user"),
            "an unknown marker must fall back to user so refresh cannot overwrite it"
        );
        assert_eq!(
            list[1].supports_reasoning_effort_source.as_deref(),
            Some("user")
        );
        let orphan = normalize_provider_models(&[ProviderModelEntry {
            id: "empty".into(),
            name: "Empty".into(),
            context_window_source: Some("remote".into()),
            efforts_source: Some("remote".into()),
            ..Default::default()
        }]);
        assert_eq!(orphan[0].context_window_source, None);
        assert_eq!(orphan[0].efforts_source, None);
    }

    #[test]
    fn legacy_model_values_without_sources_are_read_as_user_and_round_trip() {
        let raw = r#"[{
            "id": "legacy",
            "name": "Legacy",
            "contextWindow": 128000,
            "efforts": [{"id": "maximum", "name": "Maximum", "isDefault": true}],
            "supportsReasoningEffort": false
        }]"#;
        let decoded = decode_app_models(Some(raw), "fallback", "Fallback");
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].context_window, Some(128_000));
        assert_eq!(decoded[0].context_window_source.as_deref(), Some("user"));
        assert_eq!(decoded[0].efforts_source.as_deref(), Some("user"));
        assert_eq!(
            decoded[0].supports_reasoning_effort_source.as_deref(),
            Some("user")
        );

        let encoded = encode_app_models(&decoded).expect("encode app models");
        let reloaded = decode_app_models(Some(&encoded), "fallback", "Fallback");
        assert_eq!(reloaded, decoded);
    }

    #[test]
    fn explicit_empty_app_models_is_not_resurrected_from_channel_model() {
        // `app_models = "[]"` is a deliberate clear, not a legacy single-model
        // provider. Re-synthesizing the channel `model` would undo the clear.
        let decoded = decode_app_models(Some("[]"), "channel-model", "Channel");
        assert!(
            decoded.is_empty(),
            "explicit empty catalog must stay empty: {decoded:?}"
        );
    }

    #[test]
    fn missing_or_corrupt_app_models_falls_back_to_the_channel_model_for_reads() {
        for raw in [
            None,
            Some(""),
            Some("   "),
            Some("null"),
            Some("{}"),
            Some("not-json"),
            Some(r#"[{"id":""}]"#),
        ] {
            let decoded = decode_app_models(raw, "channel-model", "Channel");
            assert_eq!(
                decoded,
                vec![ProviderModelEntry::named("channel-model", "Channel")],
                "channel fallback for {raw:?}"
            );
        }
    }

    #[test]
    fn partially_invalid_app_models_lists_recoverable_rows_and_stays_corrupt() {
        let text = r#"
[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://relay.example/v1"
name = "Relay"
api_key = "sk-test"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = "[{\"id\":\"m1\",\"name\":\"M1\"},{\"id\":\"m2\",\"name\":\"M2\",\"contextWindow\":\"big\"},null]"
"#;
        let listed = build_list_result(std::path::PathBuf::new(), std::path::PathBuf::new(), text);
        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert!(
            relay.model_catalog_corrupt,
            "one invalid row still makes the stored catalog unrecoverable"
        );
        assert_eq!(
            relay
                .models
                .iter()
                .map(|m| (m.id.as_str(), m.name.as_str()))
                .collect::<Vec<_>>(),
            [("m1", "M1"), ("m2", "M2")],
            "readable row identities stay selectable instead of collapsing to the channel model"
        );
        let wire = serde_json::to_string(&listed).expect("list result is serializable");
        assert!(
            !wire.contains(r#""big""#) && !wire.contains("invalid type"),
            "the IPC payload must not carry the stored value or parse detail: {wire}"
        );
    }

    #[test]
    fn app_models_accepts_legacy_rows_and_keeps_request_id_identity() {
        let raw = r#"[
            {"id":" m1 "},
            {"id":"m1","name":"Duplicate"},
            {"id":"m2","name":"M2","contextWindow":null,"supportsVision":null,"supportsVideo":null},
            {"id":"m3","name":"M3","contextWindow":0,"efforts":[]}
        ]"#;
        let decoded = decode_app_models(Some(raw), "fallback", "Fallback");
        assert_eq!(
            decoded.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m1", "m2", "m3"],
            "identity is the trimmed request id, first row wins"
        );
        assert_eq!(decoded[0].name, "m1", "missing name falls back to id");
        assert_eq!(decoded[1].context_window, None);
        assert_eq!(decoded[1].supports_vision, None);
        assert_eq!(decoded[1].supports_video, None);
        assert_eq!(decoded[2].context_window, None, "0 is an empty value");
        assert!(decoded[2].efforts.is_empty());

        let json = encode_app_models(&decoded).expect("encode app models");
        assert_eq!(
            decode_app_models(Some(&json), "fallback", "Fallback"),
            decoded,
            "serialize → read must be stable"
        );
    }

    #[test]
    fn legacy_catalog_display_name_is_the_model_id_in_list_and_child_sections() {
        let before = "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
api_key = \"sk-test\"
name = \"Relay display\"
api_backend = \"chat_completions\"
app_provider_mode = \"generic\"
";
        let synced = sync_generic_model_sections_in_text(before);
        assert_eq!(
            field_of(&synced, "relay__m1", "name").as_deref(),
            Some("m1"),
            "legacy row display falls back to the request id, not the channel name"
        );
        let listed = build_list_result(
            std::path::PathBuf::new(),
            std::path::PathBuf::new(),
            &synced,
        );
        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert_eq!(
            relay.models,
            vec![ProviderModelEntry::named("m1", "m1")],
            "providers_list and child sections must agree on the fallback name"
        );
        assert_eq!(
            Some(relay.models[0].name.clone()),
            field_of(&synced, "relay__m1", "name")
        );
    }

    #[test]
    fn cli_effort_wire_mapping_keeps_instant_and_off_distinct() {
        assert_eq!(canonical_wire_effort("instant"), "minimal");
        assert_eq!(canonical_wire_effort("none"), "none");
        assert_eq!(canonical_wire_effort("off"), "none");
        assert_eq!(canonical_wire_effort("ultra"), "max");
        assert_eq!(canonical_wire_effort("xhigh"), "xhigh");
        assert_eq!(canonical_wire_effort("vendor-tier"), "medium");
    }

    #[test]
    fn generic_child_declares_raw_cli_effort_menu_including_off() {
        let rows = vec![ProviderModelEntry {
            id: "gpt-6-luna-2026-09-22".into(),
            name: "GPT 6 Luna".into(),
            efforts: vec![
                ProviderEffortEntry {
                    id: "low".into(),
                    name: "low".into(),
                    is_default: false,
                },
                ProviderEffortEntry {
                    id: "instant".into(),
                    name: "Instant".into(),
                    is_default: false,
                },
            ],
            supports_reasoning_off: Some(true),
            ..Default::default()
        }];
        let before = format!(
            "\
[models]
default = \"relay\"

[model.relay]
model = \"gpt-6-luna-2026-09-22\"
base_url = \"https://relay.example/v1\"
api_key = \"sk-test\"
name = \"Relay\"
api_backend = \"responses\"
app_provider_mode = \"generic\"
app_models = {}
supports_reasoning_effort = true
",
            quote(&encode_app_models(&rows).expect("encode app models"))
        );
        let synced = sync_generic_model_sections_in_text(&before);
        let menu = field_of(&synced, "relay__gpt-6-luna-2026-09-22", "reasoning_efforts")
            .expect("child must advertise the CLI effort menu");
        assert!(
            menu.contains("{ id = \"instant\", value = \"minimal\", label = \"Instant\""),
            "{menu}"
        );
        assert!(
            menu.contains("{ id = \"none\", value = \"none\", label = \"none\""),
            "{menu}"
        );
        assert_eq!(
            sync_generic_model_sections_in_text(&synced),
            synced,
            "a second sync must not rewrite the menu"
        );
    }

    #[test]
    fn explicit_empty_catalog_keeps_legacy_child_sections_but_lists_no_models() {
        let before = "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
api_key = \"sk-test\"
name = \"Relay\"
api_backend = \"chat_completions\"
app_provider_mode = \"generic\"
app_models = \"[]\"

[model.relay__m1]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"m1\"
api_key = \"sk-test\"
api_backend = \"chat_completions\"
app_provider_mode = \"generic\"
app_parent_provider = \"relay\"
";
        let synced = sync_generic_model_sections_in_text(before);
        assert_eq!(
            synced, before,
            "old chats still reference these child section ids"
        );
        let listed = build_list_result(
            std::path::PathBuf::new(),
            std::path::PathBuf::new(),
            &synced,
        );
        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert!(
            relay.models.is_empty(),
            "app_models = [] stays an explicit clear: {:?}",
            relay.models
        );
    }

    #[test]
    fn unusable_app_models_is_reported_as_an_opaque_state_without_the_raw_value() {
        let text = r#"
[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://relay.example/v1"
name = "Relay"
api_key = "sk-test"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = "not-json"
"#;
        let listed = build_list_result(std::path::PathBuf::new(), std::path::PathBuf::new(), text);
        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert!(
            relay.model_catalog_corrupt,
            "Settings needs the unusable state"
        );
        assert_eq!(
            relay.models,
            vec![ProviderModelEntry::named("m1", "m1")],
            "the channel row still stays selectable"
        );
        let wire = serde_json::to_string(&listed).expect("list result is serializable");
        assert!(
            !wire.contains("not-json") && !wire.contains("invalid JSON"),
            "the IPC payload must not carry the stored value or parse detail: {wire}"
        );

        let healthy = build_list_result(
            std::path::PathBuf::new(),
            std::path::PathBuf::new(),
            r#"
[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://relay.example/v1"
name = "Relay"
api_key = "sk-test"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = "[{\"id\":\"m1\",\"name\":\"M1\"}]"
"#,
        );
        assert!(
            !healthy.providers[0].model_catalog_corrupt,
            "a stored catalog is safe to rewrite"
        );
        let legacy = build_list_result(
            std::path::PathBuf::new(),
            std::path::PathBuf::new(),
            r#"
[model.legacy]
model = "m1"
base_url = "https://relay.example/v1"
name = "Legacy"
api_key = "sk-test"
"#,
        );
        assert!(
            !legacy.providers[0].model_catalog_corrupt,
            "a missing app_models field is a legacy provider, not a corrupt one"
        );
    }

    #[test]
    fn unusable_app_models_payload_and_debug_never_carry_the_stored_text() {
        const MARKER: &str = "sk-CANARY-LEAK-7f3a";
        let text = format!(
            r#"
[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://relay.example/v1"
name = "Relay"
api_key = "sk-test"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = "not-json {MARKER}"
"#
        );
        let listed = build_list_result(std::path::PathBuf::new(), std::path::PathBuf::new(), &text);
        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert!(relay.model_catalog_corrupt);
        let wire = serde_json::to_string(&listed).expect("list result is serializable");
        assert!(
            !wire.contains(MARKER),
            "IPC payload leaked the stored value: {wire}"
        );
        let debug = format!(
            "{:?}",
            crate::provider_model_profile::read_model_catalog(Some(&format!("not-json {MARKER}")))
        );
        assert!(
            !debug.contains(MARKER),
            "debug output leaked the stored value: {debug}"
        );
    }

    #[test]
    fn parse_remote_models_reads_openrouter_caps() {
        let body = r#"{
            "data": [
                {
                    "id": "stealth/ox-alpha",
                    "owned_by": "openrouter",
                    "context_length": 1048576,
                    "architecture": {
                        "modality": "text+image->text",
                        "input_modalities": ["text", "image"]
                    }
                },
                {
                    "id": "video-model",
                    "context_window": 32000,
                    "architecture": { "input_modalities": ["text", "video"] }
                }
            ]
        }"#;
        let got = parse_remote_models_response("https://ex/v1/models".into(), body).unwrap();
        let ox = got
            .models
            .iter()
            .find(|m| m.id == "stealth/ox-alpha")
            .unwrap();
        assert_eq!(ox.context_window, Some(1_048_576));
        assert_eq!(ox.supports_vision, Some(true));
        let vid = got.models.iter().find(|m| m.id == "video-model").unwrap();
        assert_eq!(vid.context_window, Some(32_000));
        assert_eq!(vid.supports_video, Some(true));
    }

    #[test]
    fn parse_remote_models_reads_extended_reasoning_metadata() {
        let body = r#"{
            "data": [
                {
                    "id": "xhigh-model",
                    "context_window": 2000000,
                    "reasoning_efforts": [
                        {"id": "low", "name": "Low"},
                        {"value": "medium", "label": "Medium", "default": true},
                        {"id": "xhigh"}
                    ],
                    "supports_reasoning_effort": true
                },
                {
                    "id": "no-thinking",
                    "supportsReasoningEffort": false
                },
                {
                    "id": "ladder-only",
                    "reasoningEfforts": ["minimum", {"effort": "maximum", "isDefault": true}]
                },
                {
                    "id": "false-with-ladder",
                    "reasoning_efforts": [{"id":"balanced"}],
                    "supports_reasoning_effort": false
                }
            ]
        }"#;
        let got = parse_remote_models_response("https://ex/v1/models".into(), body).unwrap();
        let rich = got.models.iter().find(|m| m.id == "xhigh-model").unwrap();
        assert_eq!(
            rich.reasoning_efforts
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "medium", "xhigh"]
        );
        assert_eq!(rich.reasoning_efforts[1].name, "Medium");
        assert!(rich.reasoning_efforts[1].is_default);
        assert_eq!(rich.supports_reasoning_effort, Some(true));

        let off = got.models.iter().find(|m| m.id == "no-thinking").unwrap();
        assert!(off.reasoning_efforts.is_empty());
        assert_eq!(off.supports_reasoning_effort, Some(false));

        let ladder = got.models.iter().find(|m| m.id == "ladder-only").unwrap();
        assert_eq!(
            ladder
                .reasoning_efforts
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["minimum", "maximum"]
        );
        assert!(ladder.reasoning_efforts[1].is_default);
        assert_eq!(
            ladder.supports_reasoning_effort,
            Some(true),
            "a structured ladder implies reasoning support"
        );
        let false_with_ladder = got
            .models
            .iter()
            .find(|model| model.id == "false-with-ladder")
            .unwrap();
        assert_eq!(
            false_with_ladder.supports_reasoning_effort,
            Some(true),
            "an advertised ladder takes precedence over a conflicting false flag"
        );
    }

    #[test]
    fn parse_remote_models_bounds_and_ignores_malformed_reasoning_metadata() {
        let mut efforts = Vec::new();
        for index in 0..40 {
            efforts.push(serde_json::json!({
                "id": format!("level-{index}"),
                "name": "x".repeat(200),
            }));
        }
        let body = serde_json::json!({
            "data": [
                {
                    "id": "bounded",
                    "reasoning_efforts": efforts,
                    "supports_reasoning_effort": "yes"
                },
                {
                    "id": "wrong-shape",
                    "reasoning_efforts": {"id": "high"},
                    "supports_reasoning_effort": 1
                },
                {
                    "id": "junk-rows",
                    "reasoning_efforts": [null, 7, {}, {"id": "  "}, {"id": "low"}]
                }
            ]
        })
        .to_string();
        let got = parse_remote_models_response("https://ex/v1/models".into(), &body).unwrap();
        let bounded = got.models.iter().find(|m| m.id == "bounded").unwrap();
        assert_eq!(bounded.reasoning_efforts.len(), 32);
        assert_eq!(bounded.reasoning_efforts[0].name.chars().count(), 80);
        assert_eq!(
            bounded.supports_reasoning_effort,
            Some(true),
            "a wrong-typed flag is ignored, but the ladder still supports reasoning"
        );
        let shape = got.models.iter().find(|m| m.id == "wrong-shape").unwrap();
        assert!(shape.reasoning_efforts.is_empty());
        assert_eq!(shape.supports_reasoning_effort, None);
        let junk = got.models.iter().find(|m| m.id == "junk-rows").unwrap();
        assert_eq!(
            junk.reasoning_efforts
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low"]
        );
        assert_eq!(junk.supports_reasoning_effort, Some(true));
    }

    #[test]
    fn parse_remote_models_handles_failure_empty_and_partial_rows() {
        let error = parse_remote_models_response("https://ex/v1/models".into(), "this is not json")
            .unwrap_err();
        assert_eq!(error, "models response is not JSON");

        let empty =
            parse_remote_models_response("https://ex/v1/models".into(), r#"{"data":[]}"#).unwrap();
        assert!(empty.models.is_empty());

        let body = r#"{
            "data": [
                {"id": "plain"},
                {
                    "id": "nulled",
                    "context_window": null,
                    "reasoningEfforts": null,
                    "supportsReasoningEffort": null
                },
                {
                    "id": "wrong-typed",
                    "context_window": "128k",
                    "reasoningEfforts": "low",
                    "supportsReasoningEffort": "yes"
                }
            ]
        }"#;
        let got = parse_remote_models_response("https://ex/v1/models".into(), body).unwrap();
        assert_eq!(got.models.len(), 3);
        for model in &got.models {
            assert_eq!(model.context_window, None, "{}", model.id);
            assert!(model.reasoning_efforts.is_empty(), "{}", model.id);
            assert_eq!(model.supports_reasoning_effort, None, "{}", model.id);
        }
    }

    #[test]
    fn parse_remote_models_keeps_the_first_row_for_a_duplicated_id() {
        let body = r#"{
            "data": [
                {"id": "same", "context_window": 64000},
                {"id": "same", "context_window": 128000, "supports_reasoning_effort": false},
                {"id": "other", "context_window": 32000}
            ]
        }"#;
        let got = parse_remote_models_response("https://ex/v1/models".into(), body).unwrap();
        assert_eq!(
            got.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["other", "same"]
        );
        let same = got.models.iter().find(|m| m.id == "same").unwrap();
        assert_eq!(same.context_window, Some(64_000));
        assert_eq!(same.supports_reasoning_effort, None);
    }

    #[test]
    fn quote_unquote_roundtrip_json_payload() {
        let models = vec![
            ProviderModelEntry::named("deepseek-v4-flash", "DeepSeek V4 Flash"),
            ProviderModelEntry::named("deepseek-v4-pro", "DeepSeek V4 Pro"),
        ];
        let efforts = vec![
            ProviderEffortEntry {
                id: "low".into(),
                name: "low".into(),
                is_default: false,
            },
            ProviderEffortEntry {
                id: "high".into(),
                name: "high".into(),
                is_default: true,
            },
            ProviderEffortEntry {
                id: "xhigh".into(),
                name: "xhigh".into(),
                is_default: false,
            },
            ProviderEffortEntry {
                id: "max".into(),
                name: "max".into(),
                is_default: false,
            },
        ];
        let models_json = encode_app_models(&models).expect("encode app models");
        let efforts_json = encode_app_efforts(&efforts);
        // Simulate TOML field write + read (quote → line value → unquote).
        let models_field = format!("app_models = {}", quote(&models_json));
        let efforts_field = format!("app_efforts = {}", quote(&efforts_json));
        let models_raw = models_field.split_once('=').unwrap().1.trim();
        let efforts_raw = efforts_field.split_once('=').unwrap().1.trim();
        let models_back = unquote(models_raw);
        let efforts_back = unquote(efforts_raw);
        assert_eq!(
            decode_app_models(Some(&models_back), "fallback", "fallback"),
            models
        );
        assert_eq!(decode_app_efforts(Some(&efforts_back)), efforts);

        // Full section round-trip through append + parse
        let text = append_section(
            "",
            "deepseek",
            &[
                ("model".into(), "deepseek-v4-flash".into()),
                ("base_url".into(), "https://api.deepseek.com/v1".into()),
                ("name".into(), "DeepSeek".into()),
                ("api_key".into(), "sk-test".into()),
                ("api_backend".into(), "chat_completions".into()),
                (APP_MODELS_KEY.into(), models_json),
                (APP_EFFORTS_KEY.into(), efforts_json),
            ],
        );
        let sections = parse_model_sections(&text);
        assert_eq!(sections.len(), 1);
        let s = &sections[0];
        let got_models =
            decode_app_models(s.fields.get(APP_MODELS_KEY).map(|x| x.as_str()), "x", "x");
        let got_efforts = decode_app_efforts(s.fields.get(APP_EFFORTS_KEY).map(|x| x.as_str()));
        assert_eq!(got_models, models);
        assert_eq!(got_efforts, efforts);
        assert_eq!(got_models[0].name, "DeepSeek V4 Flash");
        assert_eq!(
            got_efforts
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "high", "xhigh", "max"]
        );
    }

    #[test]
    fn append_prompt_round_trips_multiline_through_toml() {
        // Channel rules are free-form and often multi-line; the JSON-quoted
        // TOML value must survive a write → parse cycle unchanged.
        let prompt = "Always answer in Simplified Chinese.\nNever use emoji.";
        let text = append_section(
            "",
            "relay",
            &[
                ("model".into(), "m".into()),
                ("base_url".into(), "https://ex/v1".into()),
                (APP_APPEND_PROMPT_KEY.into(), prompt.into()),
            ],
        );
        // A raw newline would break the `key = value` line parser.
        assert!(!text.contains("Chinese.\nNever"), "must be escaped: {text}");
        let sections = parse_model_sections(&text);
        assert_eq!(sections.len(), 1);
        assert_eq!(
            sections[0]
                .fields
                .get(APP_APPEND_PROMPT_KEY)
                .map(|s| s.as_str()),
            Some(prompt)
        );
    }

    #[test]
    fn append_prompt_blank_is_dropped_not_stored() {
        // Empty box = no channel rules; the field must not reach config.toml.
        let text = append_section(
            "",
            "relay",
            &[
                ("model".into(), "m".into()),
                ("base_url".into(), "https://ex/v1".into()),
                (APP_APPEND_PROMPT_KEY.into(), String::new()),
            ],
        );
        assert!(!text.contains(APP_APPEND_PROMPT_KEY), "{text}");
    }

    #[test]
    fn append_prompt_explicit_clear_drops_key_and_update_replaces_it() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home =
            std::env::temp_dir().join(format!("grok-app-append-prompt-{}", uuid::Uuid::new_v4()));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<(), String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let before = "\
# keep-me
[models]
default = \"grok\"

[memory] # memory switch
enabled = false

[ui]
yolo = false

[model.demo] # my relay
model = \"demo-model\"
base_url = \"https://relay.example/v1\"
api_key = \"sk-channel-secret\"
api_backend = \"chat_completions\"
name = \"Demo\"
app_append_prompt = \"1. 结构化输出确保可读性\"
";
            write_text(&path, before)?;

            let updated = upsert_custom_provider(UpsertProviderInput {
                id: "demo".into(),
                model: "demo-model".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Demo".into()),
                api_key: Some("sk-channel-secret".into()),
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models: Some(vec![ProviderModelEntry::named("demo-model", "Demo")]),
                efforts: None,
                context_window: Some(128_000),
                base_url_full_path: Some(true),
                append_prompt: Some("2. 先给结论\n第二行".into()),
                supports_vision: Some(false),
                extra_headers: None,
            })?;
            let saved = updated
                .providers
                .iter()
                .find(|p| p.id == "demo")
                .ok_or_else(|| "demo provider missing after update".to_string())?;
            assert_eq!(saved.append_prompt.as_deref(), Some("2. 先给结论\n第二行"));
            let after_update = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            assert!(
                !after_update.contains("结构化输出确保可读性"),
                "old prompt must be replaced:\n{after_update}"
            );
            assert_eq!(
                after_update.matches("[model.demo]").count(),
                1,
                "commented header must be replaced, not duplicated:\n{after_update}"
            );
            assert!(after_update.starts_with("# keep-me\n"), "{after_update}");
            assert!(
                after_update.contains("[memory] # memory switch"),
                "{after_update}"
            );
            assert!(after_update.contains("yolo = false"), "{after_update}");
            assert!(
                after_update.contains("api_key = \"sk-channel-secret\""),
                "{after_update}"
            );
            let i_keep = after_update.find("# keep-me").unwrap();
            let i_models = after_update.find("[models]").unwrap();
            let i_mem = after_update.find("[memory]").unwrap();
            let i_ui = after_update.find("[ui]").unwrap();
            assert!(
                i_keep < i_models && i_models < i_mem && i_mem < i_ui,
                "{after_update}"
            );

            let kept = upsert_custom_provider(UpsertProviderInput {
                id: "demo".into(),
                model: "demo-model".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Demo".into()),
                api_key: None,
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models: None,
                efforts: None,
                context_window: None,
                base_url_full_path: None,
                append_prompt: None,
                supports_vision: None,
                extra_headers: None,
            })?;
            let kept_prompt = kept
                .providers
                .iter()
                .find(|p| p.id == "demo")
                .and_then(|p| p.append_prompt.clone());
            assert_eq!(kept_prompt.as_deref(), Some("2. 先给结论\n第二行"));

            let cleared = upsert_custom_provider(UpsertProviderInput {
                id: "demo".into(),
                model: "demo-model".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Demo".into()),
                api_key: None,
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models: None,
                efforts: None,
                context_window: None,
                base_url_full_path: Some(true),
                append_prompt: Some(String::new()),
                supports_vision: None,
                extra_headers: Some(vec![]),
            })?;
            assert!(
                cleared
                    .providers
                    .iter()
                    .find(|p| p.id == "demo")
                    .and_then(|p| p.append_prompt.clone())
                    .is_none(),
                "empty append prompt must clear"
            );
            let after_clear = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            assert!(
                !after_clear.contains("app_append_prompt"),
                "cleared key must be gone:\n{after_clear}"
            );
            assert!(
                !after_clear.contains("先给结论"),
                "cleared text must be gone:\n{after_clear}"
            );
            assert!(
                after_clear.contains("api_key = \"sk-channel-secret\""),
                "{after_clear}"
            );
            assert!(after_clear.contains("# keep-me"), "{after_clear}");
            assert!(
                after_clear.contains("[memory] # memory switch"),
                "{after_clear}"
            );
            assert!(after_clear.contains("yolo = false"), "{after_clear}");
            assert!(
                after_clear.contains("context_window = 128000"),
                "{after_clear}"
            );

            fn mask(raw: &str) -> String {
                raw.replace("sk-channel-secret", "sk-****")
            }
            eprintln!("--- append prompt BEFORE ---\n{}", mask(before));
            eprintln!(
                "--- append prompt AFTER UPDATE ---\n{}",
                mask(&after_update)
            );
            eprintln!("--- append prompt AFTER CLEAR ---\n{}", mask(&after_clear));
            Ok(())
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
        outcome.expect("append prompt clear/update");
    }

    #[test]
    fn remove_section_handles_trailing_newline() {
        // File ends with `\n` — previously split('\n') vs lines() disagreed on len.
        let text = "\
[models]
default = \"deepseek\"

[model.deepseek]
model = \"deepseek-v4-flash\"
base_url = \"https://api.deepseek.com/v1\"
name = \"DeepSeek\"
api_key = \"sk-test\"
api_backend = \"chat_completions\"
app_models = \"[{\\\"id\\\":\\\"deepseek-v4-flash\\\",\\\"name\\\":\\\"Flash\\\"}]\"
";
        assert!(text.ends_with('\n'));
        let sections = parse_model_sections(text);
        let deep = sections
            .iter()
            .find(|s| s.id == "deepseek")
            .expect("section");
        // end must not exceed lines() length
        let n = text.lines().count();
        assert!(deep.end <= n, "end {} > lines {}", deep.end, n);

        let next = remove_section(text, "deepseek");
        assert!(
            !parse_model_sections(&next)
                .iter()
                .any(|s| s.id == "deepseek"),
            "section should be gone: {next}"
        );
        // Other content preserved
        assert!(next.contains("[models]"));
        assert!(next.contains("default"));
    }

    #[test]
    fn remove_section_last_section_without_trailing_newline() {
        let text = "\
[model.a]
model = \"m\"
base_url = \"https://ex/v1\"
name = \"A\"
api_key = \"k\"
api_backend = \"responses\"";
        let next = remove_section(text, "a");
        assert!(parse_model_sections(&next).is_empty());
    }

    #[test]
    fn app_efforts_normalize_and_roundtrip() {
        let list = normalize_provider_efforts(&[
            ProviderEffortEntry {
                id: " low ".into(),
                name: "Low".into(),
                is_default: false,
            },
            ProviderEffortEntry {
                id: "high".into(),
                name: "".into(),
                is_default: true,
            },
            ProviderEffortEntry {
                id: "high".into(),
                name: "dup".into(),
                is_default: true,
            },
            ProviderEffortEntry {
                id: "xhigh".into(),
                name: "xHigh".into(),
                is_default: false,
            },
            ProviderEffortEntry {
                id: "max".into(),
                name: "Max".into(),
                is_default: false,
            },
            ProviderEffortEntry {
                id: "two words".into(),
                name: "Unsafe".into(),
                is_default: false,
            },
        ]);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].id, "low");
        assert_eq!(list[1].id, "high");
        assert!(list[1].is_default);
        assert_eq!(list[1].name, "high");
        assert_eq!(list[2].id, "xhigh");
        assert_eq!(list[3].id, "max");
        let json = encode_app_efforts(&list);
        let decoded = decode_app_efforts(Some(&json));
        assert_eq!(decoded, list);
    }

    #[test]
    fn effective_reasoning_effort_omits_unsupported_models_and_keeps_raw_ids() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-effective-effort-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let result = upsert_custom_provider(UpsertProviderInput {
            id: "relay".into(),
            model: "no-think".into(),
            base_url: "https://relay.example/v1".into(),
            name: Some("Relay".into()),
            api_key: Some("test-key".into()),
            api_backend: Some("responses".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(true),
            models: Some(vec![
                ProviderModelEntry {
                    id: "no-think".into(),
                    name: "No think".into(),
                    supports_reasoning_effort: Some(false),
                    ..Default::default()
                },
                ProviderModelEntry {
                    id: "raw".into(),
                    name: "Raw".into(),
                    efforts: vec![
                        ProviderEffortEntry {
                            id: "max".into(),
                            name: "Max".into(),
                            is_default: false,
                        },
                        ProviderEffortEntry {
                            id: "minimal".into(),
                            name: "Minimal".into(),
                            is_default: false,
                        },
                        ProviderEffortEntry {
                            id: "none".into(),
                            name: "Off".into(),
                            is_default: false,
                        },
                    ],
                    ..Default::default()
                },
                ProviderModelEntry {
                    id: "configured-ladder".into(),
                    name: "Configured ladder".into(),
                    efforts: vec![ProviderEffortEntry {
                        id: "balanced".into(),
                        name: "Balanced".into(),
                        is_default: true,
                    }],
                    efforts_source: Some(MODEL_SOURCE_USER.into()),
                    supports_reasoning_effort: Some(false),
                    ..Default::default()
                },
                ProviderModelEntry {
                    id: "off-disabled".into(),
                    name: "Off disabled".into(),
                    efforts: vec![
                        ProviderEffortEntry {
                            id: "low".into(),
                            name: "Low".into(),
                            is_default: false,
                        },
                        ProviderEffortEntry {
                            id: "high".into(),
                            name: "High".into(),
                            is_default: true,
                        },
                        ProviderEffortEntry {
                            id: "none".into(),
                            name: "none".into(),
                            is_default: false,
                        },
                    ],
                    efforts_source: Some(MODEL_SOURCE_REMOTE.into()),
                    supports_reasoning_off: Some(false),
                    ..Default::default()
                },
                ProviderModelEntry {
                    id: "off-toggle".into(),
                    name: "Off toggle".into(),
                    efforts: vec![
                        ProviderEffortEntry {
                            id: "low".into(),
                            name: "Low".into(),
                            is_default: false,
                        },
                        ProviderEffortEntry {
                            id: "high".into(),
                            name: "High".into(),
                            is_default: true,
                        },
                    ],
                    efforts_source: Some(MODEL_SOURCE_USER.into()),
                    supports_reasoning_effort: Some(false),
                    supports_reasoning_off: Some(true),
                    ..Default::default()
                },
                ProviderModelEntry {
                    id: "empty".into(),
                    name: "No advertised ladder".into(),
                    supports_reasoning_effort: Some(true),
                    ..Default::default()
                },
                ProviderModelEntry {
                    id: "med".into(),
                    name: "Medium default".into(),
                    efforts: vec![
                        ProviderEffortEntry {
                            id: "low".into(),
                            name: "low".into(),
                            is_default: false,
                        },
                        ProviderEffortEntry {
                            id: "medium".into(),
                            name: "medium".into(),
                            is_default: false,
                        },
                        ProviderEffortEntry {
                            id: "high".into(),
                            name: "high".into(),
                            is_default: false,
                        },
                    ],
                    ..Default::default()
                },
            ]),
            efforts: Some(vec![ProviderEffortEntry {
                id: "channel-only".into(),
                name: "Channel only".into(),
                is_default: true,
            }]),
            context_window: None,
            base_url_full_path: Some(false),
            append_prompt: None,
            supports_vision: Some(false),
            extra_headers: None,
        });

        let config = std::fs::read_to_string(agent_config_toml()).expect("config");
        let omitted = effective_reasoning_effort("relay", "no-think", "high");
        let raw = effective_reasoning_effort("relay", "raw", "max");
        let off = effective_reasoning_effort("relay", "raw", "none");
        let configured = effective_reasoning_effort("relay", "configured-ladder", "balanced");
        let off_toggle = effective_reasoning_effort("relay", "off-toggle", "none");
        let off_disabled = effective_reasoning_effort("relay", "off-disabled", "none");
        let unadvertised_off = effective_reasoning_effort("relay", "med", "none");
        let unadvertised_off_without_model_ladder =
            effective_reasoning_effort("relay", "empty", "none");
        let medium = effective_reasoning_effort("relay", "med", "missing");
        let resolved_channel_model = effort_model_id_for_route("relay", "grok-4.7", "relay");
        let resolved_generic_model = effort_model_id_for_route("relay", "raw", "relay__raw");
        let stale_custom_session_model = session_set_model_id_for("relay", "grok-4.7");
        let resolved_active_session_model = session_set_model_id_for("relay", "no-think");
        let channel_model_fallback =
            effective_reasoning_effort("relay", &resolved_channel_model, "high");
        let official = effective_reasoning_effort("official", "grok-4.7", "xhigh");
        let invalid_official = effective_reasoning_effort("official", "grok-4.7", "max");
        let default_official_three_tier = effective_reasoning_effort("official", "grok-4.5", "");
        let unadvertised_official_off = effective_reasoning_effort("official", "grok-4.7", "none");
        let advertised_custom_off = model_advertises_reasoning_effort("relay", "raw", "none");
        let advertised_toggle_off =
            model_advertises_reasoning_effort("relay", "off-toggle", "none");
        let advertised_disabled_off =
            model_advertises_reasoning_effort("relay", "off-disabled", "none");
        let configured_ladder_reasoning =
            model_advertises_reasoning_effort("relay", "configured-ladder", "balanced");
        let unadvertised_custom_off = model_advertises_reasoning_effort("relay", "med", "none");
        let valid_custom_effort = is_valid_reasoning_effort_for_model("relay", "raw", "max");
        let valid_toggle_off = is_valid_reasoning_effort_for_model("relay", "off-toggle", "none");
        let invalid_disabled_off =
            is_valid_reasoning_effort_for_model("relay", "off-disabled", "none");
        let invalid_custom_effort = is_valid_reasoning_effort_for_model("relay", "raw", "ultra");
        let valid_generic_fallback = is_valid_reasoning_effort_for_model("relay", "empty", "xhigh");
        let channel_effort_not_borrowed =
            is_valid_reasoning_effort_for_model("relay", "empty", "channel-only");
        let unsupported_custom_effort =
            is_valid_reasoning_effort_for_model("relay", "no-think", "low");
        let deleted_provider_off =
            effective_reasoning_effort("deleted-provider-for-effort-test", "raw", "none");
        let valid_official_fallback =
            is_valid_reasoning_effort_for_model("official", "grok-4.7", "xhigh");
        let invalid_official_fallback =
            is_valid_reasoning_effort_for_model("official", "grok-4.7", "tier.2");

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
        result.expect("provider fixture");
        assert!(
            config.contains("supports_reasoning_effort = true"),
            "a model-level ladder must enable the CLI capability gate"
        );

        assert_eq!(omitted, None, "a model-level opt-out must omit the flag");
        assert_eq!(raw.as_deref(), Some("max"), "raw id must pass through");
        assert_eq!(off.as_deref(), Some("none"), "advertised Off stays a value");
        assert_eq!(
            configured.as_deref(),
            Some("balanced"),
            "a configured ladder enables reasoning"
        );
        assert_eq!(
            off_toggle.as_deref(),
            Some("none"),
            "the Off setting adds none"
        );
        assert_eq!(
            off_disabled.as_deref(),
            Some("high"),
            "explicit Off disable falls back to the ladder default"
        );
        assert_eq!(
            unadvertised_off_without_model_ladder.as_deref(),
            Some("medium"),
            "the generic model default must win over the channel ladder"
        );
        assert_eq!(
            unadvertised_off.as_deref(),
            Some("low"),
            "unadvertised Off falls to the first real tier (no fabricated medium)"
        );
        assert_eq!(
            medium.as_deref(),
            Some("low"),
            "an unknown id falls to the first tier when the ladder has no default flag"
        );
        assert_eq!(resolved_channel_model, "no-think");
        assert_eq!(resolved_generic_model, "raw");
        assert_eq!(stale_custom_session_model, resolved_active_session_model);
        assert_eq!(channel_model_fallback, None);
        assert_eq!(official.as_deref(), Some("xhigh"));
        assert_eq!(invalid_official.as_deref(), Some("xhigh"));
        assert_eq!(default_official_three_tier.as_deref(), Some("high"));
        assert_eq!(unadvertised_official_off, None);
        assert!(advertised_custom_off);
        assert!(advertised_toggle_off);
        assert!(!advertised_disabled_off);
        assert!(configured_ladder_reasoning);
        assert!(!unadvertised_custom_off);
        assert!(valid_custom_effort);
        assert!(valid_toggle_off);
        assert!(!invalid_disabled_off);
        assert!(!invalid_custom_effort);
        assert!(valid_generic_fallback);
        assert!(!channel_effort_not_borrowed);
        assert!(!unsupported_custom_effort);
        assert_eq!(deleted_provider_off.as_deref(), Some("medium"));
        assert!(valid_official_fallback);
        assert!(!invalid_official_fallback);
    }

    #[test]
    fn custom_provider_efforts_enable_cli_reasoning_effort() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home =
            std::env::temp_dir().join(format!("grok-app-provider-effort-{}", uuid::Uuid::new_v4()));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let result = upsert_custom_provider(UpsertProviderInput {
            id: "custom_gateway".into(),
            model: "custom-reasoner".into(),
            base_url: "https://custom.example/v1".into(),
            name: Some("Custom Gateway".into()),
            api_key: Some("test-key".into()),
            api_backend: Some("responses".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(true),
            models: Some(vec![ProviderModelEntry::named(
                "custom-reasoner",
                "Custom Reasoner",
            )]),
            efforts: Some(vec![ProviderEffortEntry {
                id: "xhigh".into(),
                name: "Extra high".into(),
                is_default: true,
            }]),
            context_window: None,
            base_url_full_path: Some(false),
            append_prompt: None,
            supports_vision: Some(false),
            extra_headers: None,
        })
        .and_then(|_| std::fs::read_to_string(agent_config_toml()).map_err(|e| e.to_string()));

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let config = result.expect("custom provider should be written");
        assert!(
            config.contains("supports_reasoning_effort = true"),
            "Grok Build must see the native capability gate:\n{config}"
        );
        assert!(
            !config.contains("supports_reasoning_effort = \"true\""),
            "Grok Build requires a TOML boolean, not a string:\n{config}"
        );
    }

    #[test]
    fn list_repairs_existing_custom_provider_reasoning_support() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-effort-repair-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let result = (|| -> Result<String, String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            write_text(
                &path,
                r#"[models]
default = "custom_gateway"

[model.custom_gateway]
model = "custom-reasoner"
base_url = "https://custom.example/v1"
api_key = "test-key"
api_backend = "responses"
app_efforts = "[{\"id\":\"xhigh\",\"name\":\"Extra high\",\"isDefault\":true}]"
"#,
            )?;
            list_custom_providers()?;
            std::fs::read_to_string(path).map_err(|e| e.to_string())
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let config = result.expect("existing provider should be repaired");
        assert!(
            config.contains("supports_reasoning_effort = true"),
            "existing App providers must be migrated without a manual re-save:\n{config}"
        );
    }

    #[test]
    fn list_repairs_explicit_false_global_gate_when_model_rows_have_efforts() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-effort-model-repair-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let result = (|| -> Result<String, String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let models = encode_app_models(&[ProviderModelEntry {
                id: "m1".into(),
                name: "M1".into(),
                supports_reasoning_effort: Some(true),
                efforts: vec![ProviderEffortEntry {
                    id: "balanced".into(),
                    name: "Balanced".into(),
                    is_default: true,
                }],
                ..Default::default()
            }])
            .map_err(|error| error.to_string())?;
            let path = agent_config_toml();
            write_text(
                &path,
                &format!(
                    r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://relay.example/v1"
api_key = "test-key"
api_backend = "responses"
supports_reasoning_effort = false
app_models = {}
"#,
                    quote(&models),
                ),
            )?;
            list_custom_providers()?;
            std::fs::read_to_string(path).map_err(|error| error.to_string())
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let config = result.expect("existing model effort metadata should be repaired");
        assert!(
            config.contains("supports_reasoning_effort = true"),
            "model efforts must enable Grok Build's provider capability gate:\n{config}"
        );
    }

    #[test]
    fn explicit_clears_survive_reload_without_legacy_resurrection() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-explicit-clear-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<(ProvidersListResult, String), String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let models = encode_app_models(&[
                ProviderModelEntry::named("m1", "M1"),
                ProviderModelEntry::named("m2", "M2"),
            ])
            .expect("encode app models");
            let efforts = encode_app_efforts(&[ProviderEffortEntry {
                id: "high".into(),
                name: "High".into(),
                is_default: true,
            }]);
            write_text(
                &path,
                &format!(
                    "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Relay\"
api_key = \"sk-legacy-key\"
api_backend = \"chat_completions\"
app_models = {}
app_efforts = {}
app_supports_vision = \"true\"
app_base_url_full_path = true
context_window = 128000
",
                    quote(&models),
                    quote(&efforts)
                ),
            )?;
            let listed = upsert_custom_provider(UpsertProviderInput {
                id: "relay".into(),
                model: "m1".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Relay".into()),
                api_key: None,
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models: Some(Vec::new()),
                efforts: Some(Vec::new()),
                context_window: Some(0),
                base_url_full_path: Some(false),
                append_prompt: Some(String::new()),
                supports_vision: Some(false),
                extra_headers: None,
            })?;
            let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok((listed, raw))
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let (listed, raw) = outcome.expect("explicit clears should be written");
        let provider = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert!(provider.models.is_empty(), "catalog clear must stick");
        assert!(provider.efforts.is_empty(), "effort clear must stick");
        assert_eq!(provider.context_window, None, "window clear must stick");
        assert!(!provider.supports_vision, "vision clear must stick");
        assert_eq!(provider.model, "m1", "active request model is preserved");
        assert!(
            raw.contains("app_models = \"[]\""),
            "an explicit empty catalog is stored as `[]`:\n{raw}"
        );
        assert!(!raw.contains("context_window ="), "{raw}");
        assert!(!raw.contains("app_efforts"), "{raw}");
        assert!(!raw.contains("app_supports_vision"), "{raw}");
        assert!(
            !raw.contains("app_base_url_full_path"),
            "full-path clear must stick:\n{raw}"
        );
        assert!(raw.contains("supports_reasoning_effort = false"), "{raw}");
        assert!(raw.contains("api_key = \"sk-legacy-key\""), "auth kept");
    }

    #[test]
    fn legacy_config_edit_without_new_fields_keeps_channel_values() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-legacy-edit-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<(ProvidersListResult, String), String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let efforts = encode_app_efforts(&[ProviderEffortEntry {
                id: "high".into(),
                name: "High".into(),
                is_default: true,
            }]);
            write_text(
                &path,
                &format!(
                    "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Relay\"
api_key = \"sk-legacy-key\"
api_backend = \"chat_completions\"
app_efforts = {}
app_supports_vision = \"true\"
context_window = 128000
",
                    quote(&efforts)
                ),
            )?;
            let listed = upsert_custom_provider(UpsertProviderInput {
                id: "relay".into(),
                model: "m1".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Relay".into()),
                api_key: None,
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models: None,
                efforts: None,
                context_window: None,
                base_url_full_path: None,
                append_prompt: None,
                supports_vision: None,
                extra_headers: None,
            })?;
            let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok((listed, raw))
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let (listed, raw) = outcome.expect("legacy config edit should succeed");
        let provider = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert_eq!(
            provider.models,
            vec![ProviderModelEntry::named("m1", "m1")],
            "legacy channel model becomes the single catalog row"
        );
        assert_eq!(provider.context_window, Some(128_000));
        assert_eq!(provider.efforts.len(), 1);
        assert_eq!(provider.efforts[0].id, "high");
        assert!(provider.efforts[0].is_default, "empty-value defaults kept");
        assert!(provider.supports_vision);
        assert!(
            raw.contains("context_window = 128000"),
            "integer window stays bare:\n{raw}"
        );
        assert!(raw.contains("api_key = \"sk-legacy-key\""), "{raw}");
    }

    struct CatalogEditSnapshot {
        bad_value: String,
        after_keep: String,
        after_clear: String,
        kept: ProvidersListResult,
        cleared: ProvidersListResult,
    }

    #[test]
    fn omitting_models_keeps_an_unusable_app_models_value_until_an_explicit_clear() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-corrupt-catalog-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<Vec<CatalogEditSnapshot>, String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let mut captured = Vec::new();
            for bad in [
                "not-json",
                "  not-json  ",
                r#"[{"id":"   "}]"#,
                "null",
                "\t{}\n",
                "{}",
                "\"m1\"",
                "1",
            ] {
                write_text(
                    &path,
                    &format!(
                        "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Relay\"
api_key = \"sk-legacy-key\"
api_backend = \"chat_completions\"
app_models = {}
",
                        quote(bad)
                    ),
                )?;
                let input = |models: Option<Vec<ProviderModelEntry>>| UpsertProviderInput {
                    id: "relay".into(),
                    model: "m1".into(),
                    base_url: "https://relay.example/v1".into(),
                    name: Some("Relay".into()),
                    api_key: None,
                    api_backend: Some("chat_completions".into()),
                    provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                    create_only: Some(false),
                    models,
                    efforts: None,
                    context_window: None,
                    base_url_full_path: None,
                    append_prompt: None,
                    supports_vision: None,
                    extra_headers: None,
                };
                let kept = upsert_custom_provider(input(None))?;
                let after_keep = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let cleared = upsert_custom_provider(input(Some(Vec::new())))?;
                let after_clear = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                captured.push(CatalogEditSnapshot {
                    bad_value: bad.to_string(),
                    after_keep,
                    after_clear,
                    kept,
                    cleared,
                });
            }
            Ok(captured)
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let captured = outcome.expect("unusable catalog edits should succeed");
        for snapshot in captured {
            assert_eq!(
                field_of(&snapshot.after_keep, "relay", APP_MODELS_KEY).as_deref(),
                Some(snapshot.bad_value.as_str()),
                "an edit that omits `models` must keep the unusable value:\n{}",
                snapshot.after_keep
            );
            assert_eq!(
                field_of(&snapshot.after_clear, "relay", APP_MODELS_KEY).as_deref(),
                Some("[]"),
                "only an explicit `models: []` clears the catalog:\n{}",
                snapshot.after_clear
            );
            let kept_relay = snapshot
                .kept
                .providers
                .iter()
                .find(|p| p.id == "relay")
                .expect("relay provider after keep");
            assert!(
                kept_relay.model_catalog_corrupt,
                "a non-array or unreadable value is not a legacy provider: {}",
                snapshot.bad_value
            );
            assert_eq!(
                kept_relay.models,
                vec![ProviderModelEntry::named("m1", "m1")],
                "unusable rows still read as the legacy channel model"
            );
            let cleared_relay = snapshot
                .cleared
                .providers
                .iter()
                .find(|p| p.id == "relay")
                .expect("relay provider after clear");
            assert!(cleared_relay.models.is_empty());
        }
    }

    struct VerbatimCatalogSnapshot {
        stored: String,
        after_keep: String,
        after_second_keep: String,
        after_change: String,
        after_clear: String,
        kept_models: Vec<ProviderModelEntry>,
    }

    #[test]
    fn omitting_models_keeps_the_stored_catalog_field_verbatim() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-verbatim-catalog-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<Vec<VerbatimCatalogSnapshot>, String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let mut captured = Vec::new();
            for stored in [
                // Blank is a legacy provider, but the present key must stay.
                "",
                "  [{\"id\":\"m1\",\"name\":\"M1\",\"appNote\":\"keep-me\",\"contextWindow\":128000}]  ",
            ] {
                write_text(
                    &path,
                    &format!(
                        "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Relay\"
api_key = \"sk-legacy-key\"
api_backend = \"chat_completions\"
app_provider_mode = \"generic\"
app_models = {}
",
                        quote(stored)
                    ),
                )?;
                let input = |models: Option<Vec<ProviderModelEntry>>| UpsertProviderInput {
                    id: "relay".into(),
                    model: "m1".into(),
                    base_url: "https://relay.example/v1".into(),
                    name: Some("Relay".into()),
                    api_key: None,
                    api_backend: Some("chat_completions".into()),
                    provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                    create_only: Some(false),
                    models,
                    efforts: None,
                    context_window: None,
                    base_url_full_path: None,
                    append_prompt: None,
                    supports_vision: None,
                    extra_headers: None,
                };
                let kept = upsert_custom_provider(input(None))?;
                let after_keep = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                upsert_custom_provider(input(None))?;
                let after_second_keep =
                    std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                upsert_custom_provider(input(Some(vec![ProviderModelEntry::named("m2", "M2")])))?;
                let after_change = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                upsert_custom_provider(input(Some(Vec::new())))?;
                let after_clear = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                captured.push(VerbatimCatalogSnapshot {
                    stored: stored.to_string(),
                    after_keep,
                    after_second_keep,
                    after_change,
                    after_clear,
                    kept_models: kept
                        .providers
                        .iter()
                        .find(|p| p.id == "relay")
                        .map(|p| p.models.clone())
                        .unwrap_or_default(),
                });
            }
            Ok(captured)
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let captured = outcome.expect("catalog edits should succeed");
        assert_eq!(captured.len(), 2);
        let changed_catalog =
            encode_app_models(&[ProviderModelEntry::named("m2", "M2")]).expect("encode catalog");
        for snapshot in &captured {
            assert_eq!(
                field_of(&snapshot.after_keep, "relay", APP_MODELS_KEY).as_deref(),
                Some(snapshot.stored.as_str()),
                "`models: None` must write back the decoded field value, unknown row fields and \
                 whitespace included:\n{}",
                snapshot.after_keep
            );
            assert_eq!(
                field_of(&snapshot.after_second_keep, "relay", APP_MODELS_KEY).as_deref(),
                Some(snapshot.stored.as_str()),
                "the preserved value must be stable across saves:\n{}",
                snapshot.after_second_keep
            );
            assert_eq!(
                field_of(&snapshot.after_change, "relay", APP_MODELS_KEY).as_deref(),
                Some(changed_catalog.as_str()),
                "`models: Some(rows)` must write the normalized catalog:\n{}",
                snapshot.after_change
            );
            assert_eq!(
                field_of(&snapshot.after_clear, "relay", APP_MODELS_KEY).as_deref(),
                Some("[]"),
                "`models: []` must stay an explicit clear:\n{}",
                snapshot.after_clear
            );
        }
        assert_eq!(
            captured[0].kept_models,
            vec![ProviderModelEntry::named("m1", "m1")],
            "a blank catalog still reads as the legacy channel row"
        );
        assert_eq!(
            captured[1].kept_models,
            vec![ProviderModelEntry {
                id: "m1".into(),
                name: "M1".into(),
                context_window: Some(128_000),
                context_window_source: Some("user".into()),
                supports_vision: None,
                supports_video: None,
                efforts: Vec::new(),
                ..Default::default()
            }],
            "an unrelated save must not change what the catalog reads back"
        );
    }

    #[test]
    fn omitting_models_leaves_a_legacy_parent_without_the_catalog_key() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-legacy-catalog-key-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<(String, String, Vec<ProviderModelEntry>), String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            write_text(
                &path,
                "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Relay\"
api_key = \"sk-legacy-key\"
api_backend = \"chat_completions\"
",
            )?;
            let input = |models: Option<Vec<ProviderModelEntry>>| UpsertProviderInput {
                id: "relay".into(),
                model: "m1".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Relay".into()),
                api_key: None,
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models,
                efforts: None,
                context_window: None,
                base_url_full_path: None,
                append_prompt: None,
                supports_vision: None,
                extra_headers: None,
            };
            let kept = upsert_custom_provider(input(None))?;
            let after_keep = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            upsert_custom_provider(input(Some(vec![ProviderModelEntry::named("m1", "M1")])))?;
            let after_explicit = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let kept_models = kept
                .providers
                .iter()
                .find(|p| p.id == "relay")
                .map(|p| p.models.clone())
                .unwrap_or_default();
            Ok((after_keep, after_explicit, kept_models))
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let (after_keep, after_explicit, kept_models) = outcome.expect("edits should succeed");
        assert!(
            field_of(&after_keep, "relay", APP_MODELS_KEY).is_none(),
            "an omitted `models` must not create a catalog key a legacy parent never had:\n{after_keep}"
        );
        assert_eq!(
            kept_models,
            vec![ProviderModelEntry::named("m1", "m1")],
            "a legacy parent still lists its channel model"
        );
        assert_eq!(
            field_of(&after_explicit, "relay", APP_MODELS_KEY).as_deref(),
            Some(
                encode_app_models(&[ProviderModelEntry::named("m1", "M1")])
                    .expect("encode catalog")
                    .as_str()
            ),
            "an explicit catalog edit creates the key:\n{after_explicit}"
        );
    }

    #[test]
    fn parsed_app_models_distinguishes_an_absent_key_from_a_blank_value() {
        let text = "\
[model.absent]
model = \"m\"

[model.blank]
model = \"m\"
app_models = \"\"
";
        let sections = parse_model_sections(text);

        assert!(!sections[0].fields.contains_key(APP_MODELS_KEY));
        assert_eq!(
            sections[1].fields.get(APP_MODELS_KEY).map(String::as_str),
            Some("")
        );
    }

    #[test]
    fn omitting_models_keeps_the_channel_model_of_a_partially_invalid_catalog() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-recovered-channel-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        // The channel runs `m1`; only `m2` survives the partial read, because
        // the second row carries no readable id.
        let raw = r#"[{"id":"m2","name":"M2","contextWindow":64000,"supportsVision":false,"efforts":[{"id":"low","name":"Low","isDefault":true}]},{"id":null,"name":"M1"}]"#;
        let old_efforts = r#"[{"id":"high","name":"High","isDefault":true}]"#;

        let outcome = (|| -> Result<(String, ProvidersListResult, String), String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            write_text(
                &path,
                &format!(
                    "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://old.example/v1\"
name = \"Relay\"
api_key = \"sk-old\"
api_backend = \"chat_completions\"
app_provider_mode = \"generic\"
context_window = 32000
app_supports_vision = \"true\"
app_efforts = {}
app_models = {}

[model.relay__m1]
model = \"m1\"
base_url = \"https://old.example/v1\"
name = \"M1 saved\"
api_key = \"sk-old\"
api_backend = \"chat_completions\"
app_provider_mode = \"generic\"
app_parent_provider = \"relay\"
",
                    quote(old_efforts),
                    quote(raw)
                ),
            )?;
            let listed = upsert_custom_provider(UpsertProviderInput {
                id: "relay".into(),
                // What a caller that only saw the recovery rows sends.
                model: "m2".into(),
                base_url: "https://new.example/v1".into(),
                name: Some("Relay renamed".into()),
                api_key: Some("sk-new".into()),
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models: None,
                efforts: None,
                context_window: None,
                base_url_full_path: None,
                append_prompt: None,
                supports_vision: None,
                extra_headers: None,
            })?;
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let recovered_section = session_set_model_id_for("relay", "m2");
            Ok((text, listed, recovered_section))
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let (after, listed, recovered_section) =
            outcome.expect("an edit that omits `models` should succeed");
        assert_eq!(
            field_of(&after, "relay", APP_MODELS_KEY).as_deref(),
            Some(raw),
            "the unreadable catalog stays byte-identical:\n{after}"
        );
        assert_eq!(
            field_of(&after, "relay", "model").as_deref(),
            Some("m1"),
            "the channel keeps its stored model instead of the recovered row:\n{after}"
        );
        assert_eq!(
            field_of(&after, "relay", "context_window").as_deref(),
            Some("32000"),
            "the recovered row's window must not become the channel window:\n{after}"
        );
        assert_eq!(
            field_of(&after, "relay", APP_SUPPORTS_VISION_KEY).as_deref(),
            Some("true"),
            "the recovered row's vision flag must not reach the channel:\n{after}"
        );
        assert_eq!(
            field_of(&after, "relay", APP_EFFORTS_KEY).as_deref(),
            Some(old_efforts),
            "the recovered row's effort ladder must not reach the channel:\n{after}"
        );
        assert_eq!(
            field_of(&after, "relay", "name").as_deref(),
            Some("Relay renamed")
        );
        assert_eq!(
            field_of(&after, "relay", "api_key").as_deref(),
            Some("sk-new")
        );

        assert_eq!(
            field_of(&after, "relay__m1", "model").as_deref(),
            Some("m1")
        );
        assert_eq!(
            field_of(&after, "relay__m1", "name").as_deref(),
            Some("M1 saved"),
            "an older child keeps its identity on this save"
        );
        assert_eq!(
            field_of(&after, "relay__m1", "base_url").as_deref(),
            Some("https://new.example/v1"),
            "older children still follow the channel route"
        );
        assert_eq!(
            field_of(&after, "relay__m1", "api_key").as_deref(),
            Some("sk-new")
        );

        assert_eq!(recovered_section, "relay__m2");
        assert_eq!(
            field_of(&after, &recovered_section, "model").as_deref(),
            Some("m2"),
            "a recovered row keeps its own routable child"
        );
        assert_eq!(
            field_of(&after, &recovered_section, "context_window").as_deref(),
            Some("64000"),
            "recovered metadata belongs to the row's child, not the channel"
        );

        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider after the edit");
        assert_eq!(relay.model, "m1");
        assert_eq!(relay.context_window, Some(32_000));
        assert!(relay.supports_vision);
        assert_eq!(
            relay
                .efforts
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            ["high"]
        );
        assert_eq!(
            relay
                .models
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            ["m2"]
        );
        assert!(relay.model_catalog_corrupt);
    }

    #[test]
    fn malformed_model_lists_are_rejected_while_explicit_clear_and_repair_write() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-malformed-catalog-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<(String, String, String, String, String), String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let bad = "not-json";
            write_text(
                &path,
                &format!(
                    "\
[models]
default = \"relay\"

[model.relay]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Relay\"
api_key = \"sk-legacy-key\"
api_backend = \"chat_completions\"
app_provider_mode = \"generic\"
app_models = {}
",
                    quote(bad)
                ),
            )?;
            let input = |models: Option<Vec<ProviderModelEntry>>| UpsertProviderInput {
                id: "relay".into(),
                model: "m1".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Relay".into()),
                api_key: None,
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models,
                efforts: None,
                context_window: None,
                base_url_full_path: None,
                append_prompt: None,
                supports_vision: None,
                extra_headers: None,
            };
            let rejected = upsert_custom_provider(input(Some(vec![
                ProviderModelEntry::default(),
                ProviderModelEntry::named("   ", "Blank"),
                ProviderModelEntry::named("\t\n", ""),
            ])))
            .expect_err("a non-empty list without usable rows is not a clear");
            let after_reject = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let repaired = upsert_custom_provider(input(Some(vec![
                ProviderModelEntry::named("m2", "M2"),
                ProviderModelEntry::named("m3", "M3"),
            ])))?;
            let after_repair = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let cleared = upsert_custom_provider(input(Some(Vec::new())))?;
            assert!(
                cleared
                    .providers
                    .iter()
                    .find(|p| p.id == "relay")
                    .is_some_and(|p| p.models.is_empty() && !p.model_catalog_corrupt),
                "an explicit clear should be reflected in the provider list"
            );
            let after_clear = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let repaired_ids = repaired
                .providers
                .iter()
                .find(|p| p.id == "relay")
                .map(|p| {
                    (
                        p.model_catalog_corrupt,
                        p.models
                            .iter()
                            .map(|m| m.id.as_str())
                            .collect::<Vec<_>>()
                            .join(","),
                    )
                })
                .unwrap_or_default();
            Ok((
                rejected,
                after_reject,
                after_repair,
                after_clear,
                format!("{}|{}", repaired_ids.0, repaired_ids.1),
            ))
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let (rejected, after_reject, after_repair, after_clear, repaired_state) =
            outcome.expect("malformed catalog handling should complete");
        assert!(
            rejected.contains("non-empty id"),
            "the error must name the contract violation: {rejected}"
        );
        assert!(
            !rejected.contains("sk-legacy-key"),
            "validation errors must not echo credentials: {rejected}"
        );
        assert_eq!(
            field_of(&after_reject, "relay", APP_MODELS_KEY).as_deref(),
            Some("not-json"),
            "a rejected catalog write must leave disk untouched:\n{after_reject}"
        );
        assert_eq!(
            field_of(&after_repair, "relay", APP_MODELS_KEY).as_deref(),
            Some(r#"[{"id":"m2","name":"M2"},{"id":"m3","name":"M3"}]"#),
            "an explicit replacement repairs the catalog:\n{after_repair}"
        );
        assert_eq!(
            repaired_state, "false|m2,m3",
            "repair clears the corrupt flag and keeps row order"
        );
        assert_eq!(
            field_of(&after_clear, "relay", APP_MODELS_KEY).as_deref(),
            Some("[]"),
            "an explicit empty list is still a clear, not an error:\n{after_clear}"
        );
    }

    #[test]
    fn blank_model_rows_are_rejected_before_normalization() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-blank-model-row-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        struct Outcome {
            saved_ids: Vec<String>,
            rejected: String,
            after_save: String,
            after_reject: String,
            cleared_ids: Vec<String>,
            after_clear: String,
        }

        let outcome = (|| -> Result<Outcome, String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let input = |models: Option<Vec<ProviderModelEntry>>| UpsertProviderInput {
                id: "relay".into(),
                model: String::new(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Relay".into()),
                api_key: Some("sk-relay-key".into()),
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models,
                efforts: None,
                context_window: None,
                base_url_full_path: None,
                append_prompt: None,
                supports_vision: None,
                extra_headers: None,
            };
            let saved = upsert_custom_provider(input(Some(vec![
                ProviderModelEntry::named("m1", "M1"),
                ProviderModelEntry::named(" m2 ", ""),
            ])))?;
            let saved_ids = saved
                .providers
                .iter()
                .find(|p| p.id == "relay")
                .map(|p| p.models.iter().map(|m| m.id.clone()).collect())
                .unwrap_or_default();
            let after_save = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let rejected = upsert_custom_provider(input(Some(vec![
                ProviderModelEntry::named("m1", "M1"),
                ProviderModelEntry::named("  ", "Half-typed"),
            ])))
            .expect_err("a blank row is rejected even when other rows are valid");
            let after_reject = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let cleared = upsert_custom_provider(input(Some(Vec::new())))?;
            let cleared_ids = cleared
                .providers
                .iter()
                .find(|p| p.id == "relay")
                .filter(|p| !p.model_catalog_corrupt)
                .map(|p| p.models.iter().map(|m| m.id.clone()).collect())
                .unwrap_or_default();
            let after_clear = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok(Outcome {
                saved_ids,
                rejected,
                after_save,
                after_reject,
                cleared_ids,
                after_clear,
            })
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let Outcome {
            saved_ids,
            rejected,
            after_save,
            after_reject,
            cleared_ids,
            after_clear,
        } = outcome.expect("blank-row handling should complete");
        assert_eq!(
            saved_ids,
            vec!["m1".to_string(), "m2".to_string()],
            "every valid row persists, trimmed, in order"
        );
        assert!(
            rejected.contains("non-empty id"),
            "the error must name the contract violation: {rejected}"
        );
        assert!(
            !rejected.contains("Half-typed") && !rejected.contains("sk-relay-key"),
            "validation errors must not echo user input: {rejected}"
        );
        assert_eq!(
            after_reject, after_save,
            "a rejected catalog write must leave disk untouched"
        );
        assert!(
            cleared_ids.is_empty(),
            "an explicit empty list still clears the catalog: {cleared_ids:?}"
        );
        assert_eq!(
            field_of(&after_clear, "relay", APP_MODELS_KEY).as_deref(),
            Some("[]"),
            "explicit clear writes [] instead of a guessed catalog:\n{after_clear}"
        );
    }

    #[test]
    fn model_profiles_roundtrip_through_config_toml() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-model-roundtrip-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<(ProvidersListResult, ProvidersListResult), String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let models = vec![
                ProviderModelEntry {
                    id: "vision".into(),
                    name: "Vision".into(),
                    context_window: Some(1_048_576),
                    context_window_source: Some("remote".into()),
                    supports_vision: Some(true),
                    supports_video: Some(true),
                    efforts: vec![
                        ProviderEffortEntry {
                            id: "low".into(),
                            name: "Low".into(),
                            is_default: false,
                        },
                        ProviderEffortEntry {
                            id: "max".into(),
                            name: "Max".into(),
                            is_default: true,
                        },
                    ],
                    efforts_source: Some("user".into()),
                    supports_reasoning_effort: Some(false),
                    supports_reasoning_effort_source: Some("remote".into()),
                    supports_reasoning_off: Some(true),
                },
                ProviderModelEntry {
                    id: "text".into(),
                    name: "Text".into(),
                    context_window: None,
                    supports_vision: Some(false),
                    supports_video: None,
                    efforts: Vec::new(),
                    ..Default::default()
                },
            ];
            upsert_custom_provider(UpsertProviderInput {
                id: "relay".into(),
                model: "vision".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Relay".into()),
                api_key: Some("sk-test-key".into()),
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(true),
                models: Some(models.clone()),
                efforts: Some(vec![ProviderEffortEntry {
                    id: "medium".into(),
                    name: "Medium".into(),
                    is_default: true,
                }]),
                context_window: None,
                base_url_full_path: Some(false),
                append_prompt: None,
                supports_vision: Some(false),
                extra_headers: None,
            })?;
            let first = list_custom_providers()?;
            // Re-open and save without touching the catalog.
            let second = upsert_custom_provider(UpsertProviderInput {
                id: "relay".into(),
                model: "text".into(),
                base_url: "https://relay.example/v1".into(),
                name: Some("Relay renamed".into()),
                api_key: None,
                api_backend: Some("chat_completions".into()),
                provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
                create_only: Some(false),
                models: None,
                efforts: None,
                context_window: None,
                base_url_full_path: None,
                append_prompt: None,
                supports_vision: None,
                extra_headers: None,
            })?;
            Ok((first, second))
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let (first, second) = outcome.expect("model profiles should round-trip");
        let first_provider = first
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert_eq!(first_provider.models.len(), 2);
        assert_eq!(first_provider.models[0].id, "vision");
        assert_eq!(first_provider.models[0].name, "Vision");
        assert_eq!(first_provider.models[0].context_window, Some(1_048_576));
        assert_eq!(
            first_provider.models[0].context_window_source.as_deref(),
            Some("remote")
        );
        assert_eq!(first_provider.models[0].supports_vision, Some(true));
        assert_eq!(first_provider.models[0].supports_video, Some(true));
        assert_eq!(
            first_provider.models[0].efforts_source.as_deref(),
            Some("user")
        );
        assert_eq!(
            first_provider.models[0].supports_reasoning_effort,
            Some(false)
        );
        assert_eq!(
            first_provider.models[0]
                .supports_reasoning_effort_source
                .as_deref(),
            Some("remote")
        );
        assert_eq!(first_provider.models[0].supports_reasoning_off, Some(true));
        assert_eq!(
            first_provider.models[0]
                .efforts
                .iter()
                .map(|e| (e.id.as_str(), e.is_default))
                .collect::<Vec<_>>(),
            [("low", false), ("max", true)]
        );
        assert_eq!(first_provider.models[1].id, "text");
        assert_eq!(first_provider.models[1].context_window, None);

        let second_provider = second
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider after reopen");
        assert_eq!(second_provider.name, "Relay renamed");
        assert_eq!(
            second_provider.models, first_provider.models,
            "an edit that omits `models` must keep every row"
        );
        assert_eq!(
            second_provider.context_window,
            first_provider.context_window
        );
        assert_eq!(second_provider.efforts, first_provider.efforts);
        assert_eq!(second_provider.model, "text");
    }

    #[test]
    fn context_window_roundtrips_through_toml() {
        // Write a context_window field, parse back, and verify the same
        // parse logic `build_list_result` uses (string → u64, filtered > 0).
        let text = append_section(
            "",
            "demo",
            &[
                ("model".into(), "m1".into()),
                ("base_url".into(), "https://ex/v1".into()),
                ("name".into(), "Demo".into()),
                ("api_key".into(), "sk-test".into()),
                ("api_backend".into(), "chat_completions".into()),
                ("context_window".into(), "1000000".into()),
            ],
        );
        // Grok Build requires a bare integer — never a quoted string (#538).
        assert!(
            text.contains("context_window = 1000000"),
            "expected bare integer, got:\n{text}"
        );
        assert!(
            !text.contains("context_window = \"1000000\""),
            "must not quote context_window:\n{text}"
        );
        let sections = parse_model_sections(&text);
        assert_eq!(sections.len(), 1);
        let s = &sections[0];
        assert!(is_custom(&s.fields));
        let cw = s
            .fields
            .get("context_window")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0);
        assert_eq!(cw, Some(1000000));

        // Zero / missing → filtered to None (mirrors build_list_result semantics).
        let text0 = append_section(
            "",
            "demo0",
            &[
                ("model".into(), "m0".into()),
                ("base_url".into(), "https://ex/v1".into()),
                ("name".into(), "Demo0".into()),
                ("api_key".into(), "sk-test".into()),
                ("api_backend".into(), "chat_completions".into()),
                ("context_window".into(), "0".into()),
            ],
        );
        let s0 = parse_model_sections(&text0)[0].clone();
        let cw0 = s0
            .fields
            .get("context_window")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0);
        assert_eq!(cw0, None);
    }

    #[test]
    fn repair_quoted_context_window_heals_legacy_string_writes() {
        let broken = r#"
[model.opencode-go]
model = "go"
base_url = "https://ex/v1"
name = "OpenCode"
api_key = "sk-test"
api_backend = "chat_completions"
context_window = "1000000"
"#;
        let fixed = repair_quoted_integer_fields(broken);
        assert!(fixed.contains("context_window = 1000000"));
        assert!(!fixed.contains("context_window = \"1000000\""));
        // Idempotent.
        assert_eq!(repair_quoted_integer_fields(&fixed), fixed);
        let s = parse_model_sections(&fixed)[0].clone();
        let cw = s
            .fields
            .get("context_window")
            .and_then(|v| v.parse::<u64>().ok());
        assert_eq!(cw, Some(1_000_000));
    }

    #[test]
    fn edit_without_context_window_keeps_integer_on_rewrite() {
        // Simulate: user set 1M, then GUI rewrites section for model/effort only.
        let mut text = append_section(
            "",
            "ch",
            &[
                ("model".into(), "m1".into()),
                ("base_url".into(), "https://ex/v1".into()),
                ("name".into(), "Ch".into()),
                ("api_key".into(), "sk".into()),
                ("api_backend".into(), "chat_completions".into()),
                ("context_window".into(), "1000000".into()),
            ],
        );
        // Rewrite like upsert with preserved context_window value from parse.
        let sections = parse_model_sections(&text);
        let cw = sections[0].fields.get("context_window").cloned().unwrap();
        text = remove_section(&text, "ch");
        text = append_section(
            &text,
            "ch",
            &[
                ("model".into(), "m2".into()),
                ("base_url".into(), "https://ex/v1".into()),
                ("name".into(), "Ch".into()),
                ("api_key".into(), "sk".into()),
                ("api_backend".into(), "chat_completions".into()),
                ("context_window".into(), cw),
            ],
        );
        assert!(
            text.contains("context_window = 1000000"),
            "rewrite must keep bare int:\n{text}"
        );
        assert!(!text.contains("context_window = \"1000000\""));
    }

    #[test]
    fn official_route_does_not_remap_a_custom_catalog_model() {
        // A chat without a custom provider preference is official. A stale relay
        // Model id must not silently route it back to that relay.
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-spawn-model-1000-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = ensure_agent_home();

        upsert_custom_provider(UpsertProviderInput {
            id: "qwen38-local".into(),
            model: "qwen3.8-27b".into(),
            base_url: "http://127.0.0.1:8080/v1".into(),
            name: Some("Qwen local".into()),
            api_key: Some("sk-test".into()),
            api_backend: Some("chat_completions".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(true),
            models: Some(vec![
                ProviderModelEntry::named("qwen3.8-27b", "Qwen3.8 27B"),
                ProviderModelEntry::named("grok-4.7", "Grok 4.7"),
                ProviderModelEntry::named("grok-4.7-build-fast", "Grok 4.7 Fast"),
                ProviderModelEntry::named("grok-4.6", "Grok 4.6"),
            ]),
            efforts: None,
            context_window: None,
            base_url_full_path: None,
            append_prompt: None,
            supports_vision: None,
            extra_headers: None,
        })
        .expect("upsert");

        assert_eq!(
            spawn_model_for_provider("qwen38-local", "qwen3.8-27b"),
            generic_model_section_id("qwen38-local", "qwen3.8-27b")
        );
        assert_eq!(
            session_set_model_id_for("qwen38-local", "qwen3.8-27b"),
            generic_model_section_id("qwen38-local", "qwen3.8-27b")
        );
        // Official catalog ids are never remapped through a relay that lists them.
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, "grok-4.6"),
            "grok-4.6"
        );
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, "grok-4.7"),
            "grok-4.7"
        );
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, "grok-4.7-build-fast"),
            "grok-4.7-build-fast"
        );
        // A stale relay model on the official route opens instead of 401ing.
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, "qwen3.8-27b"),
            OFFICIAL_CATALOG_MODEL
        );
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, "qwen38-local"),
            OFFICIAL_CATALOG_MODEL
        );

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn extra_headers_write_cli_inline_table() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-headers-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let listed = upsert_custom_provider(UpsertProviderInput {
            id: "agentrouter".into(),
            model: "claude-opus-4-6".into(),
            base_url: "https://agentrouter.org/v1".into(),
            name: Some("AgentRouter".into()),
            api_key: Some("sk-test".into()),
            api_backend: Some("chat_completions".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(true),
            models: None,
            efforts: None,
            context_window: None,
            base_url_full_path: Some(false),
            append_prompt: None,
            supports_vision: Some(false),
            extra_headers: Some(vec![ProviderHeaderEntry {
                name: "Originator".into(),
                value: "codex_cli_rs".into(),
            }]),
        });

        let config = std::fs::read_to_string(agent_config_toml()).ok();
        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let listed = listed.expect("upsert");
        assert_eq!(listed.providers[0].extra_headers.len(), 1);
        assert_eq!(listed.providers[0].extra_headers[0].name, "Originator");
        let config = config.expect("config");
        assert!(
            config.contains("extra_headers = {") && config.contains("\"Originator\""),
            "CLI extra_headers must be an inline table:\n{config}"
        );
        assert!(
            !config.contains("extra_headers = \"{"),
            "must not quote the table as a string:\n{config}"
        );
    }

    #[test]
    fn extra_headers_empty_list_clears_inline_table() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-provider-headers-clear-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        upsert_custom_provider(UpsertProviderInput {
            id: "agentrouter".into(),
            model: "claude-opus-4-6".into(),
            base_url: "https://agentrouter.org/v1".into(),
            name: Some("AgentRouter".into()),
            api_key: Some("sk-test".into()),
            api_backend: Some("chat_completions".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(true),
            models: None,
            efforts: None,
            context_window: None,
            base_url_full_path: Some(false),
            append_prompt: None,
            supports_vision: Some(false),
            extra_headers: Some(vec![ProviderHeaderEntry {
                name: "Originator".into(),
                value: "codex_cli_rs".into(),
            }]),
        })
        .expect("create");

        let listed = upsert_custom_provider(UpsertProviderInput {
            id: "agentrouter".into(),
            model: "claude-opus-4-6".into(),
            base_url: "https://agentrouter.org/v1".into(),
            name: Some("AgentRouter".into()),
            api_key: None,
            api_backend: Some("chat_completions".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(false),
            models: None,
            efforts: None,
            context_window: None,
            base_url_full_path: Some(false),
            append_prompt: None,
            supports_vision: Some(false),
            extra_headers: Some(vec![]),
        });
        let config = std::fs::read_to_string(agent_config_toml()).ok();
        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let listed = listed.expect("clear");
        assert!(listed.providers[0].extra_headers.is_empty());
        let config = config.expect("config");
        assert!(
            !config.contains("extra_headers"),
            "empty list must drop extra_headers, not copy the old table:\n{config}"
        );
    }

    #[test]
    fn effort_lookup_uses_composer_model_id_not_generic_spawn_section() {
        assert_eq!(effort_model_id_for_route("relay", "m2", "relay__m2"), "m2");
        assert_eq!(
            effort_model_id_for_route(SESSION_PROVIDER_OFFICIAL, "deleted-model", "grok-4.7"),
            "grok-4.7"
        );
    }

    #[test]
    fn session_route_does_not_follow_a_legacy_global_default() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home =
            std::env::temp_dir().join(format!("grok-app-session-route-{}", uuid::Uuid::new_v4()));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = ensure_agent_home();
        let mut settings = crate::store::load_settings();
        settings.model_id = Some("grok-4.6".into());
        crate::store::save_settings(&settings).expect("save official model default");
        let path = agent_config_toml();
        let text = set_models_default(&read_text(&path), "relay");
        write_text(&path, &text).expect("write config");
        let text = append_section(
            &read_text(&path),
            "relay",
            &[
                ("base_url".into(), "https://relay.example/v1".into()),
                ("api_key".into(), "sk-test".into()),
                ("model".into(), "shared-model".into()),
                (APP_MODELS_KEY.into(), "[]".into()),
            ],
        );
        write_text(&path, &text).expect("write provider");

        assert_eq!(session_route_provider_id(None), SESSION_PROVIDER_OFFICIAL);
        assert_eq!(session_route_provider_id(Some("relay")), "relay");
        assert_eq!(
            session_route_provider_id(Some("deleted-relay")),
            "deleted-relay"
        );
        assert_eq!(
            existing_session_route("deleted-relay", "", false),
            SESSION_PROVIDER_OFFICIAL
        );
        assert_eq!(
            existing_session_route(SESSION_PROVIDER_OFFICIAL, "", false),
            SESSION_PROVIDER_OFFICIAL
        );
        assert_eq!(
            existing_session_route("relay", "", false),
            SESSION_PROVIDER_OFFICIAL
        );
        assert_eq!(
            existing_session_route("relay", "grok-4.6", false),
            SESSION_PROVIDER_OFFICIAL
        );
        assert_eq!(
            existing_session_route("relay", "shared-model", true),
            "relay"
        );
        assert_eq!(
            crate::models_catalog::list_available_models().default_model_id,
            "grok-4.6"
        );
        assert_eq!(
            session_model_id_for_route(
                Some("deleted-relay"),
                SESSION_PROVIDER_OFFICIAL,
                "grok-4.6",
            ),
            crate::models_catalog::list_available_models().default_model_id,
            "a model id shared with the official catalog must still use the official fallback after deletion",
        );
        assert_eq!(
            session_model_id_for_route(Some("relay"), SESSION_PROVIDER_OFFICIAL, "grok-4.6",),
            "grok-4.6",
            "an existing SSH-pinned provider keeps a valid official model id",
        );

        match previous {
            Some(v) => std::env::set_var("GROK_APP_HOME", v),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn append_prompt_is_read_from_the_chat_provider_only() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home =
            std::env::temp_dir().join(format!("grok-app-provider-rules-{}", uuid::Uuid::new_v4()));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = ensure_agent_home();
        let path = agent_config_toml();
        let text = append_section(
            &read_text(&path),
            "relay",
            &[
                ("base_url".into(), "https://relay.example/v1".into()),
                ("api_key".into(), "sk-test".into()),
                ("model".into(), "m1".into()),
                (APP_APPEND_PROMPT_KEY.into(), "Use relay rules".into()),
            ],
        );
        write_text(&path, &text).expect("write provider");

        assert_eq!(
            provider_append_prompt("relay").as_deref(),
            Some("Use relay rules")
        );
        assert!(provider_append_prompt(SESSION_PROVIDER_OFFICIAL).is_none());
        assert!(provider_append_prompt("missing").is_none());

        match previous {
            Some(v) => std::env::set_var("GROK_APP_HOME", v),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_official_model_falls_back_to_the_official_default() {
        let unknown = format!("not-an-official-model-{}", uuid::Uuid::new_v4());
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, &unknown),
            OFFICIAL_CATALOG_MODEL
        );
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, ""),
            OFFICIAL_CATALOG_MODEL
        );
        assert_eq!(
            session_set_model_id_for(SESSION_PROVIDER_OFFICIAL, OFFICIAL_DEFAULT_MODEL),
            OFFICIAL_CATALOG_MODEL
        );
    }

    #[test]
    fn explicit_provider_pick_compares_effective_ids() {
        use SessionProviderPick::*;
        assert_eq!(
            session_provider_pick(false, Some("official"), Some("official")),
            SameRoute
        );
        assert_eq!(
            session_provider_pick(false, Some("relay-b"), Some("relay-b")),
            SameRoute
        );
        assert_eq!(
            session_provider_pick(false, Some("relay-b"), Some("official")),
            RouteChanged
        );
        assert_eq!(
            session_provider_pick(false, Some("official"), Some("relay-b")),
            RouteChanged
        );
        assert_eq!(
            session_provider_pick(false, Some("official"), None),
            SameRoute
        );
        assert_eq!(session_provider_pick(false, None, None), SameRoute);
    }

    #[test]
    fn ssh_pick_stays_official_and_drops_a_custom_provider() {
        use SessionProviderPick::*;
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!(
            "grok-app-ssh-pick-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("temp home");
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &tmp);
        let _ = crate::paths::ensure_app_dirs();

        assert_eq!(connect_route_id(true, Some("relay-b")), "official");
        assert_eq!(connect_route_id(true, None), "official");
        assert_eq!(connect_route_id(false, Some("relay-b")), "relay-b");

        // Official model on an SSH chat: never a route change, even if the row
        // still has a custom id or the stored id is empty.
        assert_eq!(
            session_provider_pick(true, None, Some("official")),
            SameRoute
        );
        assert_eq!(
            session_provider_pick(true, Some("relay-b"), Some("official")),
            SameRoute
        );
        assert_eq!(
            session_provider_pick(true, Some(""), Some("official")),
            SameRoute
        );
        let official = composer_provider_pick(true, None, Some("official"), Some("grok-4.7"));
        assert!(!official.route_changed);
        assert_eq!(official.provider_to_persist.as_deref(), Some("official"));
        assert_eq!(official.set_model_id.as_deref(), Some("grok-4.7"));
        let from_custom_row =
            composer_provider_pick(true, Some("relay-b"), Some("official"), Some("grok-4.5"));
        assert!(!from_custom_row.route_changed);
        assert_eq!(from_custom_row.set_model_id.as_deref(), Some("grok-4.5"));

        // Custom provider picks on SSH normalize to official identity.
        assert_eq!(
            session_provider_pick(true, None, Some("relay-b")),
            SameRoute
        );
        assert_eq!(
            session_provider_pick(true, Some("official"), Some("relay-b")),
            SameRoute
        );
        let custom = composer_provider_pick(true, None, Some("relay-b"), Some("deepseek-v4-flash"));
        assert!(!custom.route_changed);
        assert_eq!(custom.provider_to_persist.as_deref(), Some("official"));
        assert!(custom.set_model_id.is_none());
        let custom_id_as_model =
            composer_provider_pick(true, Some("official"), Some("relay-b"), Some("relay-b"));
        assert_eq!(
            custom_id_as_model.provider_to_persist.as_deref(),
            Some("official")
        );

        // Same cells locally still respawn and still send the model on a real switch.
        let local_switch = composer_provider_pick(
            false,
            Some("official"),
            Some("relay-b"),
            Some("deepseek-v4-flash"),
        );
        assert!(local_switch.route_changed);
        assert_eq!(local_switch.provider_to_persist.as_deref(), Some("relay-b"));
        assert!(local_switch.set_model_id.is_none());
        let local_same =
            composer_provider_pick(false, Some("official"), Some("official"), Some("grok-4.5"));
        assert!(!local_same.route_changed);
        assert_eq!(local_same.set_model_id.as_deref(), Some("grok-4.5"));

        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn app_models_toml(entries: &[(&str, &str)]) -> String {
        let models: Vec<ProviderModelEntry> = entries
            .iter()
            .map(|(id, name)| ProviderModelEntry::named(*id, *name))
            .collect();
        format_toml_field_value(
            APP_MODELS_KEY,
            &encode_app_models(&models).expect("encode app models"),
        )
    }

    fn field_of(text: &str, section_id: &str, key: &str) -> Option<String> {
        parse_model_sections(text)
            .into_iter()
            .find(|s| s.id == section_id)
            .and_then(|s| s.fields.get(key).cloned())
    }

    #[test]
    fn slug_model_id_keeps_case_and_replaces_separators() {
        assert_eq!(slug_model_id("GLM-A"), "GLM-A");
        assert_eq!(slug_model_id("glm-a"), "glm-a");
        assert_ne!(slug_model_id("GLM-A"), slug_model_id("glm-a"));
        assert_eq!(slug_model_id("z-ai/glm-5.3"), "z-ai-glm-5-3");
        assert_eq!(slug_model_id("glm/b"), "glm-b");
        assert_eq!(slug_model_id("   "), "model");
        assert_eq!(generic_model_section_id("zhipu", "glm-a"), "zhipu__glm-a");
        assert_eq!(
            generic_model_section_id("qwen38-local", "qwen3.8-27b"),
            "qwen38-local__qwen3-8-27b"
        );
        let long = "a".repeat(80);
        let slug = slug_model_id(&long);
        assert!(slug.len() <= 48, "{slug}");
        assert!(slug.starts_with("aaaa"));
    }

    struct StoredCatalogSnapshot {
        corrupt: Option<ModelCatalogRead>,
        cleared: Option<ModelCatalogRead>,
        readable: Option<ModelCatalogRead>,
        legacy: Option<ModelCatalogRead>,
        absent: Option<ModelCatalogRead>,
        raw_after: String,
    }

    #[test]
    fn stored_provider_catalog_reports_disk_state_without_editing_it() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home =
            std::env::temp_dir().join(format!("grok-app-stored-catalog-{}", uuid::Uuid::new_v4()));
        let previous_home = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &home);

        let outcome = (|| -> Result<StoredCatalogSnapshot, String> {
            ensure_app_dirs().map_err(|e| e.to_string())?;
            let path = agent_config_toml();
            let readable = encode_app_models(&[ProviderModelEntry::named("m3", "M3")])?;
            let text = format!(
                "\
[models]
default = \"readable\"

[model.corrupt]
model = \"m1\"
base_url = \"https://relay.example/v1\"
name = \"Corrupt\"
api_key = \"dummy-relay-key\"
api_backend = \"responses\"
app_provider_mode = \"grok_build_proxy\"
app_models = {}

[model.cleared]
model = \"m2\"
base_url = \"https://relay.example/v1\"
name = \"Cleared\"
api_key = \"dummy-relay-key\"
api_backend = \"responses\"
app_provider_mode = \"grok_build_proxy\"
app_models = {}

[model.readable]
model = \"m3\"
base_url = \"https://relay.example/v1\"
name = \"Readable\"
api_key = \"dummy-relay-key\"
api_backend = \"responses\"
app_provider_mode = \"grok_build_proxy\"
app_models = {}

[model.legacy]
model = \"m4\"
base_url = \"https://relay.example/v1\"
name = \"Legacy\"
api_key = \"dummy-relay-key\"
api_backend = \"responses\"
app_provider_mode = \"grok_build_proxy\"
",
                quote("{\"id\":\"m2\"}"),
                quote("[]"),
                quote(&readable),
            );
            write_text(&path, &text)?;
            let snapshot = StoredCatalogSnapshot {
                corrupt: stored_provider_model_catalog("corrupt"),
                cleared: stored_provider_model_catalog("cleared"),
                readable: stored_provider_model_catalog("readable"),
                legacy: stored_provider_model_catalog("legacy"),
                absent: stored_provider_model_catalog("absent"),
                raw_after: std::fs::read_to_string(&path).map_err(|e| e.to_string())?,
            };
            Ok(snapshot)
        })();

        match previous_home {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);

        let snapshot = outcome.expect("stored catalog reads should succeed");
        assert!(matches!(
            snapshot.corrupt,
            Some(ModelCatalogRead::Corrupt(_))
        ));
        assert_eq!(snapshot.cleared, Some(ModelCatalogRead::Stored(Vec::new())));
        assert_eq!(
            snapshot.readable,
            Some(ModelCatalogRead::Stored(vec![ProviderModelEntry::named(
                "m3", "M3"
            )]))
        );
        assert_eq!(snapshot.legacy, Some(ModelCatalogRead::LegacyChannel));
        assert_eq!(snapshot.absent, None);
        assert!(
            snapshot
                .raw_after
                .contains("app_models = \"{\\\"id\\\":\\\"m2\\\"}\""),
            "reading the state must not rewrite the config"
        );
    }

    #[test]
    fn corrupt_catalog_leaves_existing_child_sections_untouched() {
        for bad in [
            "not-json",
            r#"[{"id":"   "}]"#,
            r#"[{"id":"m1""#,
            "null",
            "{}",
            "\"m1\"",
            "1",
        ] {
            let before = format!(
                r#"[models]
default = "relay"

[model.relay]
model = "m2"
base_url = "https://relay.example/v1"
api_key = "sk-test"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = {}

[model.relay__m1]
model = "m1"
base_url = "https://relay.example/v1"
name = "m1"
api_key = "sk-test"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_parent_provider = "relay"
"#,
                quote(bad)
            );
            assert_eq!(
                sync_generic_model_sections_in_text(&before),
                before,
                "an unreadable catalog must not be replaced by a legacy guess: {bad}"
            );
        }
    }

    #[test]
    fn recovered_catalog_rows_get_routable_child_sections() {
        let raw = r#"[{"id":"m1","name":"M1"},{"id":"m2","name":"M2","contextWindow":"big"},null]"#;
        let before = format!(
            r#"[models]
default = "relay"

[model.relay]
model = "m3"
base_url = "https://new.example/v1"
api_key = "sk-new"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = {}

[model.relay__m1]
model = "m1"
base_url = "https://old.example/v1"
name = "M1 saved"
api_key = "sk-old"
api_backend = "responses"
context_window = 64000
app_note = "keep-me"
app_provider_mode = "generic"
app_parent_provider = "relay"

[model.relay__hidden]
model = "hidden"
base_url = "https://old.example/v1"
name = "Hidden"
api_key = "sk-old"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_parent_provider = "relay"
"#,
            quote(raw)
        );

        let once = sync_generic_model_sections_in_text(&before);
        let twice = sync_generic_model_sections_in_text(&once);
        assert_eq!(
            once, twice,
            "recovered-row sync must be idempotent:\n{twice}"
        );
        assert_eq!(
            field_of(&once, "relay", APP_MODELS_KEY).as_deref(),
            Some(raw),
            "the corrupt catalog text is authoritative and must stay byte-identical"
        );

        for (key, expected) in [
            ("model", "m2"),
            ("name", "M2"),
            ("base_url", "https://new.example/v1"),
            ("api_key", "sk-new"),
            ("api_backend", "chat_completions"),
            (APP_PROVIDER_MODE_KEY, PROVIDER_MODE_GENERIC),
            (APP_PARENT_PROVIDER_KEY, "relay"),
        ] {
            assert_eq!(
                field_of(&once, "relay__m2", key).as_deref(),
                Some(expected),
                "relay__m2 `{key}` must carry the recovered row and current channel route"
            );
        }
        assert_eq!(field_of(&once, "relay__m1", "model").as_deref(), Some("m1"));
        assert_eq!(
            field_of(&once, "relay__m1", "name").as_deref(),
            Some("M1 saved"),
            "an existing child keeps its display name"
        );
        assert_eq!(
            field_of(&once, "relay__m1", "context_window").as_deref(),
            Some("64000")
        );
        assert_eq!(
            field_of(&once, "relay__m1", "app_note").as_deref(),
            Some("keep-me"),
            "unknown child fields survive the sync"
        );
        assert_eq!(
            field_of(&once, "relay__m1", "base_url").as_deref(),
            Some("https://new.example/v1")
        );
        assert_eq!(
            field_of(&once, "relay__m1", "api_key").as_deref(),
            Some("sk-new")
        );
        assert_eq!(
            field_of(&once, "relay__hidden", "model").as_deref(),
            Some("hidden"),
            "children the corrupt text does not name are kept for older chats"
        );

        let listed = build_list_result(std::path::PathBuf::new(), std::path::PathBuf::new(), &once);
        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert!(relay.model_catalog_corrupt);
        let model_ids: Vec<String> = relay.models.iter().map(|m| m.id.clone()).collect();
        assert_eq!(model_ids, ["m1", "m2"]);
        let sections: Vec<GenericSectionBinding> = parse_model_sections(&once)
            .into_iter()
            .filter(|s| {
                s.fields
                    .get(APP_PARENT_PROVIDER_KEY)
                    .is_some_and(|p| p == "relay")
            })
            .filter_map(|s| {
                let model_id = s.fields.get("model")?.trim();
                if model_id.is_empty() {
                    return None;
                }
                Some(GenericSectionBinding {
                    section_id: s.id,
                    model_id: model_id.to_string(),
                })
            })
            .collect();
        for model in &relay.models {
            let section_id = resolve_session_set_model_id(Some("relay"), &model.id, &sections);
            assert_eq!(
                field_of(&once, &section_id, "model").as_deref(),
                Some(model.id.as_str()),
                "listed row `{}` must resolve to a real child section, got `{section_id}`",
                model.id
            );
        }
    }

    #[test]
    fn recovered_catalog_rows_spawn_and_set_model_with_the_same_section() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-recovered-sections-{}",
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = std::fs::create_dir_all(home.join("agent-home"));
        let raw = r#"[{"id":"m1","name":"M1"},{"id":"m2","name":"M2"},{"id":null}]"#;
        std::fs::write(
            agent_config_toml(),
            format!(
                r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://relay.example/v1"
api_key = "sk-test"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = {}
"#,
                quote(raw)
            ),
        )
        .expect("seed");

        assert_eq!(spawn_model_for_provider("relay", "m2"), "relay__m2");
        assert_eq!(session_set_model_id_for("relay", "m2"), "relay__m2");
        assert_eq!(spawn_model_for_provider("relay", "m1"), "relay__m1");
        assert_eq!(session_set_model_id_for("relay", "m1"), "relay__m1");
        let text = std::fs::read_to_string(agent_config_toml()).expect("read synced config");
        assert_eq!(field_of(&text, "relay__m2", "model").as_deref(), Some("m2"));
        assert_eq!(
            field_of(&text, "relay", APP_MODELS_KEY).as_deref(),
            Some(raw)
        );

        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Seed one `grok_build_proxy` channel; `models_atom` is the TOML literal
    /// for `app_models` so a corrupt value stays byte-exact.
    fn seed_proxy_catalog(models_atom: &str) {
        seed_proxy_catalog_with_channel_model("m1", models_atom);
    }

    fn seed_proxy_catalog_with_channel_model(channel_model: &str, models_atom: &str) {
        std::fs::write(
            agent_config_toml(),
            format!(
                r#"[models]
default = "relay"

[model.relay]
model = "{channel_model}"
base_url = "https://relay.example/v1"
api_key = "sk-test"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "grok_build_proxy"
app_models = {models_atom}
"#
            ),
        )
        .expect("seed");
    }

    fn proxy_channel() -> CustomProvider {
        list_custom_providers()
            .expect("list")
            .providers
            .into_iter()
            .find(|p| p.id == "relay")
            .expect("relay provider")
    }

    #[test]
    fn effort_resolution_uses_selected_model_ladder_and_resolves_stale_catalog_ids() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-effort-unlisted-model-{}",
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = std::fs::create_dir_all(home.join("agent-home"));

        seed_proxy_catalog(&quote(
            r#"[{"id":"m1","name":"M1","efforts":[{"id":"low","name":"Low"}]},{"id":"m2","name":"M2","efforts":[{"id":"ultra","name":"Ultra"}]}]"#,
        ));

        let selected_model = effort_model_id_for_route("relay", "m2", "relay__m1");
        assert_eq!(selected_model, "m2");
        assert!(is_valid_reasoning_effort_for_model(
            "relay",
            &selected_model,
            "ultra"
        ));
        assert_eq!(
            effective_reasoning_effort("relay", &selected_model, "ultra").as_deref(),
            Some("ultra")
        );

        let stale_model = effort_model_id_for_route("relay", "m9", "relay__m1");
        assert_eq!(stale_model, "m1");
        assert!(!is_valid_reasoning_effort_for_model(
            "relay",
            &stale_model,
            "xhigh"
        ));
        assert_eq!(
            effective_reasoning_effort("relay", &stale_model, "xhigh").as_deref(),
            Some("low")
        );

        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `--model` the native proxy spawn binds for `composer_model`.
    fn proxy_spawn_model(composer_model: &str) -> String {
        session_grok_build_proxy_spawn("relay", composer_model)
            .expect("proxy spawn binding")
            .model
    }

    #[test]
    fn proxy_catalog_that_fixes_no_rows_keeps_the_stored_session_model() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-proxy-unlisted-model-{}",
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = std::fs::create_dir_all(home.join("agent-home"));

        // Partial read: only m2 survives, but the chat is still on the old m3.
        seed_proxy_catalog(&quote(r#"[{"id":"m2","name":"M2"},{"id":null}]"#));
        let relay = proxy_channel();
        assert!(
            relay.model_catalog_corrupt,
            "fixture must exercise a corrupt catalog"
        );
        assert_eq!(
            spawn_model_for_provider("relay", "m3"),
            "m3",
            "spawn must keep the model the chat stored"
        );
        assert_eq!(
            session_set_model_id_for("relay", "m3"),
            "m3",
            "set_model must not retarget a chat whose catalog cannot vet its model"
        );
        assert_eq!(proxy_spawn_model("m3"), "m3");
        // A channel section alias is a route name, never a request model; both
        // paths take the recovered row instead.
        assert_eq!(session_set_model_id_for("relay", "relay"), "m2");
        assert_eq!(proxy_spawn_model("relay"), "m2");
        assert_eq!(session_set_model_id_for("relay", ""), "m2");
        assert_eq!(proxy_spawn_model(""), "m2");

        // Explicit clear: no rows, and the chat is still on the old m2.
        seed_proxy_catalog("\"[]\"");
        let relay = proxy_channel();
        assert!(!relay.model_catalog_corrupt);
        assert!(relay.models.is_empty(), "fixture must clear the catalog");
        assert_eq!(spawn_model_for_provider("relay", "m2"), "m2");
        assert_eq!(session_set_model_id_for("relay", "m2"), "m2");
        assert_eq!(proxy_spawn_model("m2"), "m2");
        assert_eq!(session_set_model_id_for("relay", "relay"), "m1");
        assert_eq!(proxy_spawn_model("relay"), "m1");
        assert_eq!(session_set_model_id_for("relay", ""), "m1");
        assert_eq!(proxy_spawn_model(""), "m1");

        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn proxy_readable_catalog_still_rejects_an_unlisted_model() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-proxy-listed-model-{}",
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = std::fs::create_dir_all(home.join("agent-home"));

        seed_proxy_catalog(&quote(
            r#"[{"id":"m1","name":"M1"},{"id":"m2","name":"M2"}]"#,
        ));
        let relay = proxy_channel();
        assert!(!relay.model_catalog_corrupt);
        assert_eq!(relay.models.len(), 2);

        // Listed rows are still sent verbatim.
        assert_eq!(session_set_model_id_for("relay", "m2"), "m2");
        assert_eq!(spawn_model_for_provider("relay", "m2"), "m2");
        assert_eq!(proxy_spawn_model("m2"), "m2");
        // An id the readable catalog does not list never reaches the upstream;
        // both paths take the same active row as the native proxy spawn.
        assert_eq!(
            session_set_model_id_for("relay", "m9"),
            "m1",
            "a readable catalog must not pass an unlisted id through"
        );
        assert_eq!(spawn_model_for_provider("relay", "m9"), "m1");
        assert_eq!(proxy_spawn_model("m9"), "m1");
        assert_eq!(session_set_model_id_for("relay", "relay"), "m1");
        assert_eq!(proxy_spawn_model("relay"), "m1");
        assert_eq!(session_set_model_id_for("relay", ""), "m1");
        assert_eq!(proxy_spawn_model(""), "m1");

        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn proxy_readable_catalog_without_the_channel_model_uses_the_first_row() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-proxy-channel-absent-{}",
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = std::fs::create_dir_all(home.join("agent-home"));

        // Legacy channel model is no longer in the readable catalog.
        seed_proxy_catalog_with_channel_model(
            "legacy-channel",
            &quote(r#"[{"id":"m2","name":"M2"},{"id":"m1","name":"M1"}]"#),
        );
        let relay = proxy_channel();
        assert!(!relay.model_catalog_corrupt);
        assert_eq!(relay.model, "legacy-channel");

        for requested in ["", "legacy-channel", "m9"] {
            assert_eq!(
                session_set_model_id_for("relay", requested),
                "m2",
                "set_model must take the first row for `{requested}`"
            );
            assert_eq!(
                proxy_spawn_model(requested),
                "m2",
                "the native proxy spawn must take the first row for `{requested}`"
            );
        }
        assert_eq!(session_set_model_id_for("relay", "m1"), "m1");
        assert_eq!(proxy_spawn_model("m1"), "m1");

        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn corrupt_catalog_without_recovered_rows_creates_no_child_sections() {
        for bad in [r#"[{"id":""},{"name":"no-id"}]"#, r#"[{"id":null}]"#, "[]"] {
            let before = format!(
                r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://relay.example/v1"
api_key = "sk-test"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_models = {}
"#,
                quote(bad)
            );
            let once = sync_generic_model_sections_in_text(&before);
            assert_eq!(
                once, before,
                "a catalog with no recovered row must not guess a child: {bad}"
            );
        }
    }

    #[test]
    fn corrupt_catalog_refreshes_channel_route_fields_on_existing_children() {
        let before = r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://new.example/v1"
app_upstream_base_url = "https://new-upstream.example/v1"
api_key = "sk-test-new"
name = "Relay"
api_backend = "responses"
app_provider_mode = "generic"
app_models = "not-json"
extra_headers = { "X-New" = "2" }
supports_reasoning_effort = true

[model.relay__m1]
model = "m1"
base_url = "https://old.example/v1"
app_upstream_base_url = "https://old-upstream.example/v1"
name = "Old One"
api_key = "sk-test-old"
api_backend = "chat_completions"
context_window = 64000
extra_headers = { "X-Old" = "1" }
supports_reasoning_effort = false
app_provider_mode = "generic"
app_parent_provider = "relay"
app_note = "keep-me"

[model.relay__m2]
model = "m2"
base_url = "https://old.example/v1"
name = "Old Two"
api_key = "sk-test-old"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_parent_provider = "relay"
"#;
        let once = sync_generic_model_sections_in_text(before);
        let twice = sync_generic_model_sections_in_text(&once);
        assert_eq!(once, twice, "route refresh must be idempotent:\n{twice}");

        let ids: Vec<String> = parse_model_sections(&once)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(
            ids,
            vec!["relay", "relay__m1", "relay__m2"],
            "channels without a readable catalog must not create or drop children"
        );
        for id in ["relay__m1", "relay__m2"] {
            assert_eq!(
                field_of(&once, id, "base_url").as_deref(),
                Some("https://new.example/v1")
            );
            assert_eq!(
                field_of(
                    &once,
                    id,
                    crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY
                )
                .as_deref(),
                Some("https://new-upstream.example/v1")
            );
            assert_eq!(
                field_of(&once, id, "api_key").as_deref(),
                Some("sk-test-new")
            );
            assert_eq!(
                field_of(&once, id, "api_backend").as_deref(),
                Some("responses")
            );
            assert_eq!(
                field_of(&once, id, EXTRA_HEADERS_KEY).as_deref(),
                Some(r#"{ "X-New" = "2" }"#)
            );
            assert_eq!(
                field_of(&once, id, SUPPORTS_REASONING_EFFORT_KEY).as_deref(),
                Some("true")
            );
            assert_eq!(
                field_of(&once, id, APP_PROVIDER_MODE_KEY).as_deref(),
                Some(PROVIDER_MODE_GENERIC)
            );
            assert_eq!(
                field_of(&once, id, APP_PARENT_PROVIDER_KEY).as_deref(),
                Some("relay")
            );
        }
        assert_eq!(field_of(&once, "relay__m1", "model").as_deref(), Some("m1"));
        assert_eq!(
            field_of(&once, "relay__m1", "name").as_deref(),
            Some("Old One")
        );
        assert_eq!(
            field_of(&once, "relay__m1", "context_window").as_deref(),
            Some("64000")
        );
        assert_eq!(
            field_of(&once, "relay__m1", "app_note").as_deref(),
            Some("keep-me")
        );
        assert_eq!(field_of(&once, "relay__m2", "model").as_deref(), Some("m2"));
        assert_eq!(
            field_of(&once, "relay__m2", "name").as_deref(),
            Some("Old Two")
        );
        assert!(field_of(&once, "relay__m2", "context_window").is_none());
        assert_eq!(get_models_default(&once).as_deref(), Some("relay"));
    }

    #[test]
    fn explicit_empty_catalog_refreshes_children_and_drops_removed_channel_fields() {
        let before = r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://new.example/v1"
api_key = "sk-test-new"
name = "Relay"
app_provider_mode = "generic"
app_models = "[]"

[model.relay__m1]
model = "m1"
base_url = "https://old.example/v1"
name = "Old One"
api_key = "sk-test-old"
api_backend = "responses"
context_window = 64000
app_upstream_base_url = "https://old-upstream.example/v1"
extra_headers = { "X-Old" = "1" }
supports_reasoning_effort = true
app_provider_mode = "generic"
app_parent_provider = "relay"

[model.relay__m2]
model = "m2"
base_url = "https://old.example/v1"
name = "Old Two"
api_key = "sk-test-old"
api_backend = "responses"
app_provider_mode = "generic"
app_parent_provider = "relay"
"#;
        let once = sync_generic_model_sections_in_text(before);
        let twice = sync_generic_model_sections_in_text(&once);
        assert_eq!(once, twice, "route refresh must be idempotent:\n{twice}");

        let ids: Vec<String> = parse_model_sections(&once)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["relay", "relay__m1", "relay__m2"]);
        for id in ["relay__m1", "relay__m2"] {
            assert_eq!(
                field_of(&once, id, "base_url").as_deref(),
                Some("https://new.example/v1")
            );
            assert_eq!(
                field_of(&once, id, "api_key").as_deref(),
                Some("sk-test-new")
            );
            assert_eq!(
                field_of(&once, id, "api_backend").as_deref(),
                Some("chat_completions"),
                "a missing channel backend falls back to the default"
            );
            assert!(
                field_of(
                    &once,
                    id,
                    crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY
                )
                .is_none(),
                "a channel-level upstream removed from the parent must not linger on the child"
            );
            assert!(
                field_of(&once, id, EXTRA_HEADERS_KEY).is_none(),
                "a channel-level field removed from the parent must not linger on the child"
            );
            assert!(field_of(&once, id, SUPPORTS_REASONING_EFFORT_KEY).is_none());
        }
        assert_eq!(field_of(&once, "relay__m1", "model").as_deref(), Some("m1"));
        assert_eq!(
            field_of(&once, "relay__m1", "name").as_deref(),
            Some("Old One")
        );
        assert_eq!(
            field_of(&once, "relay__m1", "context_window").as_deref(),
            Some("64000")
        );
        assert_eq!(
            field_of(&once, "relay__m2", "name").as_deref(),
            Some("Old Two")
        );

        let listed = build_list_result(std::path::PathBuf::new(), std::path::PathBuf::new(), &once);
        let relay = listed
            .providers
            .iter()
            .find(|p| p.id == "relay")
            .expect("relay provider");
        assert!(
            relay.models.is_empty(),
            "app_models = [] stays an explicit clear"
        );
    }

    #[test]
    fn sync_generic_model_sections_is_idempotent_and_keeps_hand_written_text() {
        let app_models =
            app_models_toml(&[("glm-a", "GLM A"), ("glm/b", "GLM B"), ("glm-b", "GLM B2")]);
        let before = format!(
            r#"# user comment

[models]
default = "zhipu"

[model.hand]
model = "keep-me"
base_url = "https://hand.example/v1"
api_key = "sk-hand"
name = "Hand"

[model.zhipu]
model = "glm-a"
base_url = "https://open.bigmodel.cn/api/paas/v4"
api_key = "sk-z"
name = "智谱"
api_backend = "chat_completions"
context_window = 128000
app_provider_mode = "generic"
app_models = {app_models}

[model.zhipu__gone]
model = "gone"
base_url = "https://open.bigmodel.cn/api/paas/v4"
name = "Gone"
api_key = "sk-z"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_parent_provider = "zhipu"
"#
        );
        let once = sync_generic_model_sections_in_text(&before);
        let twice = sync_generic_model_sections_in_text(&once);
        assert_eq!(once, twice, "migration must be idempotent:\n{twice}");
        assert!(once.contains("# user comment"));
        assert!(once.find("[model.hand]").unwrap() < once.find("[model.zhipu]").unwrap());
        assert_eq!(get_models_default(&once).as_deref(), Some("zhipu"));
        assert_eq!(field_of(&once, "hand", "model").as_deref(), Some("keep-me"));
        assert_eq!(field_of(&once, "zhipu", "model").as_deref(), Some("glm-a"));
        assert!(field_of(&once, "zhipu", APP_PARENT_PROVIDER_KEY).is_none());
        assert!(field_of(&once, "zhipu", APP_MODELS_KEY).is_some());
        assert!(parse_model_sections(&once)
            .iter()
            .all(|s| s.id != "zhipu__gone"));
        assert_eq!(
            field_of(&once, "zhipu__glm-a", "model").as_deref(),
            Some("glm-a")
        );
        assert_eq!(
            field_of(&once, "zhipu__glm-a", APP_PARENT_PROVIDER_KEY).as_deref(),
            Some("zhipu")
        );
        assert_eq!(
            field_of(&once, "zhipu__glm-b", "model").as_deref(),
            Some("glm/b")
        );
        assert_eq!(
            field_of(&once, "zhipu__glm-b-2", "model").as_deref(),
            Some("glm-b")
        );
        assert_eq!(
            field_of(&once, "hand__keep-me", APP_PARENT_PROVIDER_KEY).as_deref(),
            Some("hand")
        );
        let listed = build_list_result(std::path::PathBuf::new(), std::path::PathBuf::new(), &once);
        assert_eq!(
            listed
                .providers
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["hand", "zhipu"]
        );
    }

    #[test]
    fn sync_generic_model_sections_does_not_clobber_a_foreign_section() {
        let app_models = app_models_toml(&[("glm-b", "B")]);
        let before = format!(
            r#"# leave this section alone
[model.zhipu__glm-b]
model = "do-not-touch"
name = "foreign"

[model.zhipu]
model = "glm-b"
base_url = "https://z.example/v1"
api_key = "sk"
name = "智谱"
api_backend = "chat_completions"
app_models = {app_models}
"#
        );
        let once = sync_generic_model_sections_in_text(&before);
        let twice = sync_generic_model_sections_in_text(&once);
        assert_eq!(once, twice);
        assert_eq!(
            field_of(&once, "zhipu__glm-b", "model").as_deref(),
            Some("do-not-touch")
        );
        assert!(field_of(&once, "zhipu__glm-b", APP_PARENT_PROVIDER_KEY).is_none());
        assert_eq!(
            field_of(&once, "zhipu__glm-b-2", "model").as_deref(),
            Some("glm-b")
        );
        assert_eq!(
            field_of(&once, "zhipu__glm-b-2", APP_PARENT_PROVIDER_KEY).as_deref(),
            Some("zhipu")
        );
        assert!(once.contains("# leave this section alone"));
    }

    #[test]
    fn sync_generic_model_sections_leaves_proxy_channels_alone() {
        let app_models = app_models_toml(&[("grok-4.6", "Grok 4.6"), ("grok-4.5", "Grok 4.5")]);
        let before = format!(
            r#"[model.proxy]
model = "grok-4.6"
base_url = "https://relay.example/v1"
api_key = "sk"
name = "Proxy"
api_backend = "responses"
app_provider_mode = "grok_build_proxy"
app_models = {app_models}

[model.proxy__old]
model = "old"
base_url = "https://relay.example/v1"
name = "Old"
app_parent_provider = "proxy"
"#
        );
        let once = sync_generic_model_sections_in_text(&before);
        let twice = sync_generic_model_sections_in_text(&once);
        assert_eq!(once, twice);
        assert!(!once.contains(APP_PARENT_PROVIDER_KEY));
        assert!(parse_model_sections(&once)
            .iter()
            .all(|s| s.id != "proxy__old"));
        assert_eq!(
            field_of(&once, "proxy", "model").as_deref(),
            Some("grok-4.6")
        );
    }

    #[test]
    fn generic_model_sections_round_trip_on_agent_home() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "grok-app-generic-sections-{}",
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = std::fs::create_dir_all(home.join("agent-home"));
        let prelude = "# user comment\n\n[models]\ndefault = \"zhipu\"\n\n[model.hand]\nmodel = \"keep-me\"\nbase_url = \"https://hand.example/v1\"\napi_key = \"sk-hand\"\nname = \"Hand\"\n";
        std::fs::write(agent_config_toml(), prelude).expect("seed");

        let listed = upsert_custom_provider(UpsertProviderInput {
            id: "zhipu".into(),
            model: "glm-a".into(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            name: Some("智谱".into()),
            api_key: Some("sk-z".into()),
            api_backend: Some("chat_completions".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(true),
            models: Some(vec![
                ProviderModelEntry::named("glm-a", "GLM A"),
                ProviderModelEntry::named("glm/b", "GLM B"),
            ]),
            efforts: None,
            context_window: None,
            base_url_full_path: Some(true),
            append_prompt: None,
            supports_vision: None,
            extra_headers: None,
        })
        .expect("upsert");
        assert!(listed.providers.iter().any(|p| p.id == "zhipu"));
        assert!(listed.providers.iter().all(|p| p.id != "zhipu__glm-b"));

        let after = std::fs::read_to_string(agent_config_toml()).expect("config");
        assert!(after.contains("# user comment"));
        assert_eq!(
            field_of(&after, "hand", "model").as_deref(),
            Some("keep-me")
        );
        assert_eq!(
            field_of(&after, "zhipu__glm-a", "model").as_deref(),
            Some("glm-a")
        );
        assert_eq!(
            field_of(&after, "zhipu__glm-b", "model").as_deref(),
            Some("glm/b")
        );
        assert_eq!(session_set_model_id_for("zhipu", "glm/b"), "zhipu__glm-b");
        assert_eq!(
            session_set_model_id_for("zhipu", "zhipu__glm-b"),
            "zhipu__glm-b"
        );
        assert_eq!(
            spawn_model_for_provider("zhipu", "zhipu__glm-b"),
            "zhipu__glm-b"
        );
        assert_eq!(
            session_set_model_id_for("zhipu", "zhipu__glm-a"),
            "zhipu__glm-a"
        );
        assert_eq!(
            session_set_model_id_for("zhipu", "not-a-model"),
            "zhipu__glm-a"
        );
        assert_eq!(session_set_model_id_for("zhipu", ""), "zhipu__glm-a");

        let again = list_custom_providers().expect("list");
        let reread = std::fs::read_to_string(agent_config_toml()).expect("config");
        assert_eq!(after, reread, "second list must not rewrite agent-home");
        assert_eq!(again.providers.len(), listed.providers.len());

        upsert_custom_provider(UpsertProviderInput {
            id: "zhipu".into(),
            model: "glm-a".into(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            name: Some("智谱".into()),
            api_key: None,
            api_backend: Some("chat_completions".into()),
            provider_mode: Some(PROVIDER_MODE_GENERIC.into()),
            create_only: Some(false),
            models: Some(vec![ProviderModelEntry::named("glm-a", "GLM A")]),
            efforts: None,
            context_window: None,
            base_url_full_path: Some(true),
            append_prompt: None,
            supports_vision: None,
            extra_headers: None,
        })
        .expect("drop glm/b");
        let dropped = std::fs::read_to_string(agent_config_toml()).expect("config");
        assert!(parse_model_sections(&dropped)
            .iter()
            .all(|s| s.id != "zhipu__glm-b"));
        assert_eq!(
            field_of(&dropped, "zhipu__glm-a", "model").as_deref(),
            Some("glm-a")
        );
        assert_eq!(session_set_model_id_for("zhipu", "glm/b"), "zhipu__glm-a");

        remove_custom_provider("zhipu").expect("remove");
        let removed = std::fs::read_to_string(agent_config_toml()).expect("config");
        assert!(parse_model_sections(&removed)
            .iter()
            .all(|s| s.id != "zhipu"));
        assert!(parse_model_sections(&removed).iter().all(|s| s
            .fields
            .get(APP_PARENT_PROVIDER_KEY)
            .map(String::as_str)
            != Some("zhipu")));
        assert_eq!(
            field_of(&removed, "hand", "model").as_deref(),
            Some("keep-me")
        );
        assert_eq!(
            get_models_default(&removed).as_deref(),
            Some(OFFICIAL_DEFAULT_MODEL),
            "removing the provider the legacy default points at must reset it to `grok`"
        );

        upsert_custom_provider(UpsertProviderInput {
            id: "beef-relay".into(),
            model: "grok-4.6".into(),
            base_url: "https://relay.example/v1".into(),
            name: Some("Beef".into()),
            api_key: Some("sk".into()),
            api_backend: Some("responses".into()),
            provider_mode: Some(PROVIDER_MODE_GROK_BUILD_PROXY.into()),
            create_only: Some(true),
            models: Some(vec![
                ProviderModelEntry::named("grok-4.6", "Grok 4.6"),
                ProviderModelEntry::named("grok-4.5", "Grok 4.5"),
            ]),
            efforts: None,
            context_window: None,
            base_url_full_path: None,
            append_prompt: None,
            supports_vision: None,
            extra_headers: None,
        })
        .expect("proxy");
        let proxy = std::fs::read_to_string(agent_config_toml()).expect("config");
        assert!(!proxy.contains("app_parent_provider = \"beef-relay\""));
        assert_eq!(
            session_set_model_id_for("beef-relay", "grok-4.5"),
            "grok-4.5"
        );

        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    fn with_seeded_agent_home<T>(label: &str, config: &str, body: impl FnOnce() -> T) -> T {
        let _lock = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("grok-app-{label}-{}", uuid::Uuid::new_v4()));
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &home);
        let _ = std::fs::create_dir_all(home.join("agent-home"));
        std::fs::write(agent_config_toml(), config).expect("seed config");
        let outcome = body();
        match previous {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
        outcome
    }

    fn sanitized_relay_config(port: u16) -> String {
        format!(
            r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "http://127.0.0.1:{port}/r/relay/v1"
app_upstream_base_url = "https://opencode.ai/zen/go/v1"
api_key = "sk-test"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "generic"

[model.relay__m1]
model = "m1"
base_url = "http://127.0.0.1:{port}/r/relay/v1"
app_upstream_base_url = "https://opencode.ai/zen/go/v1"
name = "M1"
api_key = "sk-test"
api_backend = "chat_completions"
app_provider_mode = "generic"
app_parent_provider = "relay"
"#
        )
    }

    #[test]
    fn removing_a_provider_leaves_a_foreign_legacy_default_alone() {
        let config = "[models]\ndefault = \"keeper\"\n\n[model.keeper]\nmodel = \"keep-me\"\nbase_url = \"https://keep.example/v1\"\napi_key = \"sk-keep\"\n\n[model.doomed]\nmodel = \"doomed-model\"\nbase_url = \"https://doomed.example/v1\"\napi_key = \"sk-doomed\"\n";
        with_seeded_agent_home("legacy-default-foreign", config, || {
            remove_custom_provider("doomed").expect("remove");

            let after = std::fs::read_to_string(agent_config_toml()).expect("config");
            assert!(parse_model_sections(&after)
                .iter()
                .all(|s| s.id != "doomed"));
            assert_eq!(
                get_models_default(&after).as_deref(),
                Some("keeper"),
                "a default naming another provider must stay as stored"
            );
        });
    }

    fn relay_upsert(base_url: &str, provider_mode: &str) -> UpsertProviderInput {
        UpsertProviderInput {
            id: "relay".into(),
            model: "m1".into(),
            base_url: base_url.into(),
            name: Some("Relay".into()),
            api_key: None,
            api_backend: Some("chat_completions".into()),
            provider_mode: Some(provider_mode.into()),
            create_only: Some(false),
            models: None,
            efforts: None,
            context_window: None,
            base_url_full_path: None,
            append_prompt: None,
            supports_vision: None,
            extra_headers: None,
        }
    }

    #[test]
    fn switching_a_sanitized_relay_to_a_direct_endpoint_drops_the_stale_upstream() {
        let config = sanitized_relay_config(45_001);
        with_seeded_agent_home("stale-upstream-switch", &config, || {
            upsert_custom_provider(relay_upsert(
                "https://api.openai.example/v1",
                PROVIDER_MODE_GENERIC,
            ))
            .expect("upsert");

            let after = std::fs::read_to_string(agent_config_toml()).expect("config");
            for id in ["relay", "relay__m1"] {
                assert_eq!(
                    field_of(&after, id, "base_url").as_deref(),
                    Some("https://api.openai.example/v1"),
                    "`{id}` must point at the new endpoint:\n{after}"
                );
                assert!(
                    field_of(
                        &after,
                        id,
                        crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY
                    )
                    .is_none(),
                    "`{id}` must not keep the old sanitizer upstream:\n{after}"
                );
            }
        });
    }

    #[test]
    fn re_saving_the_local_proxy_keeps_the_real_upstream() {
        let config = sanitized_relay_config(45_001);
        with_seeded_agent_home("local-proxy-resave", &config, || {
            upsert_custom_provider(relay_upsert(
                "http://127.0.0.1:45002/r/relay/v1",
                PROVIDER_MODE_GENERIC,
            ))
            .expect("upsert");

            let after = std::fs::read_to_string(agent_config_toml()).expect("config");
            for id in ["relay", "relay__m1"] {
                assert_eq!(
                    field_of(&after, id, "base_url").as_deref(),
                    Some("http://127.0.0.1:45002/r/relay/v1")
                );
                assert_eq!(
                    field_of(
                        &after,
                        id,
                        crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY
                    )
                    .as_deref(),
                    Some("https://opencode.ai/zen/go/v1"),
                    "`{id}` must keep the real upstream when only the proxy port moved:\n{after}"
                );
            }
        });
    }

    #[test]
    fn a_local_proxy_saved_without_a_prior_upstream_stores_no_upstream() {
        let config = r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://api.openai.example/v1"
api_key = "sk-test"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "generic"
"#;
        with_seeded_agent_home("local-proxy-no-upstream", config, || {
            upsert_custom_provider(relay_upsert(
                "http://127.0.0.1:45001/r/relay/v1",
                PROVIDER_MODE_GENERIC,
            ))
            .expect("upsert");

            let after = std::fs::read_to_string(agent_config_toml()).expect("config");
            assert_eq!(
                field_of(&after, "relay", "base_url").as_deref(),
                Some("http://127.0.0.1:45001/r/relay/v1")
            );
            assert!(
                field_of(
                    &after,
                    "relay",
                    crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY
                )
                .is_none(),
                "a loopback base must not be recorded as its own upstream:\n{after}"
            );
        });
    }

    #[test]
    fn native_proxy_upsert_drops_a_sanitizer_upstream_left_on_the_section() {
        let config = sanitized_relay_config(45_001);
        with_seeded_agent_home("native-proxy-upstream", &config, || {
            upsert_custom_provider(relay_upsert(
                "https://relay.example/v1",
                PROVIDER_MODE_GROK_BUILD_PROXY,
            ))
            .expect("upsert");

            let after = std::fs::read_to_string(agent_config_toml()).expect("config");
            assert_eq!(
                field_of(&after, "relay", "base_url").as_deref(),
                Some("https://relay.example/v1")
            );
            assert!(
                !after.contains(crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY),
                "no section may keep the sanitizer upstream:\n{after}"
            );
        });
    }

    #[test]
    fn sanitize_proxy_repair_drops_an_upstream_left_beside_a_direct_endpoint() {
        let config = r#"[models]
default = "relay"

[model.relay]
model = "m1"
base_url = "https://api.openai.example/v1"
app_upstream_base_url = "https://old-upstream.example/v1"
api_key = "sk-test"
name = "Relay"
api_backend = "chat_completions"
app_provider_mode = "generic"
"#;
        with_seeded_agent_home("repair-stale-upstream", config, || {
            let repaired =
                crate::relay_stream_proxy::repair_sanitize_proxy_bases().expect("repair");
            assert!(repaired, "the stale upstream must be a repair");

            let after = std::fs::read_to_string(agent_config_toml()).expect("config");
            assert_eq!(
                field_of(&after, "relay", "base_url").as_deref(),
                Some("https://api.openai.example/v1")
            );
            assert!(
                field_of(
                    &after,
                    "relay",
                    crate::relay_stream_proxy::APP_UPSTREAM_BASE_URL_KEY
                )
                .is_none(),
                "repair must drop the upstream beside a direct endpoint:\n{after}"
            );
        });
    }
}
