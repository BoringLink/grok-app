//! Host-side vision fallback and text-only prompt guard for custom main routes.
//!
//! Official Grok is natively multimodal; a custom relay may be text-only
//! (DeepSeek, …), so the Host strips `@image` attachments and describes the
//! pixels itself before the main turn. The `[models]` aux slot keys are read
//! only to resolve `image_description`: this module never mutates
//! `[models].default`, never activates provider routes, never rewrites auth.json.

use crate::agent_home_config::get_table_string;
use crate::paths::agent_config_toml;
use crate::providers::{is_official_catalog_model, list_custom_providers};

/// Allowlisted CLI keys under `[models]` for auxiliary tasks.
const AUX_KEYS: &[&str] = &[
    "image_description",
    "web_search",
    "session_summary",
    "prompt_suggestion",
];

/// Sentinel / empty → CLI uses its built-in default (typically main / grok-4.5).
const AUTO: &str = "auto";

/// Official Grok catalog base (from CLI `models_cache.json` / grok-4.5 info).
/// Without this, pointing `image_description = "grok-4.5"` while
/// `[models].default` is a custom relay makes the CLI hit the **relay** with
/// model id `grok-4.5` → 400 (e.g. DeepSeek rejects unknown model names).
pub const OFFICIAL_GROK_BASE_URL: &str = "https://cli-chat-proxy.grok.com/v1";
/// Official catalog uses the Responses API.
pub const OFFICIAL_GROK_API_BACKEND: &str = "responses";

/// Normalize UI / API values: trim; treat empty, `auto`, `default` as clear.
fn normalize_slot_value(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    if lower == AUTO || lower == "default" || lower == "main" {
        return None;
    }
    Some(t.to_string())
}

/// Read a single allowlisted key from `[models]` (pure).
fn get_slot(text: &str, key: &str) -> String {
    if !AUX_KEYS.contains(&key) {
        return String::new();
    }
    get_table_string(text, "models", key).unwrap_or_default()
}

fn read_config_text() -> String {
    let path = agent_config_toml();
    std::fs::read_to_string(&path).unwrap_or_default()
}

/// Image file extensions that Grok Build may attach as multimodal `image_url`.
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "avif",
];

fn path_is_image(path: &str) -> bool {
    let p = path.trim();
    let ext = p
        .rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    IMAGE_EXTS.iter().any(|e| *e == ext)
}

/// Known multimodal / vision-capable markers (provider id, name, or model id).
fn looks_vision_model(id_or_name: &str) -> bool {
    let s = id_or_name.trim().to_ascii_lowercase();
    if s.is_empty() {
        return false;
    }
    s.contains("grok")
        || s.contains("gpt-4o")
        || s.contains("gpt-4.1")
        || s.contains("claude")
        || s.contains("gemini")
        || s.contains("-vl")
        || s.contains("vision")
        || s.contains("pixtral")
        || s.contains("qwen-vl")
}

/// Custom channel is vision-capable when the **active** model opted in, or the
/// id / name / active model looks multimodal. Unknown relays stay text-only.
/// Per-model `supports_vision` wins over the channel flag so mixed catalogs
/// (DeepSeek flash + vision-exp) do not treat every row as vision. An explicit
/// `Some(false)` on the exact active row also wins over id / name heuristics,
/// so a `grok-vision-*` id can still be pinned to text. A catalog that does not
/// contain the active row (partial recovery from corrupt text) must not lend
/// that row a sibling's capability.
pub fn custom_provider_is_text_only(p: &crate::providers::CustomProvider) -> bool {
    let active = p.models.iter().find(|m| m.id.trim() == p.model.trim());
    if let Some(m) = active {
        match m.supports_vision {
            Some(true) => return false,
            Some(false) => return true,
            None => {
                if p.supports_vision || looks_vision_model(&m.id) || looks_vision_model(&m.name) {
                    return false;
                }
            }
        }
    }
    if p.supports_vision {
        return false;
    }
    if looks_vision_model(&p.id) || looks_vision_model(&p.model) || looks_vision_model(&p.name) {
        return false;
    }
    true
}

/// Collect absolute `@/path` / `@C:\path` image refs from a prompt (any line).
fn extract_image_at_paths(prompt: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in prompt.lines() {
        let trimmed = line.trim();
        if let Some(path) = parse_at_abs_path(trimmed) {
            if path_is_image(path) && !out.iter().any(|p| p == path) {
                out.push(path.to_string());
            }
        }
        // Mid-line tokens
        let (_, found) = strip_inline_image_at_refs(line);
        for p in found {
            if !out.iter().any(|x| x == &p) {
                out.push(p);
            }
        }
    }
    out
}

fn parse_at_abs_path(trimmed: &str) -> Option<&str> {
    let path = trimmed.strip_prefix('@')?;
    if path.starts_with('/') {
        return Some(path);
    }
    // Windows `C:\` or `C:/`
    let b = path.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    {
        return Some(path);
    }
    None
}

/// Strip image `@path` refs (sole-line **and** mid-line). Returns (new_prompt, stripped_paths).
pub fn strip_image_at_paths(prompt: &str) -> (String, Vec<String>) {
    let mut stripped: Vec<String> = Vec::new();
    let mut out_lines: Vec<String> = Vec::new();

    for line in prompt.lines() {
        let trimmed = line.trim();
        // Sole-line @path (common composer form)
        if let Some(path) = parse_at_abs_path(trimmed) {
            if path_is_image(path) {
                if !stripped.iter().any(|p| p == path) {
                    stripped.push(path.to_string());
                }
                continue;
            }
        }
        // Mid-line: scan for @/…image.ext tokens without the regex crate.
        let (rest, found) = strip_inline_image_at_refs(line);
        for p in found {
            if !stripped.iter().any(|x| x == &p) {
                stripped.push(p);
            }
        }
        let rest = rest.trim().to_string();
        if rest.is_empty() {
            continue;
        }
        out_lines.push(rest);
    }
    while out_lines
        .last()
        .map(|l| l.trim().is_empty())
        .unwrap_or(false)
    {
        out_lines.pop();
    }
    (out_lines.join("\n"), stripped)
}

/// Remove mid-line `@/abs/img.png` (or Windows) tokens; collect paths.
///
/// **Must** walk by `char` (not raw bytes): `bytes[i] as char` corrupts UTF-8
/// Chinese captions and broke X-intent detection after strip.
fn strip_inline_image_at_refs(line: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(line.len());
    let mut found = Vec::new();
    let mut chars = line.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '@' {
            let rest = &line[i + c.len_utf8()..];
            // Absolute unix or Windows path
            let is_abs = rest.starts_with('/')
                || (rest.len() >= 3
                    && rest.as_bytes()[0].is_ascii_alphabetic()
                    && rest.as_bytes()[1] == b':'
                    && (rest.as_bytes()[2] == b'\\' || rest.as_bytes()[2] == b'/'));
            if is_abs {
                let end = rest
                    .find(|ch: char| ch.is_whitespace() || ch == '@')
                    .unwrap_or(rest.len());
                let path = &rest[..end];
                if path_is_image(path) {
                    found.push(path.to_string());
                    // Skip the path chars we just consumed (rest is a slice of line).
                    let skip_to = i + c.len_utf8() + end;
                    while chars.peek().map(|(j, _)| *j < skip_to).unwrap_or(false) {
                        chars.next();
                    }
                    continue;
                }
            }
        }
        out.push(c);
    }
    // Collapse double spaces left by removals
    let mut cleaned = out;
    while cleaned.contains("  ") {
        cleaned = cleaned.replace("  ", " ");
    }
    (cleaned, found)
}

struct VisionEndpoint {
    base_url: String,
    model: String,
    api_key: String,
    api_backend: String,
}

fn resolve_vision_endpoint(
    config: &str,
    list: &crate::providers::ProvidersListResult,
) -> Option<VisionEndpoint> {
    let slot = get_slot(config, "image_description");
    let target = normalize_slot_value(&slot)?;
    if is_official_catalog_model(&target) {
        let table = format!("model.{target}");
        let base = get_table_string(config, &table, "base_url")
            .unwrap_or_else(|| OFFICIAL_GROK_BASE_URL.into());
        let key = get_table_string(config, &table, "api_key").unwrap_or_default();
        if key.is_empty() {
            return None;
        }
        let backend = get_table_string(config, &table, "api_backend")
            .unwrap_or_else(|| OFFICIAL_GROK_API_BACKEND.into());
        return Some(VisionEndpoint {
            base_url: base,
            model: target,
            api_key: key,
            api_backend: backend,
        });
    }
    let p = list.providers.iter().find(|p| p.id == target)?;
    if p.base_url.trim().is_empty() {
        return None;
    }
    // Prefer key from config.toml (not exposed on list)
    let key = get_table_string(config, &format!("model.{}", p.id), "api_key").unwrap_or_default();
    if key.is_empty() {
        return None;
    }
    let model = if p.model.trim().is_empty() {
        p.id.clone()
    } else {
        p.model.clone()
    };
    let backend = get_table_string(config, &format!("model.{}", p.id), "api_backend")
        .unwrap_or_else(|| p.api_backend.clone());
    Some(VisionEndpoint {
        base_url: p.base_url.clone(),
        model,
        api_key: key,
        api_backend: backend,
    })
}

fn mime_for_path(path: &str) -> &'static str {
    match path_ext(path).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

fn path_ext(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

const MAX_VISION_IMAGE_BYTES: u64 = 6 * 1024 * 1024;
const MAX_VISION_IMAGES: usize = 3;

/// Describe one local image via OpenAI-compatible chat_completions or responses.
async fn describe_image_http(ep: &VisionEndpoint, path: &str) -> Result<String, String> {
    use base64::Engine;
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {path}: {e}"))?;
    if meta.len() > MAX_VISION_IMAGE_BYTES {
        return Err(format!(
            "image too large ({} bytes > {MAX_VISION_IMAGE_BYTES})",
            meta.len()
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = mime_for_path(path);
    let data_url = format!("data:{mime};base64,{b64}");
    let base = ep.base_url.trim().trim_end_matches('/');
    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let prompt_text = "Describe this image thoroughly for a coding agent: UI text, layout, errors, code, diagrams, colors, and any actionable detail. Use the same language as any visible UI text when possible. Be concrete; do not refuse.";

    let (url, body) = if ep.api_backend == "responses" {
        (
            format!("{base}/responses"),
            serde_json::json!({
                "model": ep.model,
                "input": [{
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt_text},
                        {"type": "input_image", "image_url": data_url}
                    ]
                }]
            }),
        )
    } else {
        // chat_completions (and messages fallback shape)
        (
            format!("{base}/chat/completions"),
            serde_json::json!({
                "model": ep.model,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt_text},
                        {"type": "image_url", "image_url": {"url": data_url}}
                    ]
                }]
            }),
        )
    };

    let res = client
        .post(&url)
        .bearer_auth(&ep.api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("vision request: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("vision body: {e}"))?;
    if !status.is_success() {
        let preview: String = text.chars().take(280).collect();
        return Err(format!("vision HTTP {status}: {preview}"));
    }
    extract_vision_reply(&text, &ep.api_backend)
}

fn extract_vision_reply(raw: &str, api_backend: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("vision json: {e}"))?;
    if api_backend == "responses" {
        // Prefer output_text, then walk output[].content[].text
        if let Some(s) = v.get("output_text").and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Ok(t.to_string());
            }
        }
        if let Some(arr) = v.get("output").and_then(|x| x.as_array()) {
            let mut parts = Vec::new();
            for item in arr {
                if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                    for c in content {
                        if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                            parts.push(t.to_string());
                        }
                    }
                }
            }
            let joined = parts.join("\n").trim().to_string();
            if !joined.is_empty() {
                return Ok(joined);
            }
        }
    }
    // chat_completions
    if let Some(s) = v
        .pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
    {
        let t = s.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    Err("vision response had no text".into())
}

/// True when Host will run side-channel vision before the main model turn
/// (custom text-only main + image `@path` in prompt). Used for UI chip.
///
/// Official Grok subscription route: always false (native multimodal).
pub fn host_vision_will_run(prompt: &str, provider_id: &str) -> bool {
    // Hard gate: never Host-describe on official main (avoid double vision).
    if crate::providers::is_session_provider_official(provider_id) {
        return false;
    }
    let Ok(list) = list_custom_providers() else {
        return false;
    };
    if !route_is_text_only(&list, provider_id) {
        return false;
    }
    !extract_image_at_paths(prompt).is_empty()
}

/// Text-only check for one chat's provider. A deleted / unknown provider is not
/// a custom route (connect falls back to official).
fn route_is_text_only(list: &crate::providers::ProvidersListResult, provider_id: &str) -> bool {
    list.providers
        .iter()
        .find(|p| p.id == provider_id)
        .is_some_and(custom_provider_is_text_only)
}

/// Outcome of Host vision side-channel (for tool chip complete/fail).
#[derive(Debug, Clone)]
pub struct HostVisionPrep {
    pub prompt: String,
    /// Whether we attempted host vision (images present on text-only main).
    #[allow(dead_code)]
    pub ran: bool,
    /// True if at least one description succeeded (official or HTTP).
    pub ok: bool,
    /// Short status for logs / legacy chips.
    #[allow(dead_code)]
    pub detail: String,
    /// Full description text for journal / expandable tool body (may be long).
    pub description: String,
}

/// Full pipeline for a **final** agent prompt (after history bootstrap):
/// - text-only main → strip all image `@path` (CLI must not inject image_url)
/// - Host describes images: **prefer official ACP**, else Amux HTTP
///
/// Safe to call for every send; no-op when main is multimodal.
///
/// `progress` bridges official ACP stream/tool updates into the main chat chip.
pub async fn prepare_agent_prompt_for_main_detailed(
    prompt: &str,
    progress: Option<crate::official_aux::OfficialProgressCb>,
    provider_id: &str,
) -> HostVisionPrep {
    let config = read_config_text();
    let list = match list_custom_providers() {
        Ok(l) => l,
        Err(_) => {
            return HostVisionPrep {
                prompt: prompt.to_string(),
                ran: false,
                ok: false,
                detail: String::new(),
                description: String::new(),
            };
        }
    };
    if crate::providers::is_session_provider_official(provider_id)
        || !route_is_text_only(&list, provider_id)
    {
        return HostVisionPrep {
            prompt: prompt.to_string(),
            ran: false,
            ok: false,
            detail: String::new(),
            description: String::new(),
        };
    }

    let images = extract_image_at_paths(prompt);
    let (mut stripped, _) = strip_image_at_paths(prompt);
    if images.is_empty() {
        return HostVisionPrep {
            prompt: stripped,
            ran: false,
            ok: false,
            detail: String::new(),
            description: String::new(),
        };
    }

    let batch: Vec<String> = images.iter().take(MAX_VISION_IMAGES).cloned().collect();
    let mut blocks: Vec<String> = Vec::new();

    // 1) Official ACP vision (isolated GROK_HOME + auth; stream → chip) — preferred.
    if crate::official_aux::official_aux_available() {
        let paths = batch.clone();
        match crate::official_aux::vision_describe_async(&paths, None, progress).await {
            Ok(text) => {
                tracing::info!(
                    target: "models_aux",
                    "official ACP vision ok chars={}",
                    text.len()
                );
                blocks.push(text);
            }
            Err(e) => {
                tracing::warn!(target: "models_aux", "official vision failed: {e}");
                blocks.push(format!("[official vision failed: {e}]"));
            }
        }
    }

    // 2) Fallback: HTTP vision via image_description slot (Amux/Yun/…).
    if blocks.is_empty() || blocks.iter().all(|b| b.contains("failed")) {
        blocks.clear();
        let ep = resolve_vision_endpoint(&config, &list);
        if let Some(ref endpoint) = ep {
            for path in &batch {
                match describe_image_http(endpoint, path).await {
                    Ok(desc) => {
                        tracing::info!(
                            target: "models_aux",
                            "host vision ok path={} chars={} via {}",
                            path,
                            desc.len(),
                            endpoint.model
                        );
                        blocks.push(format!(
                            "<image_description path=\"{path}\">\n{desc}\n</image_description>"
                        ));
                    }
                    Err(e) => {
                        tracing::warn!(target: "models_aux", "host vision failed path={path}: {e}");
                        blocks.push(format!(
                            "<image_description path=\"{path}\">\n[vision failed: {e}]\n</image_description>"
                        ));
                    }
                }
            }
        } else if blocks.is_empty() {
            let list = images
                .iter()
                .map(|p| format!("- {p}"))
                .collect::<Vec<_>>()
                .join("\n");
            blocks.push(format!(
                "[Images not described — sign in with Grok (official aux) or set Model layers image_description. Paths:\n{list}]"
            ));
        }
    }

    if images.len() > MAX_VISION_IMAGES {
        blocks.push(format!(
            "[Note: {} more image(s) omitted from host vision (cap {MAX_VISION_IMAGES})]",
            images.len() - MAX_VISION_IMAGES
        ));
    }

    while stripped.ends_with('\n') {
        stripped.pop();
    }
    // Vision models often echo `@/path/to.png` in their reply. If we inject that
    // text as-is, the main CLI re-attaches image_url → DeepSeek 400. Neutralize.
    let inject = neutralize_image_at_refs(&blocks.join("\n\n"));
    let ok = !blocks.is_empty()
        && !blocks
            .iter()
            .all(|b| b.contains("failed") || b.contains("not described") || b.contains("omitted"));
    // Non-technical chip detail (UI must not show `grok -p` command lines).
    let detail = if ok {
        format!("{} image(s)", batch.len().min(MAX_VISION_IMAGES))
    } else {
        "unavailable".into()
    };
    // Full description for journal / expandable tool body.
    let description = inject.chars().take(8_000).collect::<String>();
    let mut prompt = if stripped.trim().is_empty() {
        inject
    } else {
        format!(
            "{stripped}\n\n[Host vision — image pixels were NOT sent to the main model. Use the descriptions below; do not claim you cannot see the image. Do NOT call vision_describe again unless a description block is missing or failed.]\n\n{inject}"
        )
    };
    // Final hard strip: no `@image` may reach text-only main (bootstrap / inject / hints).
    let (final_prompt, leaked) = strip_image_at_paths(&prompt);
    if !leaked.is_empty() {
        tracing::warn!(
            target: "models_aux",
            "stripped {} residual image @path(s) before main prompt",
            leaked.len()
        );
        prompt = final_prompt;
        if prompt.trim().is_empty() {
            prompt = "[Image attached — description unavailable after sanitize.]".into();
        }
    } else {
        prompt = final_prompt;
    }
    // Belt-and-suspenders: rewrite any remaining mid-line @image tokens.
    prompt = neutralize_image_at_refs(&prompt);
    HostVisionPrep {
        prompt,
        ran: true,
        ok,
        detail,
        description,
    }
}

/// Replace `@/abs/image.ext` tokens with a non-attachable form so Grok Build
/// will not inject multimodal `image_url` blocks.
pub fn neutralize_image_at_refs(text: &str) -> String {
    let (body, found) = strip_image_at_paths(text);
    if found.is_empty() {
        return text.to_string();
    }
    // Re-insert paths as plain text (no leading `@`) so context remains.
    let mut out = body;
    for p in found {
        // Only append a path list once at the end if body lost sole-line refs.
        if !out.contains(&p) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!("(image path: {p})"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_provider(
        id: &str,
        model: &str,
        name: &str,
        supports_vision: bool,
    ) -> crate::providers::CustomProvider {
        crate::providers::CustomProvider {
            id: id.into(),
            model: model.into(),
            base_url: "https://example.com/v1".into(),
            name: name.into(),
            has_api_key: true,
            api_backend: "chat_completions".into(),
            provider_mode: crate::providers::PROVIDER_MODE_GENERIC.into(),
            is_default: true,
            models: vec![],
            model_catalog_corrupt: false,
            efforts: vec![],
            context_window: None,
            base_url_full_path: false,
            append_prompt: None,
            supports_vision,
            extra_headers: vec![],
        }
    }

    #[test]
    fn custom_vision_flag_and_name_are_not_text_only() {
        assert!(custom_provider_is_text_only(&sample_provider(
            "relay", "foo-1", "My API", false
        )));
        assert!(!custom_provider_is_text_only(&sample_provider(
            "relay", "foo-1", "My API", true
        )));
        assert!(!custom_provider_is_text_only(&sample_provider(
            "relay",
            "foo-1",
            "第三方 Grok API",
            false
        )));
        assert!(!custom_provider_is_text_only(&sample_provider(
            "relay",
            "gpt-4o-mini",
            "Relay",
            false
        )));
        assert!(custom_provider_is_text_only(&sample_provider(
            "deepseek",
            "deepseek-v4-flash",
            "DeepSeek",
            false
        )));
    }

    #[test]
    fn custom_vision_follows_active_model_not_sibling_catalog() {
        let mut p = sample_provider("deepseek", "deepseek-v4-flash", "DeepSeek", false);
        p.models = vec![
            crate::providers::ProviderModelEntry::named("deepseek-v4-flash", "DeepSeek V4 Flash"),
            crate::providers::ProviderModelEntry {
                id: "deepseek-v4-flash-vision-exp".into(),
                name: "Flash Vision".into(),
                supports_vision: Some(true),
                ..Default::default()
            },
        ];
        assert!(
            custom_provider_is_text_only(&p),
            "active flash must stay text-only even when a sibling is vision"
        );
        p.model = "deepseek-v4-flash-vision-exp".into();
        assert!(!custom_provider_is_text_only(&p));
    }

    #[test]
    fn custom_vision_explicit_off_beats_a_vision_looking_active_id() {
        // Explicit per-model flags win over id / name heuristics.
        let mut p = sample_provider("relay", "gpt-4o", "My API", true);
        p.models = vec![crate::providers::ProviderModelEntry {
            id: "gpt-4o".into(),
            name: "GPT-4o text route".into(),
            supports_vision: Some(false),
            ..Default::default()
        }];
        assert!(
            custom_provider_is_text_only(&p),
            "an explicit supportsVision=false row must stay text-only"
        );

        let mut grok = sample_provider("relay", "grok-vision-beta", "My API", false);
        grok.models = vec![crate::providers::ProviderModelEntry {
            id: "grok-vision-beta".into(),
            name: "Grok Vision Beta".into(),
            supports_vision: Some(false),
            ..Default::default()
        }];
        assert!(
            custom_provider_is_text_only(&grok),
            "a grok-vision id must not override an explicit supportsVision=false"
        );
    }

    #[test]
    fn custom_vision_explicit_off_does_not_leak_to_or_from_a_sibling_row() {
        let mut p = sample_provider("deepseek", "deepseek-v4-flash", "DeepSeek", false);
        p.models = vec![
            crate::providers::ProviderModelEntry {
                id: "deepseek-v4-flash".into(),
                name: "DeepSeek V4 Flash".into(),
                supports_vision: Some(false),
                ..Default::default()
            },
            crate::providers::ProviderModelEntry {
                id: "grok-vision-exp".into(),
                name: "Grok Vision Exp".into(),
                supports_vision: Some(true),
                ..Default::default()
            },
        ];
        assert!(custom_provider_is_text_only(&p));

        p.model = "grok-vision-exp".into();
        assert!(!custom_provider_is_text_only(&p));
    }

    #[test]
    fn custom_vision_never_borrows_a_recovered_sibling_for_a_missing_active_row() {
        // A corrupt catalog recovered only m2; the channel still points at m1.
        // m2's capability must not decide whether m1 gets image pixels.
        let mut p = sample_provider("relay", "m1", "My API", false);
        p.model_catalog_corrupt = true;
        p.models = vec![crate::providers::ProviderModelEntry {
            id: "m2".into(),
            name: "M2".into(),
            supports_vision: Some(true),
            ..Default::default()
        }];
        assert!(
            custom_provider_is_text_only(&p),
            "m1 must not inherit a recovered sibling's vision flag"
        );

        // The exact active row still wins.
        p.model = "m2".into();
        assert!(!custom_provider_is_text_only(&p));
    }

    #[test]
    fn custom_vision_with_an_empty_catalog_stays_conservative() {
        let mut p = sample_provider("relay", "m1", "My API", false);
        p.models = Vec::new();
        assert!(custom_provider_is_text_only(&p));
        p.supports_vision = true;
        assert!(!custom_provider_is_text_only(&p));
    }

    #[test]
    fn extract_and_strip_images_from_bootstrap() {
        let prompt =
            "[Prior…]\n### User\n你好\n\n@/tmp/a.png\n\n### Assistant\nok\n\n新问题\n@/tmp/b.jpg";
        let imgs = extract_image_at_paths(prompt);
        assert_eq!(imgs.len(), 2);
        let (body, stripped) = strip_image_at_paths(prompt);
        assert_eq!(stripped.len(), 2);
        assert!(!body.contains("@/tmp/a.png"));
        assert!(!body.contains("@/tmp/b.jpg"));
    }

    #[test]
    fn neutralize_removes_echoed_at_image_from_vision_output() {
        // Vision models often echo the @path we passed them.
        let echoed = r#"<image_description path="/tmp/a.png">
A red button.
</image_description>

@/tmp/a.png
"#;
        let out = neutralize_image_at_refs(echoed);
        assert!(
            !out.contains("@/tmp/a.png"),
            "must not re-inject attachable @image: {out}"
        );
        assert!(
            out.contains("red button") || out.contains("image_description"),
            "{out}"
        );
    }

    #[test]
    fn neutralize_noop_when_no_images() {
        let t = "plain text without attachments";
        assert_eq!(neutralize_image_at_refs(t), t);
    }

    #[test]
    fn strip_preserves_chinese_utf8() {
        let s = "在 x 上搜索 someuser 这个账号的信息";
        let (body, found) = strip_image_at_paths(s);
        assert!(found.is_empty());
        assert_eq!(body, s, "must not corrupt multi-byte UTF-8");
        assert!(body.contains("账号"));
    }

    #[test]
    fn strip_mid_line_image_keeps_chinese_caption() {
        let s = "看看这张图 @/tmp/shot.png 是什么";
        let (body, found) = strip_image_at_paths(s);
        assert_eq!(found, vec!["/tmp/shot.png".to_string()]);
        assert!(body.contains("看看这张图"), "{body}");
        assert!(body.contains("是什么"), "{body}");
        assert!(!body.contains("@/tmp/shot.png"), "{body}");
    }

    #[test]
    fn normalize_slot_value_auto() {
        assert_eq!(normalize_slot_value("  "), None);
        assert_eq!(normalize_slot_value("auto"), None);
        assert_eq!(normalize_slot_value("AUTO"), None);
        assert_eq!(
            normalize_slot_value("grok-4.5").as_deref(),
            Some("grok-4.5")
        );
    }
}
