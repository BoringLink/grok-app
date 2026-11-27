//! Discover selectable Grok Build agent definition names for Settings.
//!
//! Sources mirror CLI `--agent <NAME>` resolution:
//! - Built-ins: explore, plan, general-purpose
//! - User: `~/.grok/agents/*.md` (+ active GROK_HOME / agent-home agents)
//! - Project: `<cwd>/.grok/agents/*.md`
//! - Bundled reference: `~/.grok/bundled/agents/*.md` (same names as built-ins)
//!
//! Independent 模式通过表单在活动 agent home 或项目 `.grok/agents` 创建 Markdown 定义。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::paths::resolve_agent_grok_home;
use crate::store;

/// Well-known built-in agent names (always listed even if files are missing).
pub const BUILTIN_AGENT_NAMES: &[&str] = &["explore", "general-purpose", "plan"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentCatalogSource {
    Builtin,
    User,
    Project,
    Bundled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogEntry {
    pub name: String,
    pub source: AgentCatalogSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsCatalogResult {
    pub agents: Vec<AgentCatalogEntry>,
    pub user_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    pub bundled_dir: String,
}

/// Pure: normalize settings value → spawn name, or `None` for CLI default.
pub fn normalize_preferred_agent(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "default" | "none" | "cli-default" | "grok-build"
    ) {
        return None;
    }
    if name.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return None;
    }
    Some(name.to_string())
}

/// Pure: top-level CLI args `["--agent", name]` when set.
#[allow(dead_code)]
pub fn agent_spawn_cli_args(raw: &str) -> Option<Vec<String>> {
    let name = normalize_preferred_agent(raw)?;
    Some(vec!["--agent".into(), name])
}

/// Pure: normalize Settings → Agent profile path for spawn.
/// Empty / control chars → `None` (omit `--agent-profile`).
/// Does not check filesystem existence.
pub fn normalize_agent_profile_path(raw: &str) -> Option<String> {
    let path = raw.trim();
    if path.is_empty() {
        return None;
    }
    if path.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return None;
    }
    Some(path.to_string())
}

/// Pure: agent-option CLI args `["--agent-profile", path]` when set.
/// Placement: after `grok agent` and before `stdio` (not top-level).
#[allow(dead_code)]
pub fn agent_profile_spawn_cli_args(raw: &str) -> Option<Vec<String>> {
    let path = normalize_agent_profile_path(raw)?;
    Some(vec!["--agent-profile".into(), path])
}

/// Soft cap for Settings / spawn argv (~64 KiB).
pub const AGENTS_JSON_MAX_CHARS: usize = 64 * 1024;

/// Pure: validate + normalize inline agents JSON for Settings / spawn.
///
/// - Blank → `Ok("")` (omit `--agents`)
/// - Valid JSON **object** map → `Ok(compact)` for storage / CLI
/// - Invalid syntax, non-object, or too large → `Err(message)`
///
/// CLI currently expects a map (`--agents: … expected a map`); arrays and
/// primitives are rejected so save fails honestly instead of at next spawn.
pub fn normalize_agents_json(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.len() > AGENTS_JSON_MAX_CHARS {
        return Err(format!(
            "Agents JSON is too large (max {AGENTS_JSON_MAX_CHARS} characters)."
        ));
    }
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| "Invalid JSON — fix syntax before saving.".to_string())?;
    if !value.is_object() {
        return Err("Agents JSON must be a JSON object map (e.g. {\"reviewer\":{…}}).".into());
    }
    let compact = serde_json::to_string(&value)
        .map_err(|_| "Invalid JSON — fix syntax before saving.".to_string())?;
    if compact.len() > AGENTS_JSON_MAX_CHARS {
        return Err(format!(
            "Agents JSON is too large (max {AGENTS_JSON_MAX_CHARS} characters)."
        ));
    }
    Ok(compact)
}

/// Pure: top-level CLI args `["--agents", json]` when set.
/// Empty / invalid → `None` (omit flag; invalid should not reach spawn).
pub fn agents_json_spawn_cli_args(raw: &str) -> Option<Vec<String>> {
    match normalize_agents_json(raw) {
        Ok(s) if !s.is_empty() => Some(vec!["--agents".into(), s]),
        _ => None,
    }
}

/// File stem for agent def (`explore.md` → `explore`).
pub fn agent_name_from_file_name(file_name: &str) -> Option<String> {
    let base = Path::new(file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .trim();
    if base.is_empty() || base.starts_with('.') {
        return None;
    }
    let lower = base.to_ascii_lowercase();
    let stem = if let Some(s) = lower.strip_suffix(".markdown") {
        &base[..s.len()]
    } else {
        let s = lower.strip_suffix(".md")?;
        &base[..s.len()]
    };
    let stem = stem.trim();
    if stem.is_empty() || stem.eq_ignore_ascii_case("readme") {
        return None;
    }
    Some(stem.to_string())
}

fn is_agent_md(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .and_then(agent_name_from_file_name)
        .is_some()
}

fn scan_agent_dir(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for ent in rd.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        if !is_agent_md(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(agent_name_from_file_name);
        if let Some(name) = name {
            out.push((name, path));
        }
    }
    out.sort_by_key(|a| a.0.to_ascii_lowercase());
    out
}

/// Pure merge: project > user > bundled file > builtin name-only.
pub fn merge_agent_catalog(
    builtins: &[&str],
    user: &[(String, PathBuf)],
    project: &[(String, PathBuf)],
    bundled: &[(String, PathBuf)],
) -> Vec<AgentCatalogEntry> {
    use std::collections::BTreeMap;
    // BTreeMap keyed by lowercase name for stable sort of keys; we re-sort at end by display name.
    let mut map: BTreeMap<String, AgentCatalogEntry> = BTreeMap::new();

    for name in builtins {
        let n = name.trim();
        if n.is_empty() {
            continue;
        }
        map.insert(
            n.to_ascii_lowercase(),
            AgentCatalogEntry {
                name: n.to_string(),
                source: AgentCatalogSource::Builtin,
                path: None,
            },
        );
    }

    for (name, path) in bundled {
        map.insert(
            name.to_ascii_lowercase(),
            AgentCatalogEntry {
                name: name.clone(),
                source: AgentCatalogSource::Bundled,
                path: Some(path.display().to_string()),
            },
        );
    }

    for (name, path) in user {
        map.insert(
            name.to_ascii_lowercase(),
            AgentCatalogEntry {
                name: name.clone(),
                source: AgentCatalogSource::User,
                path: Some(path.display().to_string()),
            },
        );
    }

    for (name, path) in project {
        map.insert(
            name.to_ascii_lowercase(),
            AgentCatalogEntry {
                name: name.clone(),
                source: AgentCatalogSource::Project,
                path: Some(path.display().to_string()),
            },
        );
    }

    let mut agents: Vec<_> = map.into_values().collect();
    agents.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    agents
}

fn user_grok_home() -> PathBuf {
    crate::process_util::user_home().join(".grok")
}

/// Live catalog for Settings agent picker.
pub fn list_agents_catalog(project_path: Option<&str>) -> AgentsCatalogResult {
    let grok = user_grok_home();
    let user_dir = grok.join("agents");
    let bundled_dir = grok.join("bundled").join("agents");
    let project_dir = project_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|p| PathBuf::from(p).join(".grok").join("agents"));

    let mut user = scan_agent_dir(&user_dir);
    // Independent mode GROK_HOME may differ from ~/.grok — include those defs.
    let settings = store::load_settings();
    let active_home = resolve_agent_grok_home(&settings.session_data_mode);
    let active_agents = active_home.join("agents");
    if active_agents != user_dir {
        for entry in scan_agent_dir(&active_agents) {
            if !user.iter().any(|(n, _)| n.eq_ignore_ascii_case(&entry.0)) {
                user.push(entry);
            }
        }
    }
    let bundled = scan_agent_dir(&bundled_dir);
    let project = project_dir
        .as_ref()
        .map(|d| scan_agent_dir(d))
        .unwrap_or_default();

    let agents = merge_agent_catalog(BUILTIN_AGENT_NAMES, &user, &project, &bundled);

    AgentsCatalogResult {
        agents,
        user_dir: user_dir.display().to_string(),
        project_dir: project_dir.map(|p| p.display().to_string()),
        bundled_dir: bundled_dir.display().to_string(),
    }
}

// ── Agent Markdown definitions ──────────────────────────────────────────────

const AGENT_STEM_NAME_MAX: usize = 64;
const MAX_AGENT_PROMPT_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionCreateResult {
    pub name: String,
    pub path: String,
    pub scope: String,
    pub created: bool,
    pub overwritten: bool,
}

/// Pure: sanitize agent file stem for filesystem + CLI `--agent`.
/// Mirrors `src/lib/agentsDiscovery.ts` `sanitizeAgentFileStemName`.
pub fn sanitize_agent_file_stem_name(raw: &str) -> Result<String, String> {
    // Collapse whitespace runs to a single hyphen (no leading hyphen from spaces).
    let name = {
        let trimmed = raw.trim();
        let mut out = String::with_capacity(trimmed.len());
        let mut prev_hyphen = false;
        for ch in trimmed.chars() {
            if ch.is_whitespace() {
                if !prev_hyphen && !out.is_empty() {
                    out.push('-');
                    prev_hyphen = true;
                }
            } else {
                out.push(ch);
                prev_hyphen = ch == '-';
            }
        }
        // Drop a single trailing hyphen left by trailing spaces only.
        if out.ends_with('-') {
            let before = out.trim_end_matches('-');
            // Keep intentional trailing hyphens that were not from whitespace collapse
            // only when the raw ended with '-'; otherwise strip padding hyphens.
            if !trimmed.ends_with('-') {
                out = before.to_string();
            }
        }
        out
    };
    if name.is_empty() {
        return Err("agent name is required".into());
    }
    if name == "." || name == ".." {
        return Err("invalid agent name".into());
    }
    if name.len() > AGENT_STEM_NAME_MAX {
        return Err(format!("agent name too long (max {AGENT_STEM_NAME_MAX})"));
    }
    if name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.contains('\n')
        || name.contains('\r')
    {
        return Err("agent name must not contain path separators".into());
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return Err("agent name may only contain letters, digits, '.', '_' and '-'".into());
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err("agent name may only contain letters, digits, '.', '_' and '-'".into());
    }
    if name.eq_ignore_ascii_case("readme") {
        return Err("reserved agent name".into());
    }
    Ok(name)
}

/// 根据表单字段生成规范的 Agent Markdown 定义。
#[cfg(test)]
pub fn agent_markdown_from_form(
    name: &str,
    description: &str,
    instructions: &str,
) -> Result<String, String> {
    let stem = sanitize_agent_file_stem_name(name)?;
    let description = description.trim();
    let instructions = instructions.trim();
    if description.is_empty() || description.len() > 4096 || description.contains('\0') {
        return Err("agent description is required and must be at most 4096 bytes".into());
    }
    if instructions.is_empty() || instructions.len() > 64 * 1024 || instructions.contains('\0') {
        return Err("agent instructions are required and must be at most 65536 bytes".into());
    }
    let mut frontmatter = serde_json::Map::new();
    frontmatter.insert("name".into(), serde_json::Value::String(stem));
    frontmatter.insert(
        "description".into(),
        serde_json::Value::String(description.into()),
    );
    frontmatter.insert(
        "promptMode".into(),
        serde_json::Value::String("full".into()),
    );
    frontmatter.insert("agentsMd".into(), serde_json::Value::Bool(true));
    frontmatter.insert(
        "mcpInheritance".into(),
        serde_json::Value::String("all".into()),
    );
    agent_markdown_from_frontmatter(serde_json::Value::Object(frontmatter), instructions)
}

/// Serialize Agent frontmatter and its Markdown system-prompt body.
pub fn agent_markdown_from_frontmatter(
    frontmatter: serde_json::Value,
    instructions: &str,
) -> Result<String, String> {
    let mut frontmatter = frontmatter
        .as_object()
        .cloned()
        .ok_or_else(|| "Agent frontmatter must be a mapping".to_string())?;
    let name = frontmatter
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "agent name is required".to_string())?;
    let name = sanitize_agent_file_stem_name(name)?;
    frontmatter.insert("name".into(), serde_json::Value::String(name));
    let description = frontmatter
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 4096 && !value.contains('\0'))
        .ok_or_else(|| {
            "agent description is required and must be at most 4096 bytes".to_string()
        })?;
    frontmatter.insert(
        "description".into(),
        serde_json::Value::String(description.into()),
    );
    let instructions = instructions.trim();
    if instructions.len() > 64 * 1024 || instructions.contains('\0') {
        return Err("agent instructions must be at most 65536 bytes".into());
    }
    let yaml = yaml_serde::to_string(&serde_json::Value::Object(frontmatter))
        .map_err(|_| "could not encode Agent frontmatter".to_string())?;
    if yaml.len() > 128 * 1024 {
        return Err("Agent frontmatter is too large".into());
    }
    Ok(format!("---\n{yaml}---\n\n{instructions}\n"))
}

/// Parse an Agent definition while retaining its frontmatter values and body.
pub fn parse_agent_markdown(content: &str) -> Result<(serde_json::Value, String), String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let after_open = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
        .ok_or_else(|| "Agent Markdown must start with YAML frontmatter".to_string())?;
    let marker = after_open
        .match_indices("\n---")
        .find(|(index, marker)| {
            let suffix = &after_open[index + marker.len()..];
            suffix.is_empty() || suffix.starts_with('\n') || suffix.starts_with("\r\n")
        })
        .map(|(index, marker)| (index, marker.len()))
        .ok_or_else(|| "Agent Markdown frontmatter is not closed".to_string())?;
    let yaml = &after_open[..marker.0];
    let parsed: serde_json::Value = yaml_serde::from_str(yaml)
        .map_err(|_| "Agent Markdown frontmatter is invalid YAML".to_string())?;
    let frontmatter = parsed
        .as_object()
        .ok_or_else(|| "Agent Markdown frontmatter must be a mapping".to_string())?;
    let name = frontmatter
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Agent Markdown frontmatter requires a name".to_string())?;
    sanitize_agent_file_stem_name(name)?;
    if frontmatter
        .get("description")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err("Agent Markdown frontmatter requires a description".into());
    }
    let body_offset = marker.0 + marker.1;
    let body = after_open[body_offset..]
        .strip_prefix("\r\n")
        .or_else(|| after_open[body_offset..].strip_prefix('\n'))
        .unwrap_or(&after_open[body_offset..]);
    Ok((parsed, body.to_string()))
}

/// 根据作用域解析 Agent 定义的写入目录。
///
/// - `user` → `{resolve_agent_grok_home}/agents`
/// - `project` → `{project}/.grok/agents` (requires project_path)
struct AgentDefinitionLocation {
    dir: PathBuf,
    boundary: PathBuf,
    scope: String,
}

fn resolve_agent_definition_dir(
    scope: &str,
    project_path: Option<&str>,
) -> Result<AgentDefinitionLocation, String> {
    let scope = scope.trim().to_ascii_lowercase();
    match scope.as_str() {
        "user" | "" => {
            let settings = store::load_settings();
            let home = resolve_agent_grok_home(&settings.session_data_mode);
            Ok(AgentDefinitionLocation {
                dir: home.join("agents"),
                boundary: home,
                scope: "user".into(),
            })
        }
        "project" => {
            let proj = project_path
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "project path required for project scope".to_string())?;
            if proj.contains('\0') {
                return Err("invalid project path".into());
            }
            let root = PathBuf::from(proj);
            if !root.is_absolute() || !fs::metadata(&root).is_ok_and(|metadata| metadata.is_dir()) {
                return Err("project path must be an existing directory".into());
            }
            // Refuse path traversal noise in project path segments.
            if root
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("invalid project path".into());
            }
            Ok(AgentDefinitionLocation {
                dir: root.join(".grok").join("agents"),
                boundary: root,
                scope: "project".into(),
            })
        }
        other => Err(format!("unknown agent scope: {other}")),
    }
}

pub fn validate_agent_definition_scope(
    scope: &str,
    project_path: Option<&str>,
) -> Result<(), String> {
    let location = resolve_agent_definition_dir(scope, project_path)?;
    ensure_agent_dir_within_boundary(&location.dir, &location.boundary)
}

pub fn resolve_agent_definition_target(
    name: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<(String, PathBuf, String), String> {
    let stem = sanitize_agent_file_stem_name(name)?;
    let location = resolve_agent_definition_dir(scope, project_path)?;
    ensure_agent_dir_within_boundary(&location.dir, &location.boundary)?;
    let path = location.dir.join(format!("{stem}.md"));
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
        || path.parent() != Some(location.dir.as_path())
    {
        return Err("path not allowed: outside agents directory".into());
    }
    Ok((stem, path, location.scope))
}

fn canonicalize_nearest_existing(path: &std::path::Path) -> Result<PathBuf, String> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => path
            .parent()
            .filter(|parent| *parent != path)
            .ok_or_else(|| "Agent directory has no existing parent".to_string())
            .and_then(canonicalize_nearest_existing),
        Err(_) => Err("could not inspect Agent directory".into()),
    }
}

pub(crate) fn ensure_agent_dir_within_boundary(
    dir: &std::path::Path,
    boundary: &std::path::Path,
) -> Result<(), String> {
    let canonical_boundary = canonicalize_nearest_existing(boundary)?;
    let canonical_dir = canonicalize_nearest_existing(dir)?;
    if canonical_dir.starts_with(&canonical_boundary) {
        Ok(())
    } else {
        Err("Agent directory resolves outside the selected scope".into())
    }
}

fn agent_home_prompt_directory(
    agent_home: &std::path::Path,
    create: bool,
) -> Result<PathBuf, String> {
    let canonical_home = fs::canonicalize(agent_home)
        .map_err(|_| "agent home directory is unavailable".to_string())?;
    let directory = canonical_home.join("prompts");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("agent-home/prompts must be a regular directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("could not inspect agent-home/prompts".into()),
    }
    ensure_agent_dir_within_boundary(&directory, &canonical_home)?;
    if create {
        fs::create_dir_all(&directory)
            .map_err(|_| "could not create agent-home/prompts".to_string())?;
        ensure_agent_dir_within_boundary(&directory, &canonical_home)?;
    }
    if directory.is_dir() {
        fs::canonicalize(&directory).map_err(|_| "could not resolve agent-home/prompts".to_string())
    } else {
        Ok(directory)
    }
}

pub(crate) fn managed_role_prompt_file(
    agent_home: &std::path::Path,
    role_name: &str,
    current_prompt_file: Option<&str>,
) -> Result<PathBuf, String> {
    let prompt_directory = agent_home_prompt_directory(agent_home, false)?;
    if let Some(current_prompt_file) = current_prompt_file
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let current_path = std::path::Path::new(current_prompt_file);
        if current_path.is_absolute() {
            if let Ok(canonical) = fs::canonicalize(current_path) {
                if canonical.starts_with(&prompt_directory) && canonical.is_file() {
                    return Ok(canonical);
                }
            }
        }
    }
    let role_stem = role_name.trim();
    if role_stem.is_empty()
        || role_stem.len() > AGENT_STEM_NAME_MAX
        || !role_stem
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("invalid role name for prompt file".into());
    }
    let device_name = role_stem
        .split('.')
        .next()
        .unwrap_or(role_stem)
        .to_ascii_uppercase();
    let windows_device_name = matches!(
        device_name.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    let filename = if windows_device_name {
        format!("role-{role_stem}.md")
    } else {
        format!("{role_stem}.md")
    };
    Ok(prompt_directory.join(filename))
}

pub(crate) fn ensure_agent_home_prompt_directory(
    agent_home: &std::path::Path,
) -> Result<PathBuf, String> {
    agent_home_prompt_directory(agent_home, true)
}

pub(crate) fn canonical_managed_role_prompt_file(
    agent_home: &std::path::Path,
    prompt_file: &str,
) -> Option<PathBuf> {
    let prompt_directory = agent_home_prompt_directory(agent_home, false).ok()?;
    let canonical = fs::canonicalize(prompt_file).ok()?;
    (canonical.starts_with(prompt_directory) && canonical.is_file()).then_some(canonical)
}

pub(crate) fn read_managed_role_prompt(
    agent_home: &std::path::Path,
    prompt_file: &str,
) -> Option<String> {
    use std::io::Read as _;

    let canonical = canonical_managed_role_prompt_file(agent_home, prompt_file)?;
    let metadata = fs::metadata(&canonical).ok()?;
    if metadata.len() > MAX_AGENT_PROMPT_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(canonical)
        .ok()?
        .take(MAX_AGENT_PROMPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_AGENT_PROMPT_BYTES || bytes.is_empty() {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// 根据设置表单创建用户编写的 Agent Markdown 定义。
#[cfg(test)]
pub fn create_agent_definition(
    name: &str,
    scope: &str,
    project_path: Option<&str>,
    force: bool,
    description: &str,
    instructions: &str,
) -> Result<AgentDefinitionCreateResult, String> {
    let markdown = agent_markdown_from_form(name, description, instructions)?;
    create_agent_file(name, scope, project_path, force, markdown)
}

/// Create an Agent definition from the validated Markdown serialized by Settings.
pub fn create_agent_markdown_definition(
    name: &str,
    scope: &str,
    project_path: Option<&str>,
    force: bool,
    markdown: String,
) -> Result<AgentDefinitionCreateResult, String> {
    create_agent_file(name, scope, project_path, force, markdown)
}

fn create_agent_file(
    name: &str,
    scope: &str,
    project_path: Option<&str>,
    force: bool,
    markdown: String,
) -> Result<AgentDefinitionCreateResult, String> {
    let (stem, path, scope_label) = resolve_agent_definition_target(name, scope, project_path)?;

    let location = resolve_agent_definition_dir(scope, project_path)?;
    let existing_metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("agent definition path cannot be a symlink".into());
        }
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("could not inspect agent file: {error}")),
    };
    let exists = existing_metadata.is_some();
    if existing_metadata.is_some_and(|metadata| !metadata.is_file()) {
        return Err("agent definition target must be a regular file".into());
    }
    if exists && !force {
        return Err(format!(
            "agent already exists: {} (pass force to overwrite)",
            path.display()
        ));
    }

    let dir = path
        .parent()
        .ok_or_else(|| "agent directory is unavailable".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create agents dir: {e}"))?;
    ensure_agent_dir_within_boundary(dir, &location.boundary)?;
    let canonical_dir =
        fs::canonicalize(dir).map_err(|_| "could not resolve Agent directory".to_string())?;
    let path = canonical_dir.join(
        path.file_name()
            .ok_or_else(|| "Agent file name is unavailable".to_string())?,
    );
    write_agent_definition_file(&path, markdown.as_bytes(), force)?;

    Ok(AgentDefinitionCreateResult {
        name: stem,
        path: path.display().to_string(),
        scope: scope_label,
        created: !exists,
        overwritten: exists && force,
    })
}

pub(crate) fn write_agent_definition_file(
    path: &std::path::Path,
    content: &[u8],
    overwrite: bool,
) -> Result<(), String> {
    if overwrite {
        use std::io::Write as _;

        let parent = path
            .parent()
            .ok_or_else(|| "Agent directory is unavailable".to_string())?;
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Agent file name is invalid".to_string())?;
        let temporary_path = parent.join(format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()));
        let write_result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .map_err(|_| "could not prepare Agent definition".to_string())?;
            file.write_all(content)
                .and_then(|()| file.sync_all())
                .map_err(|_| "could not write Agent definition".to_string())?;
            fs::rename(&temporary_path, path)
                .map_err(|_| "could not atomically replace Agent definition".to_string())
        })();
        if write_result.is_err() {
            if let Err(error) = fs::remove_file(&temporary_path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::error!(%error, "could not remove temporary Agent definition");
                }
            }
        }
        return write_result;
    }
    use std::io::Write as _;

    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!(
                "agent already exists: {} (pass force to overwrite)",
                path.display()
            ));
        }
        Err(_) => return Err("could not create Agent definition".into()),
    };
    if file
        .write_all(content)
        .and_then(|()| file.sync_all())
        .is_err()
    {
        drop(file);
        if let Err(error) = fs::remove_file(path) {
            tracing::error!(%error, "could not remove incomplete Agent definition");
        }
        return Err("could not write Agent definition".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn normalize_empty_and_sentinels() {
        assert!(normalize_preferred_agent("").is_none());
        assert!(normalize_preferred_agent("  ").is_none());
        assert!(normalize_preferred_agent("default").is_none());
        assert!(normalize_preferred_agent("NONE").is_none());
        assert!(normalize_preferred_agent("grok-build").is_none());
        assert!(normalize_preferred_agent("cli-default").is_none());
        assert!(normalize_preferred_agent("ex\nplore").is_none());
    }

    #[test]
    fn normalize_keeps_names() {
        assert_eq!(
            normalize_preferred_agent("  explore  ").as_deref(),
            Some("explore")
        );
        assert_eq!(
            normalize_preferred_agent("general-purpose").as_deref(),
            Some("general-purpose")
        );
        assert_eq!(
            normalize_preferred_agent("/tmp/a.md").as_deref(),
            Some("/tmp/a.md")
        );
    }

    #[test]
    fn spawn_args_top_level() {
        assert!(agent_spawn_cli_args("").is_none());
        assert!(agent_spawn_cli_args("default").is_none());
        assert_eq!(
            agent_spawn_cli_args("explore"),
            Some(vec!["--agent".into(), "explore".into()])
        );
        assert_eq!(
            agent_spawn_cli_args("  plan  "),
            Some(vec!["--agent".into(), "plan".into()])
        );
    }

    #[test]
    fn normalize_agent_profile_path_empty_and_controls() {
        assert!(normalize_agent_profile_path("").is_none());
        assert!(normalize_agent_profile_path("  ").is_none());
        assert!(normalize_agent_profile_path("/tmp/a\nb.md").is_none());
        assert!(normalize_agent_profile_path("x\0y").is_none());
    }

    #[test]
    fn normalize_agent_profile_path_trims() {
        assert_eq!(
            normalize_agent_profile_path("  /tmp/my-agent.md  ").as_deref(),
            Some("/tmp/my-agent.md")
        );
        assert_eq!(
            normalize_agent_profile_path("./agents/custom.md").as_deref(),
            Some("./agents/custom.md")
        );
    }

    #[test]
    fn agent_profile_spawn_args() {
        assert!(agent_profile_spawn_cli_args("").is_none());
        assert_eq!(
            agent_profile_spawn_cli_args("  /tmp/a.md  "),
            Some(vec!["--agent-profile".into(), "/tmp/a.md".into()])
        );
    }

    #[test]
    fn normalize_agents_json_empty() {
        assert_eq!(normalize_agents_json("").as_deref(), Ok(""));
        assert_eq!(normalize_agents_json("  \n").as_deref(), Ok(""));
    }

    #[test]
    fn normalize_agents_json_object() {
        assert_eq!(
            normalize_agents_json(r#"  { "a": { "prompt": "x" } }  "#).as_deref(),
            Ok(r#"{"a":{"prompt":"x"}}"#)
        );
        assert_eq!(normalize_agents_json("{}").as_deref(), Ok("{}"));
    }

    #[test]
    fn normalize_agents_json_rejects_bad_shapes() {
        assert!(normalize_agents_json("{").is_err());
        assert!(normalize_agents_json("[]").is_err());
        assert!(normalize_agents_json("null").is_err());
        assert!(normalize_agents_json(r#""x""#).is_err());
        assert!(normalize_agents_json("1").is_err());
    }

    #[test]
    fn normalize_agents_json_size_cap() {
        let big = format!(r#"{{"a":"{}"}}"#, "x".repeat(AGENTS_JSON_MAX_CHARS));
        assert!(normalize_agents_json(&big).is_err());
    }

    #[test]
    fn agents_json_spawn_args() {
        assert!(agents_json_spawn_cli_args("").is_none());
        assert!(agents_json_spawn_cli_args("[]").is_none());
        assert_eq!(
            agents_json_spawn_cli_args(r#"  {"x":1}  "#),
            Some(vec!["--agents".into(), r#"{"x":1}"#.into()])
        );
    }

    #[test]
    fn file_name_stems() {
        assert_eq!(
            agent_name_from_file_name("explore.md").as_deref(),
            Some("explore")
        );
        assert_eq!(
            agent_name_from_file_name("my.markdown").as_deref(),
            Some("my")
        );
        assert!(agent_name_from_file_name("x.txt").is_none());
        assert!(agent_name_from_file_name(".hidden.md").is_none());
        assert!(agent_name_from_file_name("README.md").is_none());
        assert_eq!(
            agent_name_from_file_name("/a/b/plan.md").as_deref(),
            Some("plan")
        );
    }

    #[test]
    fn merge_priority_project_user_bundled_builtin() {
        let user = vec![(
            "explore".into(),
            PathBuf::from("/u/.grok/agents/explore.md"),
        )];
        let project = vec![(
            "explore".into(),
            PathBuf::from("/p/.grok/agents/explore.md"),
        )];
        let bundled = vec![(
            "plan".into(),
            PathBuf::from("/u/.grok/bundled/agents/plan.md"),
        )];
        let custom = vec![("custom".into(), PathBuf::from("/u/.grok/agents/custom.md"))];
        let user_all = [user, custom].concat();
        let agents = merge_agent_catalog(BUILTIN_AGENT_NAMES, &user_all, &project, &bundled);
        let by: std::collections::HashMap<_, _> =
            agents.into_iter().map(|e| (e.name.clone(), e)).collect();
        assert_eq!(by["explore"].source, AgentCatalogSource::Project);
        assert_eq!(
            by["explore"].path.as_deref(),
            Some("/p/.grok/agents/explore.md")
        );
        assert_eq!(by["custom"].source, AgentCatalogSource::User);
        assert_eq!(by["plan"].source, AgentCatalogSource::Bundled);
        assert_eq!(by["general-purpose"].source, AgentCatalogSource::Builtin);
        assert!(by["general-purpose"].path.is_none());
    }

    #[test]
    fn sanitize_stem_ok() {
        assert_eq!(
            sanitize_agent_file_stem_name("  my agent  ").as_deref(),
            Ok("my-agent")
        );
        assert_eq!(
            sanitize_agent_file_stem_name("general-purpose").as_deref(),
            Ok("general-purpose")
        );
        assert_eq!(
            sanitize_agent_file_stem_name("My.Agent_1").as_deref(),
            Ok("My.Agent_1")
        );
    }

    #[test]
    fn sanitize_stem_rejects() {
        assert!(sanitize_agent_file_stem_name("").is_err());
        assert!(sanitize_agent_file_stem_name("a/b").is_err());
        assert!(sanitize_agent_file_stem_name("-sneaky").is_err());
        assert!(sanitize_agent_file_stem_name("README").is_err());
        assert!(sanitize_agent_file_stem_name("has!").is_err());
        assert!(sanitize_agent_file_stem_name(&"x".repeat(65)).is_err());
    }

    #[test]
    fn form_markdown_has_canonical_frontmatter_without_secrets() {
        let md = agent_markdown_from_form(
            "code-review",
            "Review code changes",
            "Review the requested scope and return findings first.",
        )
        .unwrap();
        assert!(md.starts_with("---\n"));
        assert!(md.contains("name: code-review"));
        assert!(md.contains("promptMode: full"));
        assert!(md.contains("agentsMd: true"));
        assert!(md.contains("mcpInheritance: all"));
        assert!(md.contains("Review the requested scope and return findings first."));
        let lower = md.to_ascii_lowercase();
        assert!(!lower.contains("api_key"));
        assert!(!lower.contains("sk-"));
    }

    #[test]
    fn form_markdown_quotes_frontmatter_and_keeps_instruction_body() {
        let description = "Review config: safely\nwithout YAML injection";
        let instructions = "Review only the requested scope.\n\nReturn findings first.";
        let markdown = agent_markdown_from_form("review-agent", description, instructions).unwrap();
        let (frontmatter, body) = parse_agent_markdown(&markdown).unwrap();
        assert_eq!(frontmatter["name"], "review-agent");
        assert_eq!(frontmatter["description"], description);
        assert_eq!(body.trim(), instructions);
        assert!(markdown.contains("Return findings first."));
        assert!(agent_markdown_from_form("review-agent", "", instructions).is_err());
        assert!(agent_markdown_from_form("review-agent", description, "  ").is_err());
        assert!(agent_markdown_from_form("../outside", description, instructions).is_err());
    }

    #[test]
    fn agent_frontmatter_round_trip_keeps_nested_schema_fields_and_unknown_values() {
        let source = "---\nname: reviewer\ndescription: Review changes\ntools:\n  - Read\n  - Bash\nmcpInheritance:\n  named:\n    - local-tools\ncustomField:\n  enabled: true\n---\n\nReview the diff.\n";
        let (frontmatter, body) = parse_agent_markdown(source).unwrap();
        let rendered = agent_markdown_from_frontmatter(frontmatter.clone(), &body).unwrap();
        let (round_trip, round_trip_body) = parse_agent_markdown(&rendered).unwrap();
        assert_eq!(round_trip, frontmatter);
        assert_eq!(round_trip_body.trim(), "Review the diff.");
    }

    #[test]
    fn agent_frontmatter_description_edit_preserves_other_schema_values() {
        let source = "---\nname: reviewer\ndescription: Old description\ntools:\n  - Read\n---\n\nReview the diff.\n";
        let (mut frontmatter, body) = parse_agent_markdown(source).unwrap();
        frontmatter["description"] = serde_json::Value::String("Updated description".into());

        let updated = agent_markdown_from_frontmatter(frontmatter, &body).unwrap();
        let (updated_frontmatter, updated_body) = parse_agent_markdown(&updated).unwrap();

        assert_eq!(updated_frontmatter["description"], "Updated description");
        assert_eq!(updated_frontmatter["tools"][0], "Read");
        assert_eq!(updated_body.trim(), "Review the diff.");
    }

    #[test]
    fn malformed_agent_frontmatter_is_rejected() {
        assert!(parse_agent_markdown("---\nname: [\n---\nbody").is_err());
        assert!(parse_agent_markdown("---\nname: missing-end\n").is_err());
        assert!(parse_agent_markdown("# no frontmatter").is_err());
    }

    #[test]
    fn role_prompt_content_uses_agent_home_prompt_file() {
        let root =
            std::env::temp_dir().join(format!("grok-app-role-prompt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();

        let target = managed_role_prompt_file(&root, "researcher", None).unwrap();
        assert_eq!(target, canonical_root.join("prompts").join("researcher.md"));
        assert!(!target.parent().unwrap().exists());

        let prompt_directory = ensure_agent_home_prompt_directory(&root).unwrap();
        assert_eq!(prompt_directory, canonical_root.join("prompts"));
        fs::write(&target, "Research carefully and cite sources.").unwrap();
        assert_eq!(
            read_managed_role_prompt(&root, target.to_str().unwrap()).as_deref(),
            Some("Research carefully and cite sources.")
        );
        assert_eq!(
            managed_role_prompt_file(&root, "researcher", target.to_str()).unwrap(),
            target
        );

        let outside = root.join("outside.md");
        fs::write(&outside, "external prompt").unwrap();
        assert!(read_managed_role_prompt(&root, outside.to_str().unwrap()).is_none());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn create_agent_definition_creates_and_rejects_overwrite() {
        let dir =
            std::env::temp_dir().join(format!("grok-app-agent-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();

        let r1 = create_agent_definition(
            "demo-agent",
            "project",
            Some(project.to_str().unwrap()),
            false,
            "Demo only",
            "Follow the project conventions.",
        )
        .unwrap();
        assert!(r1.created);
        assert!(!r1.overwritten);
        assert_eq!(r1.name, "demo-agent");
        assert_eq!(r1.scope, "project");
        assert!(Path::new(&r1.path).is_file());
        let body = fs::read_to_string(&r1.path).unwrap();
        assert!(body.contains("name: demo-agent"));
        assert!(body.contains("Demo only"));

        let err = create_agent_definition(
            "demo-agent",
            "project",
            Some(project.to_str().unwrap()),
            false,
            "Demo only",
            "Follow the project conventions.",
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "{err}");

        let r2 = create_agent_definition(
            "demo-agent",
            "project",
            Some(project.to_str().unwrap()),
            true,
            "Overwritten",
            "Use the updated instructions.",
        )
        .unwrap();
        assert!(!r2.created);
        assert!(r2.overwritten);
        let body2 = fs::read_to_string(&r2.path).unwrap();
        assert!(body2.contains("Overwritten"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn create_rejects_symlink_destinations_even_when_overwrite_is_confirmed() {
        use std::os::unix::fs::symlink;

        let dir =
            std::env::temp_dir().join(format!("grok-app-agent-symlink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let project = dir.join("project");
        let agents = project.join(".grok").join("agents");
        fs::create_dir_all(&agents).unwrap();
        let outside = dir.join("outside.md");
        fs::write(&outside, "preserve this file").unwrap();
        symlink(&outside, agents.join("review-agent.md")).unwrap();

        let error = create_agent_definition(
            "review-agent",
            "project",
            Some(project.to_str().unwrap()),
            true,
            "Review changes",
            "Stay within the review scope.",
        )
        .unwrap_err();
        assert!(error.contains("symlink"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "preserve this file");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn create_rejects_agents_directory_symlinks_outside_project_scope() {
        use std::os::unix::fs::symlink;

        let dir =
            std::env::temp_dir().join(format!("grok-app-agent-dir-symlink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let project = dir.join("project");
        let grok_dir = project.join(".grok");
        let outside = dir.join("outside");
        fs::create_dir_all(&grok_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, grok_dir.join("agents")).unwrap();

        let error = create_agent_definition(
            "escaped-agent",
            "project",
            Some(project.to_str().unwrap()),
            false,
            "Review changes",
            "Stay within the review scope.",
        )
        .unwrap_err();
        assert!(error.contains("outside the selected scope"));
        assert!(!outside.join("escaped-agent.md").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
