// ── Community PR batch (#63–#91) ─────────────────────────

// from PR #88

/// Timeout for `grok doctor fix <id> --yes` (may rewrite shell rc / config).
const CLI_DOCTOR_FIX_TIMEOUT_SECS: u64 = 30;

// from PR #68

const MCP_DOCTOR_TIMEOUT_SECS: u64 = 90;

// from PR #77

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefDto {
    pub name: String,
    pub path: String,
    /// "project" | "user" | "bundled" | "config"
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMarkdownDefinitionDto {
    pub path: String,
    pub scope: String,
    pub frontmatter: serde_json::Value,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleDefDto {
    pub name: String,
    pub path: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_capability_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogWarningCode {
    DirectoryRead,
    DirectoryTruncated,
    DefinitionRead,
    ConfigRead,
    AgentDefinitionInvalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWarningDto {
    pub source: String,
    pub path: String,
    pub code: CatalogWarningCode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsListResult {
    pub agents: Vec<AgentDefDto>,
    pub roles: Vec<RoleDefDto>,
    pub personas: Vec<PersonaDefDto>,
    pub warnings: Vec<CatalogWarningDto>,
    pub user_agents_dir: String,
    pub project_agents_dir: Option<String>,
    pub bundled_agents_dir: String,
}

// from PR #64

/// Result of creating a linked worktree (`git worktree add`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeAddResult {
    /// Absolute path of the new worktree directory.
    pub path: String,
    /// Sanitized worktree / new-branch name.
    pub name: String,
    /// Optional start-point / commit-ish that was used.
    pub start_point: Option<String>,
    /// Branch checked out after add (best-effort from re-list).
    pub branch: Option<String>,
}

// from PR #83

/// Result of `git worktree prune` (gc / clean stale admin files).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeGcResult {
    /// Whether this was a dry-run (`-n`).
    pub dry_run: bool,
    /// Whether aggressive expire (`now`) was applied via force without max_age.
    pub forced: bool,
    /// Optional `--expire` value that was used.
    pub max_age: Option<String>,
    /// Combined verbose prune output (stdout + stderr, trimmed).
    pub output: String,
    /// Paths marked `prunable` in `git worktree list --porcelain` before prune.
    pub prunable: Vec<String>,
    /// Best-effort count of removals reported in prune output.
    pub pruned_count: usize,
}

// from PR #74

/// Result of `git worktree remove`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRemoveResult {
    /// Absolute path that was removed.
    pub path: String,
    /// Whether `--force` was used.
    pub forced: bool,
}

/// One row from `git diff --name-status` (worktree compare).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCompareEntry {
    /// Status token: A, M, D, R100, C080, …
    pub status: String,
    /// Path (rename/copy destination when old_path is set).
    pub path: String,
    /// Rename/copy source path when present.
    pub old_path: Option<String>,
}

/// Soft-fail result of comparing two worktree paths / refs (`git diff --name-status`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCompareResult {
    pub available: bool,
    pub entries: Vec<GitWorktreeCompareEntry>,
    /// Raw `git diff --name-status` stdout (for client re-parse / honesty).
    pub raw: Option<String>,
    pub reason: Option<String>,
    pub base: String,
    pub other: String,
    /// Resolved left ref (branch or sha).
    pub base_ref: Option<String>,
    /// Resolved right ref (branch or sha).
    pub other_ref: Option<String>,
    /// True when host truncated the entry list (cap honesty).
    pub truncated: bool,
    /// Total entries before host cap (when truncated).
    pub total: usize,
}

// from PR #77

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaDefDto {
    pub name: String,
    pub path: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_isolation: Option<String>,
}

// from PR #77

/// Read-only soft-fail list of discovered Grok Build workflow scripts
/// (`~/.grok/workflows` + project `.grok/workflows` + independent agent-home).
/// Never invents runners; empty dirs return an empty list.
#[tauri::command]
pub async fn workflows_list(
    project_path: Option<String>,
) -> Result<crate::agent_workflows::DiscoverWorkflowsResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let mode = store::load_settings_async().await.session_data_mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::discover_workflows(project.as_deref(), &mode)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Soft-fail headless run of a discovered Grok Build workflow by name.
///
/// There is no top-level `grok workflow` CLI subcommand; the host spawns a
/// short `grok -p` that must call the agent `workflow` tool. Default mode is
/// `validate` (`validate_only: true` smoke). Returns structured ok / reason /
/// redacted truncated log — never panics on CLI missing / timeout.
#[tauri::command]
pub async fn workflows_run(
    app: tauri::AppHandle,
    name: String,
    project_path: Option<String>,
    mode: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<crate::agent_workflows::WorkflowRunResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let mode_owned = mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::run_workflow_with_app(
            app,
            &name,
            project.as_deref(),
            mode_owned.as_deref(),
            timeout_ms,
        )
    })
    .await
    .map_err(|e| format!("workflows_run: {e}"))
}

/// Create a minimal `.rhai` workflow template under user or project scope.
/// Path-scoped write; refuses overwrite unless `force`. Soft-fail via Result.
#[tauri::command]
pub async fn workflows_create(
    name: String,
    scope: Option<String>,
    project_path: Option<String>,
    force: Option<bool>,
) -> Result<crate::agent_workflows::WorkflowCreateResult, String> {
    let scope = scope.unwrap_or_else(|| "user".into());
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::create_workflow_template(
            &name,
            &scope,
            project_path.as_deref(),
            force,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List agent + persona definition files from user / project / bundled scopes.
/// Does not require the CLI binary (pure filesystem discovery under `~/.grok`,
/// active GROK_HOME / agent-home, and optional `{project}/.grok`). Always returns Ok.
#[tauri::command]
pub async fn agents_list(project_path: Option<String>) -> Result<AgentsListResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|path| canonical_saved_workspace_root(Some(path)))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::process_util::user_home();
        let grok = home.join(".grok");
        let user_agents = grok.join("agents");
        let bundled_agents = grok.join("bundled").join("agents");

        let project_agents = project.as_ref().map(|p| {
            std::path::PathBuf::from(p).join(".grok").join("agents")
        });

        let settings = store::load_settings();
        let independent = !settings.session_data_mode.trim().eq_ignore_ascii_case("shared");
        let active_home = if independent {
            crate::paths::agent_home_dir()
        } else {
            grok.clone()
        };
        let active_user_agents = active_home.join("agents");

        let mut warnings = Vec::new();
        let mut agents = Vec::new();
        if let Some(ref dir) = project_agents {
            agents.extend(scan_agent_dir(dir, "project", &mut warnings));
        }
        agents.extend(scan_user_agent_defs(
            &user_agents,
            &active_user_agents,
            independent,
            &mut warnings,
        ));
        agents.extend(scan_agent_dir(&bundled_agents, "bundled", &mut warnings));

        let mut personas = Vec::new();
        let mut roles = Vec::new();
        let config_path = discovery_config_path(&grok, &active_home, independent);
        let configured_definition = if independent {
            discover_configured_agent_definition(&config_path, &mut warnings)
        } else {
            if let Some(project_path) = project.as_deref() {
                let project_config = std::path::Path::new(project_path)
                    .join(".grok")
                    .join("config.toml");
                let role_start = roles.len();
                let persona_start = personas.len();
                let _ = discover_inline_definitions_in_home(
                    &project_config,
                    &mut roles,
                    &mut personas,
                    &mut warnings,
                );
                roles[role_start..]
                    .iter_mut()
                    .for_each(|definition| definition.scope = "project".into());
                personas[persona_start..]
                    .iter_mut()
                    .for_each(|definition| definition.scope = "project".into());
            }
            discover_inline_definitions_in_home(
                &config_path,
                &mut roles,
                &mut personas,
                &mut warnings,
            )
        };
        if let Some(path) = configured_definition.as_deref() {
            add_configured_definition(&mut agents, path);
        }
        let agents = sort_agent_defs(agents);
        let role_directories: Vec<(std::path::PathBuf, &str)> = if independent {
            project
                .as_ref()
                .map(|path| (std::path::PathBuf::from(path).join(".grok").join("roles"), "project"))
                .into_iter()
                .chain([(active_home.join("roles"), "user")])
                .collect()
        } else {
            project
                .as_ref()
                .map(|path| std::path::PathBuf::from(path).join(".grok").join("roles"))
                .into_iter()
                .map(|path| (path, "project"))
                .chain([
                    (grok.join("roles"), "user"),
                    (grok.join("bundled").join("roles"), "bundled"),
                ])
                .collect()
        };
        role_directories.into_iter().for_each(|(dir, scope)| {
            roles.extend(scan_catalog_dir::<RoleDefDto>(
                &dir,
                scope,
                &mut warnings,
                independent,
            ));
        });
        if independent {
            roles.iter_mut().for_each(|role| role.prompt_file = None);
            let project_grok = project
                .as_ref()
                .map(|path| std::path::PathBuf::from(path).join(".grok"));
            if let Some(project_grok) = project_grok.as_deref() {
            apply_role_config_pointers(
                &project_grok.join("config.toml"),
                    "project",
                    &mut roles,
                    &mut warnings,
                );
                append_independent_personas_from_config(
                    &project_grok.join("config.toml"),
                    project_grok,
                    &active_home,
                    "project",
                    &mut personas,
                    &mut warnings,
                );
            }
            apply_role_config_pointers(
                &active_home.join("config.toml"),
                "user",
                &mut roles,
                &mut warnings,
            );
            append_independent_personas_from_config(
                &active_home.join("config.toml"),
                &active_home,
                &active_home,
                "user",
                &mut personas,
                &mut warnings,
            );
            load_managed_role_prompt_content(&mut roles, &active_home, project_grok.as_deref());
        } else {
            let persona_directories = project
                .as_ref()
                .map(|path| std::path::PathBuf::from(path).join(".grok").join("personas"))
                .into_iter()
                .map(|path| (path, "project"))
                .chain([
                    (grok.join("personas"), "user"),
                    (grok.join("bundled").join("personas"), "bundled"),
                ])
                .collect::<Vec<_>>();
            persona_directories.into_iter().for_each(|(dir, scope)| {
                personas.extend(scan_catalog_dir::<PersonaDefDto>(
                    &dir,
                    scope,
                    &mut warnings,
                    false,
                ));
            });
        }
        if independent {
            roles = sort_catalog_by_scope(roles);
            personas = sort_catalog_by_scope(personas);
        } else {
            roles = apply_catalog_precedence(roles);
            personas = apply_catalog_precedence(personas);
        }

        let user_agents_dir = if active_user_agents != user_agents {
            active_user_agents.to_string_lossy().to_string()
        } else {
            user_agents.to_string_lossy().to_string()
        };

        AgentsListResult { agents, roles, personas, warnings,
            user_agents_dir: if independent { active_user_agents.to_string_lossy().to_string() } else { user_agents_dir },
            project_agents_dir: project_agents.as_ref().map(|p| p.to_string_lossy().to_string()),
            bundled_agents_dir: bundled_agents.to_string_lossy().to_string() }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

fn user_definition_directory_open_target(
    active_home: &std::path::Path,
    kind: &str,
) -> Result<(std::path::PathBuf, bool), String> {
    let folder = match kind {
        "agents" | "roles" | "personas" => kind,
        _ => return Err("unknown Agent directory kind".into()),
    };
    let target = active_home.join(folder);
    if target.is_dir() {
        Ok((target, false))
    } else if active_home.is_dir() {
        Ok((active_home.to_path_buf(), true))
    } else {
        Err("agent home directory is unavailable".into())
    }
}

#[tauri::command]
pub async fn agents_open_user_directory(
    kind: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<bool, String> {
    if !matches!(kind.as_str(), "agents" | "roles" | "personas") {
        return Err("unknown Agent directory kind".into());
    }
    let scope = scope.as_deref().unwrap_or("user");
    if scope == "project" {
        let project_root = canonical_saved_workspace_root(project_path.as_deref())?;
        return tauri::async_runtime::spawn_blocking(move || {
            let grok_dir = project_root.join(".grok");
            let target = grok_dir.join(&kind);
            let (path, used_home_fallback) = if target.is_dir()
                && std::fs::canonicalize(&target)
                    .is_ok_and(|resolved| resolved.starts_with(&project_root))
            {
                (target, false)
            } else if grok_dir.is_dir() {
                (grok_dir, true)
            } else {
                (project_root, true)
            };
            crate::process_util::reveal_in_file_manager(&path)?;
            Ok(used_home_fallback)
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    if scope != "user" {
        return Err("unknown Agent scope".into());
    }
    let settings = store::load_settings_async().await;
    let active_home = if is_independent_session_mode(&settings.session_data_mode) {
        crate::paths::agent_home_dir()
    } else {
        crate::process_util::user_home().join(".grok")
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (path, used_home_fallback) =
            user_definition_directory_open_target(&active_home, &kind)?;
        crate::process_util::reveal_in_file_manager(&path)?;
        Ok(used_home_fallback)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn scan_user_agent_defs(
    shared_user_dir: &std::path::Path,
    active_user_dir: &std::path::Path,
    independent: bool,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Vec<AgentDefDto> {
    let user_dir = if independent {
        active_user_dir
    } else {
        shared_user_dir
    };
    scan_agent_dir(user_dir, "user", warnings)
}

const MAX_AGENT_CATALOG_TOML_BYTES: usize = 256 * 1024;

fn scan_catalog_dir<T>(
    dir: &std::path::Path,
    scope: &str,
    warnings: &mut Vec<CatalogWarningDto>,
    include_definition_fields: bool,
) -> Vec<T>
where
    T: From<(String, String, String, Option<String>)> + CatalogEntry,
{
    read_agent_catalog_dir_entries(dir, scope, warnings)
        .into_iter()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file()
                || path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with('.'))
                    .unwrap_or(true)
            {
                return None;
            }
            let extension = path.extension()?.to_str()?.to_ascii_lowercase();
            if extension != "toml" {
                return None;
            }
            let name = path.file_stem()?.to_str()?.to_string();
            if name.is_empty() {
                return None;
            }
            let definition = parse_catalog_toml(&path, scope, warnings)?;
            let description = definition
                .get("description")
                .and_then(toml::Value::as_str)
                .map(str::to_string);
            let mut entry = T::from((
                name,
                path.to_string_lossy().to_string(),
                scope.to_string(),
                description,
            ));
            if include_definition_fields {
                entry.apply_definition(&definition);
            }
            Some(entry)
        })
        .collect()
}

fn parse_catalog_toml(
    path: &std::path::Path,
    source: &str,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Option<toml::Value> {
    use std::io::Read as _;

    let warning_code = if source == "config" {
        CatalogWarningCode::ConfigRead
    } else {
        CatalogWarningCode::DefinitionRead
    };
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            warnings.push(CatalogWarningDto {
                source: source.to_string(),
                path: path.to_string_lossy().to_string(),
                code: warning_code,
            });
            return None;
        }
    };
    let mut bytes = Vec::new();
    if file
        .by_ref()
        .take((MAX_AGENT_CATALOG_TOML_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_AGENT_CATALOG_TOML_BYTES
    {
        warnings.push(CatalogWarningDto {
            source: source.to_string(),
            path: path.to_string_lossy().to_string(),
            code: warning_code,
        });
        return None;
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            warnings.push(CatalogWarningDto {
                source: source.to_string(),
                path: path.to_string_lossy().to_string(),
                code: warning_code,
            });
            return None;
        }
    };
    match toml::from_str(&text) {
        Ok(value) => Some(value),
        Err(_) => {
            warnings.push(CatalogWarningDto {
                source: source.to_string(),
                path: path.to_string_lossy().to_string(),
                code: warning_code,
            });
            None
        }
    }
}

fn discovery_config_path(shared_home: &std::path::Path, active_home: &std::path::Path, independent: bool) -> std::path::PathBuf {
    if independent { active_home.join("config.toml") } else { shared_home.join("config.toml") }
}

impl From<(String, String, String, Option<String>)> for RoleDefDto {
    fn from((name, path, scope, description): (String, String, String, Option<String>)) -> Self { Self { name, path, scope, description, default_capability_mode: None, model: None, prompt_file: None, prompt: None } }
}
impl From<(String, String, String, Option<String>)> for PersonaDefDto {
    fn from((name, path, scope, description): (String, String, String, Option<String>)) -> Self { Self { name, path, scope, description, instructions: None, instructions_file: None, inputs: None, outputs: None, model: None, reasoning_effort: None, default_isolation: None } }
}

fn configured_agent_definition(
    config: &toml::Value,
    path: &std::path::Path,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Option<String> {
    match config
        .get("agent")
        .and_then(|agent| agent.get("definition"))
    {
        None => None,
        Some(toml::Value::String(value)) => validate_configured_definition(value, path, warnings),
        Some(_) => {
            warnings.push(CatalogWarningDto {
                source: "config".into(),
                path: path.to_string_lossy().to_string(),
                code: CatalogWarningCode::AgentDefinitionInvalid,
            });
            None
        }
    }
}

fn discover_configured_agent_definition(
    path: &std::path::Path,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Option<String> {
    let config = parse_catalog_toml(path, "config", warnings)?;
    configured_agent_definition(&config, path, warnings)
}

fn discover_inline_definitions_in_home(
    path: &std::path::Path,
    roles: &mut Vec<RoleDefDto>,
    personas: &mut Vec<PersonaDefDto>,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Option<String> {
    let parsed = parse_catalog_toml(path, "config", warnings)?;
    let configured_definition = configured_agent_definition(&parsed, path, warnings);
    for (key, is_role) in [("roles", true), ("personas", false)] {
        let Some(definitions) = parsed.get("subagents").and_then(|value| value.get(key)).and_then(toml::Value::as_table) else { continue };
        for (name, definition) in definitions {
            let description = definition.get("description").and_then(toml::Value::as_str).map(str::to_string);
            let row = (name.clone(), path.to_string_lossy().to_string(), "config".to_string(), description);
            if is_role {
                let mut role: RoleDefDto = row.into();
                role.default_capability_mode = definition.get("default_capability_mode").and_then(toml::Value::as_str).map(str::to_string);
                role.model = definition.get("model").and_then(toml::Value::as_str).map(str::to_string);
                role.prompt_file = definition.get("prompt_file").and_then(toml::Value::as_str).map(str::to_string);
                roles.push(role);
            } else {
                let mut persona: PersonaDefDto = row.into();
                persona.instructions_file = definition.get("instructions_file").and_then(toml::Value::as_str).map(str::to_string);
                let scope_root = path.parent().unwrap_or_else(|| std::path::Path::new("."));
                let resolved_instruction = persona.instructions_file.as_deref()
                    .and_then(|instruction_file| resolve_config_path(scope_root, instruction_file));
                persona.instructions = definition.get("instructions").and_then(toml::Value::as_str).map(str::to_string)
                    .or_else(|| resolved_instruction.as_deref().and_then(|instruction| read_scoped_text_file(instruction, MAX_AGENT_FIELD_BYTES)));
                if let Some(instruction_path) = resolved_instruction {
                    persona.path = instruction_path.to_string_lossy().to_string();
                }
                persona.inputs = definition.get("inputs").and_then(|value| serde_json::to_value(value).ok());
                persona.outputs = definition.get("outputs").and_then(|value| serde_json::to_value(value).ok());
                persona.model = definition.get("model").and_then(toml::Value::as_str).map(str::to_string);
                persona.reasoning_effort = definition.get("reasoning_effort").and_then(toml::Value::as_str).map(str::to_string);
                persona.default_isolation = definition.get("default_isolation").and_then(toml::Value::as_str).map(str::to_string);
                personas.push(persona);
            }
        }
    }
    configured_definition
}

fn apply_role_config_pointers(
    config_path: &std::path::Path,
    scope: &str,
    roles: &mut [RoleDefDto],
    warnings: &mut Vec<CatalogWarningDto>,
) {
    let Some(config) = parse_catalog_toml(config_path, scope, warnings) else {
        return;
    };
    let Some(definitions) = config
        .get("subagents")
        .and_then(|value| value.get("roles"))
        .and_then(toml::Value::as_table)
    else {
        return;
    };
    definitions.iter().for_each(|(name, definition)| {
        let Some(prompt_file) = definition
            .get("prompt_file")
            .and_then(toml::Value::as_str)
        else {
            return;
        };
        if let Some(role) = roles
            .iter_mut()
            .find(|role| role.name.eq_ignore_ascii_case(name) && role.scope == scope)
        {
            role.prompt_file = Some(prompt_file.to_string());
        }
    });
}

fn append_independent_personas_from_config(
    config_path: &std::path::Path,
    scope_root: &std::path::Path,
    global_home: &std::path::Path,
    scope: &str,
    personas: &mut Vec<PersonaDefDto>,
    warnings: &mut Vec<CatalogWarningDto>,
) {
    let Some(config) = parse_catalog_toml(config_path, scope, warnings) else {
        return;
    };
    let Some(definitions) = config
        .get("subagents")
        .and_then(|value| value.get("personas"))
        .and_then(toml::Value::as_table)
    else {
        return;
    };
    definitions.iter().for_each(|(agent_type, definition)| {
        let instruction_file = definition
            .get("instructions_file")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        let resolved_instruction = instruction_file
            .as_deref()
            .and_then(|path| {
                resolve_scoped_persona_instruction_file(scope_root, path).or_else(|| {
                    std::path::Path::new(path)
                        .is_absolute()
                        .then(|| resolve_scoped_persona_instruction_file(global_home, path))
                        .flatten()
                })
            });
        let instructions_from_file = resolved_instruction
            .as_deref()
            .and_then(|path| read_scoped_text_file(path, MAX_AGENT_FIELD_BYTES));
        if instruction_file.is_some() && instructions_from_file.is_none() {
            warnings.push(CatalogWarningDto {
                source: scope.to_string(),
                path: config_path.to_string_lossy().to_string(),
                code: CatalogWarningCode::DefinitionRead,
            });
        }
        let description = definition
            .get("description")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        let mut persona = PersonaDefDto::from((
            agent_type.clone(),
            resolved_instruction
                .as_deref()
                .unwrap_or(config_path)
                .to_string_lossy()
                .to_string(),
            scope.to_string(),
            description,
        ));
        persona.instructions = instructions_from_file;
        if persona.instructions_file.is_none()
            && definition.get("instructions").and_then(toml::Value::as_str).is_some()
        {
            warnings.push(CatalogWarningDto {
                source: scope.to_string(),
                path: config_path.to_string_lossy().to_string(),
                code: CatalogWarningCode::DefinitionRead,
            });
        }
        persona.instructions_file = instruction_file;
        persona.inputs = definition
            .get("inputs")
            .and_then(|value| serde_json::to_value(value).ok());
        persona.outputs = definition
            .get("outputs")
            .and_then(|value| serde_json::to_value(value).ok());
        persona.model = definition
            .get("model")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        persona.reasoning_effort = definition
            .get("reasoning_effort")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        persona.default_isolation = definition
            .get("default_isolation")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        personas.push(persona);
    });
}

fn resolve_scoped_persona_instruction_file(
    scope_root: &std::path::Path,
    raw_path: &str,
) -> Option<std::path::PathBuf> {
    if raw_path.is_empty() || raw_path.len() > 4096 || raw_path.chars().any(char::is_control) {
        return None;
    }
    let path = std::path::Path::new(raw_path);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else if scope_root.file_name().is_some_and(|name| name == ".grok")
        && path.starts_with(".grok")
    {
        scope_root.parent()?.join(path)
    } else {
        scope_root.join(path)
    };
    let canonical_root = std::fs::canonicalize(scope_root).ok()?;
    let persona_directory = std::fs::canonicalize(canonical_root.join("personas")).ok()?;
    let metadata = std::fs::symlink_metadata(&candidate).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_AGENT_FIELD_BYTES as u64 {
        return None;
    }
    let canonical = std::fs::canonicalize(candidate).ok()?;
    canonical.starts_with(persona_directory).then_some(canonical)
}

fn read_scoped_text_file(path: &std::path::Path, max_bytes: usize) -> Option<String> {
    use std::io::Read as _;
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes as u64 {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(path)
        .ok()?
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= max_bytes).then(|| String::from_utf8(bytes).ok()).flatten()
}

fn load_managed_role_prompt_content(
    roles: &mut [RoleDefDto],
    global_home: &std::path::Path,
    project_grok: Option<&std::path::Path>,
) {
    roles
        .iter_mut()
        .for_each(|role| {
            let root = match role.scope.as_str() {
                "project" => project_grok,
                "user" => Some(global_home),
                _ => None,
            };
            role.prompt = root.and_then(|root| {
                role.prompt_file.as_deref().and_then(|path| {
                    crate::agents_catalog::read_managed_role_prompt(root, path)
                })
            });
        });
}

const MAX_AGENT_DEFINITION_BYTES: u64 = 1024 * 1024;

fn validate_configured_definition(
    configured: &str,
    config_path: &std::path::Path,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Option<String> {
    use std::io::Read as _;

    let value = configured.trim();
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            warnings.push(CatalogWarningDto {
                source: "config".into(),
                path: config_path.to_string_lossy().to_string(),
                code: CatalogWarningCode::AgentDefinitionInvalid,
        });
        return None;
    }
    let expanded = if value == "~" {
        crate::process_util::user_home()
    } else if let Some(rest) = value.strip_prefix("~/") {
        crate::process_util::user_home().join(rest)
    } else {
        std::path::PathBuf::from(value)
    };
    let definition_path = if expanded.is_absolute() {
        expanded
    } else {
        config_path.parent().unwrap_or_else(|| std::path::Path::new(".")).join(expanded)
    };
    let extension = definition_path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    if !matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") {
            warnings.push(CatalogWarningDto {
                source: "config".into(),
                path: config_path.to_string_lossy().to_string(),
                code: CatalogWarningCode::AgentDefinitionInvalid,
        });
        return None;
    }
    match std::fs::metadata(&definition_path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_AGENT_DEFINITION_BYTES => {}
        _ => {
            warnings.push(CatalogWarningDto {
                source: "config".into(),
                path: config_path.to_string_lossy().to_string(),
                code: CatalogWarningCode::AgentDefinitionInvalid,
            });
            return None;
        }
    }
    let mut file = match std::fs::File::open(&definition_path) {
        Ok(file) => file,
        Err(_) => {
            warnings.push(CatalogWarningDto {
                source: "config".into(),
                path: config_path.to_string_lossy().to_string(),
                code: CatalogWarningCode::AgentDefinitionInvalid,
            });
            return None;
        }
    };
    let mut bytes = Vec::new();
    if std::io::Read::by_ref(&mut file)
        .take(MAX_AGENT_DEFINITION_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_AGENT_DEFINITION_BYTES
        || String::from_utf8(bytes).is_err()
    {
        warnings.push(CatalogWarningDto {
            source: "config".into(),
            path: config_path.to_string_lossy().to_string(),
            code: CatalogWarningCode::AgentDefinitionInvalid,
        });
        return None;
    }
    Some(
        std::fs::canonicalize(&definition_path)
            .unwrap_or(definition_path)
            .to_string_lossy()
            .to_string(),
    )
}

fn add_configured_definition(agents: &mut Vec<AgentDefDto>, configured_path: &str) {
    let configured = std::path::Path::new(configured_path);
    if let Some(existing) = agents.iter_mut().find(|agent| {
        std::fs::canonicalize(&agent.path)
            .unwrap_or_else(|_| std::path::PathBuf::from(&agent.path))
            == configured
    }) {
        existing.is_default = true;
        return;
    }
    let Some(name) = configured.file_stem().and_then(|stem| stem.to_str()) else {
        return;
    };
    agents.push(AgentDefDto {
        name: name.to_string(),
        path: configured_path.to_string(),
        scope: "config".into(),
        description: read_agent_description(configured),
        is_default: true,
    });
}

trait CatalogEntry {
    fn name(&self) -> &str;
    fn scope(&self) -> &str;
    fn apply_definition(&mut self, definition: &toml::Value);
}

impl CatalogEntry for RoleDefDto {
    fn name(&self) -> &str {
        &self.name
    }

    fn scope(&self) -> &str {
        &self.scope
    }

    fn apply_definition(&mut self, definition: &toml::Value) {
        self.default_capability_mode = definition
            .get("default_capability_mode")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        self.model = definition
            .get("model")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        self.prompt_file = definition
            .get("prompt_file")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
    }
}

impl CatalogEntry for PersonaDefDto {
    fn name(&self) -> &str {
        &self.name
    }

    fn scope(&self) -> &str {
        &self.scope
    }

    fn apply_definition(&mut self, definition: &toml::Value) {
        self.instructions = definition
            .get("instructions")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        self.instructions_file = definition
            .get("instructions_file")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        self.inputs = definition
            .get("inputs")
            .and_then(|value| serde_json::to_value(value).ok());
        self.outputs = definition
            .get("outputs")
            .and_then(|value| serde_json::to_value(value).ok());
        self.model = definition
            .get("model")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        self.reasoning_effort = definition
            .get("reasoning_effort")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        self.default_isolation = definition
            .get("default_isolation")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
    }
}

fn catalog_scope_rank(scope: &str) -> u8 {
    match scope {
        "config" => 0,
        "project" => 1,
        "user" => 2,
        "bundled" => 3,
        _ => 9,
    }
}

fn sort_catalog_by_scope<T: CatalogEntry>(mut items: Vec<T>) -> Vec<T> {
    items.sort_by(|a, b| {
        catalog_scope_rank(a.scope())
            .cmp(&catalog_scope_rank(b.scope()))
            .then_with(|| a.name().to_ascii_lowercase().cmp(&b.name().to_ascii_lowercase()))
    });
    items
}

fn apply_catalog_precedence<T: CatalogEntry>(items: Vec<T>) -> Vec<T> {
    let items = sort_catalog_by_scope(items);
    let mut result: Vec<T> = Vec::new();
    for item in items {
        if !result.iter().any(|existing| existing.name().eq_ignore_ascii_case(item.name())) { result.push(item); }
    }
    result
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionFileInput {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub project_path: Option<String>,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub instructions_file: Option<String>,
    pub inputs: Option<serde_json::Value>,
    pub outputs: Option<serde_json::Value>,
    pub default_capability_mode: Option<String>,
    pub model: Option<String>,
    pub prompt_file: Option<String>,
    pub prompt: Option<String>,
    pub reasoning_effort: Option<String>,
    pub default_isolation: Option<String>,
}

const MAX_AGENT_TOML_BYTES: usize = MAX_AGENT_CATALOG_TOML_BYTES;
const MAX_AGENT_FIELD_BYTES: usize = 64 * 1024;

fn validate_agent_file_definition_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("invalid role or persona name".into());
    }
    Ok(name)
}

fn validate_agent_form_text<'a>(
    value: Option<&'a str>,
    field: &str,
) -> Result<Option<&'a str>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > MAX_AGENT_FIELD_BYTES || value.contains('\0') {
        return Err(format!("invalid {field}"));
    }
    Ok(Some(value))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMarkdownDefinitionInput {
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub scope: Option<String>,
    pub project_path: Option<String>,
    pub force: Option<bool>,
    pub frontmatter: Option<serde_json::Value>,
    pub path: Option<String>,
}

fn validate_agent_frontmatter_schema(frontmatter: &serde_json::Value) -> Result<(), String> {
    let object = frontmatter
        .as_object()
        .ok_or_else(|| "Agent frontmatter must be an object".to_string())?;
    let name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Agent frontmatter requires a string name".to_string())?;
    crate::agents_catalog::sanitize_agent_file_stem_name(name)?;
    if object
        .get("description")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|description| description.trim().is_empty() || description.len() > 4096)
    {
        return Err("Agent frontmatter requires a description".into());
    }
    if object.contains_key("model") {
        return Err("Agent Markdown does not define a model field".into());
    }
    for (field, allowed) in [
        ("promptMode", &["extend", "full"][..]),
        ("permissionMode", &["default", "acceptEdits", "dontAsk", "plan"][..]),
        ("outputFormat", &["default", "concise"][..]),
    ] {
        if let Some(value) = object.get(field) {
            let Some(value) = value.as_str() else {
                return Err(format!("Agent field `{field}` must be a string"));
            };
            if !allowed.contains(&value) {
                return Err(format!("invalid Agent field `{field}`"));
            }
        }
    }
    for field in ["tools", "disallowedTools", "skills"] {
        if let Some(value) = object.get(field) {
            if !value
                .as_array()
                .is_some_and(|values| values.iter().all(serde_json::Value::is_string))
            {
                return Err(format!("Agent field `{field}` must be a string array"));
            }
        }
    }
    if object.get("agentsMd").is_some_and(|value| !value.is_boolean()) {
        return Err("Agent field `agentsMd` must be a boolean".into());
    }
    for field in ["bash", "toolNameOverrides", "paramNameOverrides", "completionRequirement", "toolConfig"] {
        if object.get(field).is_some_and(|value| !value.is_object()) {
            return Err(format!("Agent field `{field}` must be an object"));
        }
    }
    if object.get("bash").is_some_and(|bash| {
        bash.get("timeoutSecs").is_some_and(|value| !value.is_number())
            || bash.get("outputByteLimit").is_some_and(|value| value.as_u64().is_none())
            || bash.get("cmdPrefix").is_some_and(|value| !value.is_string() && !value.is_null())
    }) {
        return Err("invalid Agent field `bash`".into());
    }
    if object.get("toolNameOverrides").is_some_and(|value| !json_object_values_are_strings(value)) {
        return Err("Agent field `toolNameOverrides` must map strings to strings".into());
    }
    if object.get("paramNameOverrides").is_some_and(|value| {
        value.as_object().is_none_or(|mappings| {
            mappings.values().any(|mapping| !json_object_values_are_strings(mapping))
        })
    }) {
        return Err("Agent field `paramNameOverrides` must map tools to string mappings".into());
    }
    if object.get("completionRequirement").is_some_and(|value| {
        value.get("tool").is_some_and(|tool| !tool.is_string())
            || value.get("reminder").is_some_and(|reminder| !reminder.is_string())
            || value.get("recovery").is_some_and(|recovery| {
                recovery.as_object().is_none()
                    || ["maxRetries", "baseDelayMs", "maxDelayMs"]
                        .iter()
                        .any(|field| recovery.get(field).is_some_and(|number| number.as_u64().is_none()))
            })
    }) {
        return Err("invalid Agent field `completionRequirement`".into());
    }
    if object.get("toolConfig").is_some_and(|value| {
        value.as_object().is_none_or(|tools| {
            tools.values().any(|config| {
                config.as_object().is_none()
                    || config.get("retry").is_some_and(|retry| {
                        retry.as_object().is_none()
                            || ["maxRetries", "baseDelayMs", "maxDelayMs"]
                                .iter()
                                .any(|field| retry.get(field).is_some_and(|number| number.as_u64().is_none()))
                    })
            })
        })
    }) {
        return Err("invalid Agent field `toolConfig`".into());
    }
    if object.get("mcpServers").is_some_and(|value| !value.is_array()) {
        return Err("Agent field `mcpServers` must be an array".into());
    }
    if object.get("mcpServers").and_then(serde_json::Value::as_array)
        .is_some_and(|servers| servers.iter().any(|server| !server.is_object()))
    {
        return Err("Agent field `mcpServers` entries must be objects".into());
    }
    if let Some(inheritance) = object.get("mcpInheritance") {
        match inheritance {
            serde_json::Value::String(value) if matches!(value.as_str(), "all" | "none") => {}
            serde_json::Value::Object(mapping) if mapping.len() == 1 => {
                let (mode, servers) = mapping.iter().next().ok_or_else(|| "invalid mcpInheritance".to_string())?;
                if !matches!(mode.as_str(), "named" | "except")
                    || !servers
                        .as_array()
                        .is_some_and(|values| values.iter().all(serde_json::Value::is_string))
                {
                    return Err("mcpInheritance must be all, none, named, or except".into());
                }
            }
            _ => return Err("mcpInheritance must be all, none, named, or except".into()),
        }
    }
    let encoded = serde_json::to_vec(frontmatter)
        .map_err(|_| "could not validate Agent frontmatter".to_string())?;
    if encoded.len() > 128 * 1024 {
        return Err("Agent frontmatter is too large".into());
    }
    Ok(())
}

fn json_object_values_are_strings(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.values().all(serde_json::Value::is_string)
    })
}

fn has_agent_text(value: Option<&str>) -> bool {
    value.map(str::trim).is_some_and(|value| !value.is_empty())
}

fn read_agent_definition_backup(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read as _;

    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("agent definition path cannot be a symlink".into());
        }
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("could not inspect existing Agent definition".into()),
    };
    if !metadata.is_file() || metadata.len() > MAX_AGENT_DEFINITION_BYTES {
        return Err("existing Agent definition cannot be safely overwritten".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(path)
        .map_err(|_| "could not read existing Agent definition".to_string())?
        .take(MAX_AGENT_DEFINITION_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read existing Agent definition".to_string())?;
    if bytes.len() as u64 > MAX_AGENT_DEFINITION_BYTES {
        return Err("existing Agent definition is too large to overwrite".into());
    }
    Ok(Some(bytes))
}

fn restore_agent_definition_after_config_failure(
    path: &std::path::Path,
    previous_contents: Option<&[u8]>,
    created_by_call: bool,
) -> Result<(), String> {
    match previous_contents {
        Some(contents) => crate::store_lock::write_bytes_atomic(path, contents),
        None if created_by_call => std::fs::remove_file(path)
            .map_err(|_| "could not remove the new Agent definition".to_string()),
        None => Err("cannot restore an overwritten Agent definition without a backup".into()),
    }
}

fn ensure_editable_independent_mode() -> Result<(), String> {
    let mode = store::load_settings().session_data_mode;
    if is_independent_session_mode(&mode) {
        Ok(())
    } else {
        Err("agent settings are read-only in shared mode".into())
    }
}

fn canonical_saved_workspace_root(raw_path: Option<&str>) -> Result<std::path::PathBuf, String> {
    let raw_path = raw_path
        .map(str::trim)
        .filter(|path| !path.is_empty() && !path.chars().any(char::is_control))
        .ok_or_else(|| "a saved workspace is required for project scope".to_string())?;
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|_| "the selected workspace root is unavailable".to_string())?;
    if !canonical.is_dir() {
        return Err("the selected workspace root is unavailable".into());
    }
    let is_saved_primary_root = crate::workspace_store::list_workspaces()
        .iter()
        .flat_map(|workspace| workspace.roots.iter())
        .filter(|root| root.role == crate::workspace_store::WorkspaceRootRole::Primary)
        .any(|root| {
            std::fs::canonicalize(&root.path)
                .is_ok_and(|workspace_root| workspace_root == canonical)
        });
    if !is_saved_primary_root {
        return Err("project scope is limited to saved workspace primary roots".into());
    }
    Ok(canonical)
}

fn edit_agent_home_config<T>(
    edit: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<T, String>,
) -> Result<T, String> {
    ensure_editable_independent_mode()?;
    let config_path = crate::paths::agent_home_dir().join("config.toml");
    edit_toml_file(&config_path, edit)
}

fn edit_toml_file<T>(
    toml_path: &std::path::Path,
    edit: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<T, String>,
) -> Result<T, String> {
    edit_toml_file_with_lock(toml_path, toml_path, edit)
}

fn edit_agent_definition_toml<T>(
    agent_home: &std::path::Path,
    toml_path: &std::path::Path,
    edit: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<T, String>,
) -> Result<T, String> {
    let definitions_lock = agent_home.join(".agent-definitions");
    edit_toml_file_with_lock(&definitions_lock, toml_path, edit)
}

fn edit_toml_file_with_lock<T>(
    lock_target: &std::path::Path,
    toml_path: &std::path::Path,
    edit: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<T, String>,
) -> Result<T, String> {
    use std::io::Read as _;

    let _lock = crate::store_lock::lock_exclusive(lock_target)?;
    let source = match std::fs::File::open(toml_path) {
        Ok(file) => {
            let mut bytes = Vec::with_capacity(4096);
            file.take((MAX_AGENT_TOML_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "could not read TOML file".to_string())?;
            if bytes.len() > MAX_AGENT_TOML_BYTES {
                return Err("TOML file is too large to edit".into());
            }
            String::from_utf8(bytes).map_err(|_| "TOML file is not valid UTF-8".to_string())?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("could not read TOML file".into()),
    };
    let mut document = parse_editable_toml(&source)?;
    let result = edit(&mut document)?;
    let updated = document.to_string();
    if updated.len() > MAX_AGENT_TOML_BYTES {
        return Err("TOML file would exceed the supported size".into());
    }
    if updated != source {
        crate::store_lock::write_bytes_replace(toml_path, updated.as_bytes())?;
    }
    Ok(result)
}

fn user_definition_directory(
    agent_home: &std::path::Path,
    kind: &str,
    create: bool,
) -> Result<std::path::PathBuf, String> {
    let directory_name = match kind {
        "role" => "roles",
        "persona" => "personas",
        _ => return Err("unknown Agent definition kind".into()),
    };
    let canonical_home = std::fs::canonicalize(agent_home)
        .map_err(|_| "agent home directory is unavailable".to_string())?;
    let directory = canonical_home.join(directory_name);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Agent definition directory must be a regular directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("could not inspect Agent definition directory".into()),
    }
    crate::agents_catalog::ensure_agent_dir_within_boundary(&directory, &canonical_home)?;
    if create {
        std::fs::create_dir_all(&directory)
            .map_err(|_| "could not create Agent definition directory".to_string())?;
        crate::agents_catalog::ensure_agent_dir_within_boundary(&directory, &canonical_home)?;
    }
    if directory.is_dir() {
        std::fs::canonicalize(&directory)
            .map_err(|_| "could not resolve Agent definition directory".to_string())
    } else {
        Ok(directory)
    }
}

struct AgentDefinitionScopePaths {
    root: std::path::PathBuf,
    config: std::path::PathBuf,
    label: &'static str,
}

fn resolve_agent_definition_scope(
    agent_home: &std::path::Path,
    scope: &str,
    project_path: Option<&str>,
    create: bool,
) -> Result<AgentDefinitionScopePaths, String> {
    match scope.trim() {
        "" | "user" | "global" => {
            if create && !agent_home.exists() {
                std::fs::create_dir_all(agent_home)
                    .map_err(|_| "could not create active GROK_HOME".to_string())?;
            }
            let root = std::fs::canonicalize(agent_home)
                .map_err(|_| "active GROK_HOME is unavailable".to_string())?;
            if !root.is_dir() {
                return Err("active GROK_HOME is unavailable".into());
            }
            Ok(AgentDefinitionScopePaths {
                config: root.join("config.toml"),
                root,
                label: "user",
            })
        }
        "project" => {
            let workspace_root = canonical_saved_workspace_root(project_path)?;
            let grok_dir = workspace_root.join(".grok");
            match std::fs::symlink_metadata(&grok_dir) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err("workspace .grok must be a regular directory".into());
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                    std::fs::create_dir(&grok_dir)
                        .map_err(|_| "could not create workspace .grok directory".to_string())?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("could not inspect workspace .grok directory".into()),
            }
            let root = if grok_dir.is_dir() {
                std::fs::canonicalize(&grok_dir)
                    .map_err(|_| "could not resolve workspace .grok directory".to_string())?
            } else {
                grok_dir
            };
            if !root.starts_with(&workspace_root) {
                return Err("workspace .grok directory resolves outside the workspace".into());
            }
            Ok(AgentDefinitionScopePaths {
                config: root.join("config.toml"),
                root,
                label: "project",
            })
        }
        _ => Err("unknown Agent scope".into()),
    }
}

fn user_definition_file_path(
    agent_home: &std::path::Path,
    kind: &str,
    name: &str,
    create_directory: bool,
) -> Result<std::path::PathBuf, String> {
    let name = validate_agent_file_definition_name(name)?;
    let directory = user_definition_directory(agent_home, kind, create_directory)?;
    let extension = match kind {
        "role" => "toml",
        "persona" => "md",
        _ => return Err("unknown Agent definition kind".into()),
    };
    if directory.is_dir() {
        let mut warnings = Vec::new();
        let entries = read_agent_catalog_dir_entries(&directory, "user", &mut warnings);
        if warnings
            .iter()
            .any(|warning| matches!(warning.code, CatalogWarningCode::DirectoryTruncated))
        {
            return Err("Agent definition directory is too large to update safely".into());
        }
        if let Some(existing) = entries.into_iter().find_map(|entry| {
            let path = entry.path();
            let has_expected_extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|found| found.eq_ignore_ascii_case(extension));
            let matches_name = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem.eq_ignore_ascii_case(name));
            (has_expected_extension && matches_name).then_some(path)
        }) {
            let metadata = std::fs::symlink_metadata(&existing)
                .map_err(|_| "could not inspect Agent definition file".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Agent definition file must be a regular file".into());
            }
            let canonical = std::fs::canonicalize(&existing)
                .map_err(|_| "could not resolve Agent definition file".to_string())?;
            if !canonical.starts_with(&directory) {
                return Err("Agent definition file resolves outside its selected scope".into());
            }
            return Ok(canonical);
        }
    }
    let target = directory.join(format!("{name}.{extension}"));
    if !create_directory {
        return Err("Agent definition file was not found".into());
    }
    Ok(target)
}

fn save_user_definition_file(
    agent_home: &std::path::Path,
    input: &AgentDefinitionFileInput,
) -> Result<(), String> {
    validate_agent_file_definition(input)?;
    let scope = resolve_agent_definition_scope(
        agent_home,
        &input.scope,
        input.project_path.as_deref(),
        true,
    )?;
    save_user_definition_file_in_scope(agent_home, input, &scope)
}

fn save_user_definition_file_in_scope(
    agent_home: &std::path::Path,
    input: &AgentDefinitionFileInput,
    scope: &AgentDefinitionScopePaths,
) -> Result<(), String> {
    validate_agent_file_definition(input)?;
    if input.kind == "persona" {
        ensure_agent_type_exists(agent_home, scope, &input.name)?;
        edit_toml_file(&scope.config, |_| Ok(()))?;
    } else {
        edit_toml_file(&scope.config, |_| Ok(()))?;
    }
    if input.kind == "role" {
        let definition_path = user_definition_file_path(&scope.root, &input.kind, &input.name, true)?;
        let previous_definition = read_agent_definition_backup(&definition_path)?;
        let mut effective_input = input.clone();
        if input.prompt.as_deref().is_some_and(|prompt| !prompt.trim().is_empty()) {
            effective_input.prompt_file = Some(
                crate::agents_catalog::managed_role_prompt_file(
                    &scope.root,
                    &input.name,
                    input.prompt_file.as_deref(),
                )?
                .to_string_lossy()
                .into_owned(),
            );
        }
        let mut prompt_rollback = None;
        let save_definition = edit_agent_definition_toml(&scope.root, &definition_path, |document| {
            apply_agent_file_definition_with_prompt(
                document,
                &effective_input,
                &scope.root,
                &mut prompt_rollback,
            )
        });
        if let Err(error) = save_definition {
            restore_prompt_rollback(prompt_rollback)?;
            return Err(error);
        }
        let update_config = edit_scoped_config(scope, |document| {
            let role = ensure_subagent_definition_table(document, "roles", &input.name)?;
            set_toml_string(role, "prompt_file", effective_input.prompt_file.as_deref())
        });
        if let Err(error) = update_config {
            restore_agent_definition_after_config_failure(
                &definition_path,
                previous_definition.as_deref(),
                previous_definition.is_none(),
            )?;
            restore_prompt_rollback(prompt_rollback)?;
            return Err(error);
        }
        return Ok(());
    }

    let instructions = validate_agent_form_text(input.instructions.as_deref(), "persona instructions")?
        .ok_or_else(|| "Persona instructions are required".to_string())?;
    let reusable_instruction_file = input
        .instructions_file
        .as_deref()
        .and_then(|path| resolve_config_path(&scope.root, path))
        .filter(|path| {
            path_is_within_directory(&scope.root.join("personas"), path)
                || path_is_within_directory(&agent_home.join("personas"), path)
        })
        .filter(|path| read_scoped_text_file(path, MAX_AGENT_FIELD_BYTES).as_deref() == Some(instructions));
    let (definition_path, reusing_instruction_file) = match reusable_instruction_file {
        Some(path) => (path, true),
        None => (user_definition_file_path(&scope.root, "persona", &input.name, true)?, false),
    };
    let previous_instructions = if reusing_instruction_file {
        None
    } else {
        read_agent_definition_backup(&definition_path)?
    };
    if !reusing_instruction_file {
        crate::agents_catalog::write_agent_definition_file(
            &definition_path,
            instructions.as_bytes(),
            previous_instructions.is_some(),
        )?;
    }
    let instruction_file = definition_path.to_string_lossy().into_owned();
    let update_config = edit_scoped_config(scope, |document| {
        let persona = ensure_subagent_definition_table(document, "personas", &input.name)?;
        apply_persona_config_fields(persona, input, &instruction_file)
    });
    if let Err(error) = update_config {
        if !reusing_instruction_file {
            restore_agent_definition_after_config_failure(
                &definition_path,
                previous_instructions.as_deref(),
                previous_instructions.is_none(),
            )?;
        }
        return Err(error);
    }
    Ok(())
}

fn delete_user_definition_file(
    agent_home: &std::path::Path,
    kind: &str,
    name: &str,
    scope_name: &str,
    project_path: Option<&str>,
) -> Result<(), String> {
    let scope = resolve_agent_definition_scope(agent_home, scope_name, project_path, false)?;
    delete_user_definition_file_in_scope(&scope, kind, name)
}

fn delete_user_definition_file_in_scope(
    scope: &AgentDefinitionScopePaths,
    kind: &str,
    name: &str,
) -> Result<(), String> {
    delete_user_definition_file_in_scope_with_config_sources(scope, kind, name, None)
}

fn delete_user_definition_file_in_scope_with_config_sources(
    scope: &AgentDefinitionScopePaths,
    kind: &str,
    name: &str,
    config_sources_override: Option<&[(std::path::PathBuf, std::path::PathBuf)]>,
) -> Result<(), String> {
    if kind == "persona" {
        let config = edit_toml_file(&scope.config, |document| Ok(document.clone()))?;
        let personas = config
            .get("subagents")
            .and_then(toml_edit::Item::as_table)
            .and_then(|subagents| subagents.get("personas"))
            .and_then(toml_edit::Item::as_table);
        let (persona_key, persona) = personas
            .and_then(|personas| {
                personas.iter().find(|(key, _)| key.eq_ignore_ascii_case(name))
            })
            .ok_or_else(|| "Persona configuration was not found".to_string())?;
        let persona_key = persona_key.to_string();
        let instruction_file = persona
            .as_table()
            .and_then(|persona| persona.get("instructions_file"))
            .and_then(toml_edit::Item::as_str)
            .map(str::to_string);
        let previous_config = read_agent_definition_backup(&scope.config)?;
        edit_scoped_config(scope, |document| {
            remove_subagent_definition(document, "personas", &persona_key);
            Ok(())
        })?;
        if let Some(instruction_file) = instruction_file
            .as_deref()
            .and_then(|path| resolve_config_path(&scope.root, path))
            .filter(|path| path_is_within_directory(&scope.root.join("personas"), path))
        {
            if !persona_instruction_file_is_referenced(&instruction_file, config_sources_override) {
                if let Err(error) = remove_scoped_file(&scope.root, &instruction_file) {
                    restore_agent_definition_after_config_failure(
                        &scope.config,
                        previous_config.as_deref(),
                        previous_config.is_none(),
                    )?;
                    return Err(error);
                }
            }
        }
        return Ok(());
    }
    let path = user_definition_file_path(&scope.root, kind, name, false)?;
    let previous_config = read_agent_definition_backup(&scope.config)?;
    let config = edit_toml_file(&scope.config, |document| Ok(document.clone()))?;
    let role_key = config
        .get("subagents")
        .and_then(toml_edit::Item::as_table)
        .and_then(|subagents| subagents.get("roles"))
        .and_then(toml_edit::Item::as_table)
        .and_then(|roles| roles.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)))
        .map(|(key, _)| key.to_string());
    edit_scoped_config(scope, |document| {
        if let Some(role) = role_key.as_deref().and_then(|role_key| document
            .get_mut("subagents")
            .and_then(toml_edit::Item::as_table_mut)
            .and_then(|subagents| subagents.get_mut("roles"))
            .and_then(toml_edit::Item::as_table_mut)
            .and_then(|roles| roles.get_mut(role_key))
            .and_then(toml_edit::Item::as_table_mut)
        ) {
            role.remove("prompt_file");
        }
        Ok(())
    })?;
    if let Err(error) = remove_scoped_file(&scope.root, &path) {
        restore_agent_definition_after_config_failure(
            &scope.config,
            previous_config.as_deref(),
            previous_config.is_none(),
        )?;
        return Err(error);
    }
    Ok(())
}

fn resolve_config_path(scope_root: &std::path::Path, raw_path: &str) -> Option<std::path::PathBuf> {
    if raw_path.is_empty() || raw_path.len() > 4096 || raw_path.chars().any(char::is_control) {
        return None;
    }
    let raw = std::path::Path::new(raw_path);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else if scope_root.file_name().is_some_and(|name| name == ".grok") && raw.starts_with(".grok") {
        scope_root.parent()?.join(raw)
    } else {
        scope_root.join(raw)
    };
    std::fs::canonicalize(candidate).ok()
}

fn path_is_within_directory(directory: &std::path::Path, path: &std::path::Path) -> bool {
    std::fs::canonicalize(directory)
        .is_ok_and(|canonical_directory| path.starts_with(canonical_directory))
}

fn persona_instruction_file_is_referenced(
    target: &std::path::Path,
    config_sources_override: Option<&[(std::path::PathBuf, std::path::PathBuf)]>,
) -> bool {
    let config_sources = match config_sources_override {
        Some(sources) => sources.to_vec(),
        None => {
            let active_home = crate::paths::agent_home_dir();
            let mut sources = vec![(active_home.join("config.toml"), active_home.clone())];
            crate::workspace_store::list_workspaces()
                .iter()
                .filter_map(|workspace| {
                    workspace
                        .roots
                        .iter()
                        .find(|root| root.role == crate::workspace_store::WorkspaceRootRole::Primary)
                        .map(|root| std::path::PathBuf::from(&root.path).join(".grok"))
                })
                .for_each(|project_grok| {
                    sources.push((project_grok.join("config.toml"), project_grok));
                });
            sources
        }
    };
    config_sources
        .iter()
        .any(|(config_path, scope_root)| {
            if !config_path.is_file() {
                return false;
            }
            let Some(source) = read_scoped_text_file(config_path, MAX_AGENT_TOML_BYTES) else {
                return true;
            };
            let Ok(config) = toml::from_str::<toml::Value>(&source) else {
                return true;
            };
            config
                .get("subagents")
                .and_then(|subagents| subagents.get("personas"))
                .and_then(toml::Value::as_table)
                .is_some_and(|personas| {
                    personas.values().any(|persona| {
                        persona
                            .get("instructions_file")
                            .and_then(toml::Value::as_str)
                            .and_then(|path| resolve_config_path(scope_root, path))
                            .is_some_and(|path| path == target)
                    })
                })
        })
}

fn remove_scoped_file(root: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    let _lock = crate::store_lock::lock_exclusive(&root.join(".agent-definitions"))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Agent definition file was not found".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Agent definition file must be a regular file".into());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "could not resolve Agent definition file".to_string())?;
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|_| "Agent definition scope is unavailable".to_string())?;
    if !canonical.starts_with(canonical_root) {
        return Err("Agent definition file resolves outside its selected scope".into());
    }
    std::fs::remove_file(canonical).map_err(|_| "could not delete Agent definition file".into())
}

fn parse_editable_toml(source: &str) -> Result<toml_edit::DocumentMut, String> {
    if source.len() > MAX_AGENT_TOML_BYTES {
        return Err("TOML file is too large to edit".into());
    }
    if source.trim().is_empty() {
        Ok(toml_edit::DocumentMut::new())
    } else {
        source
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "TOML is invalid; fix it before saving".to_string())
    }
}

fn ensure_toml_table<'a>(
    parent: &'a mut toml_edit::Table,
    key: &str,
) -> Result<&'a mut toml_edit::Table, String> {
    use toml_edit::{Item, Table};

    let item = parent
        .entry(key)
        .or_insert_with(|| Item::Table(Table::new()));
    item.as_table_mut()
        .ok_or_else(|| format!("agent config [{key}] must be a table"))
}

fn config_agent_definition_path(
    path: &str,
    project_path: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let raw_path = std::path::Path::new(path.trim());
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || !raw_path.is_absolute()
        || !raw_path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
    {
        return Err("invalid agent definition path".into());
    }
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|_| "agent definition file is unavailable".to_string())?;
    let allowed = allowed_agent_definition_roots(
        &crate::paths::agent_home_dir().join("agents"),
        project_path,
    )?;
    if !allowed.iter().any(|root| canonical.starts_with(root))
        || !canonical.is_file()
        || std::fs::metadata(&canonical)
            .map(|metadata| metadata.len() > MAX_AGENT_DEFINITION_BYTES)
            .unwrap_or(true)
    {
        return Err("agent definition path is outside an allowed Agent directory".into());
    }
    Ok(canonical)
}

fn allowed_agent_definition_roots(
    user_agents_dir: &std::path::Path,
    project_path: Option<&str>,
) -> Result<Vec<std::path::PathBuf>, String> {
    let mut allowed = std::fs::canonicalize(user_agents_dir)
        .ok()
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(project_path) = project_path.map(str::trim).filter(|path| !path.is_empty()) {
        if project_path.contains('\0')
            || std::path::Path::new(project_path)
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("invalid project path".into());
        }
        if let Ok(project_agents) = std::fs::canonicalize(
            std::path::Path::new(project_path).join(".grok").join("agents"),
        ) {
            allowed.push(project_agents);
        }
    }
    if allowed.is_empty() {
        return Err("no allowed Agent directory is available".into());
    }
    Ok(allowed)
}

fn scoped_agent_definition_path(
    agent_home: &std::path::Path,
    scope: &str,
    project_path: Option<&str>,
    raw_path: &str,
) -> Result<(std::path::PathBuf, &'static str), String> {
    let (directory, label) = match scope {
        "user" | "global" => (agent_home.join("agents"), "user"),
        "project" => (
            canonical_saved_workspace_root(project_path)?.join(".grok").join("agents"),
            "project",
        ),
        _ => return Err("unknown Agent scope".into()),
    };
    let metadata = std::fs::symlink_metadata(raw_path)
        .map_err(|_| "Agent definition file is unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_AGENT_DEFINITION_BYTES {
        return Err("Agent definition path must be a regular Markdown file".into());
    }
    let canonical_directory = std::fs::canonicalize(&directory)
        .map_err(|_| "Agent definition directory is unavailable".to_string())?;
    let canonical_path = std::fs::canonicalize(raw_path)
        .map_err(|_| "Agent definition file is unavailable".to_string())?;
    if !canonical_path.starts_with(canonical_directory)
        || !canonical_path.extension().and_then(|extension| extension.to_str())
            .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown"))
    {
        return Err("Agent definition file is outside the selected scope".into());
    }
    Ok((canonical_path, label))
}

#[tauri::command]
pub async fn agents_read_markdown_definition(
    path: String,
    scope: String,
    project_path: Option<String>,
) -> Result<AgentMarkdownDefinitionDto, String> {
    ensure_editable_independent_mode()?;
    let project_path = project_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| canonical_saved_workspace_root(Some(path)))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());
    let (path, scope) = scoped_agent_definition_path(
        &crate::paths::agent_home_dir(),
        &scope,
        project_path.as_deref(),
        &path,
    )?;
    let content = read_scoped_text_file(&path, MAX_AGENT_DEFINITION_BYTES as usize)
        .ok_or_else(|| "Agent definition file is unavailable".to_string())?;
    let (mut frontmatter, instructions) = crate::agents_catalog::parse_agent_markdown(&content)?;
    if let Some(frontmatter) = frontmatter.as_object_mut() {
        for (old, current) in [("prompt_mode", "promptMode"), ("agents_md", "agentsMd")] {
            if let Some(value) = frontmatter.remove(old) {
                frontmatter.entry(current.to_string()).or_insert(value);
            }
        }
        frontmatter.remove("model");
    }
    Ok(AgentMarkdownDefinitionDto {
        path: path.to_string_lossy().to_string(),
        scope: scope.into(),
        frontmatter,
        instructions,
    })
}

#[tauri::command]
pub async fn agents_create_definition(
    input: AgentMarkdownDefinitionInput,
) -> Result<crate::agents_catalog::AgentDefinitionCreateResult, String> {
    ensure_editable_independent_mode()?;
    let AgentMarkdownDefinitionInput {
        name,
        description,
        instructions,
        scope,
        project_path,
        force,
        frontmatter,
        path,
    } = input;
    let description = validate_agent_form_text(Some(&description), "agent description")?
        .ok_or_else(|| "agent description is required".to_string())?
        .to_string();
    let instructions = validate_agent_form_text(Some(&instructions), "agent instructions")?
        .ok_or_else(|| "agent instructions are required".to_string())?
        .to_string();
    let scope = scope.unwrap_or_else(|| "user".into());
    let force = force.unwrap_or(false);
    let name = name.trim().to_string();
    let project_path = project_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| canonical_saved_workspace_root(Some(path)))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());
    crate::agents_catalog::sanitize_agent_file_stem_name(&name)?;
    let mut frontmatter = frontmatter
        .unwrap_or_else(|| serde_json::json!({
            "promptMode": "full",
            "agentsMd": true,
            "mcpInheritance": "all"
        }))
        .as_object()
        .cloned()
        .ok_or_else(|| "Agent frontmatter must be an object".to_string())?;
    frontmatter.insert("name".into(), serde_json::Value::String(name.clone()));
    frontmatter.insert(
        "description".into(),
        serde_json::Value::String(description.clone()),
    );
    let frontmatter = serde_json::Value::Object(frontmatter);
    validate_agent_frontmatter_schema(&frontmatter)?;
    let markdown = crate::agents_catalog::agent_markdown_from_frontmatter(
        frontmatter,
        &instructions,
    )?;
    crate::agents_catalog::validate_agent_definition_scope(&scope, project_path.as_deref())?;
    let editing_path = path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| {
            scoped_agent_definition_path(
                &crate::paths::agent_home_dir(),
                &scope,
                project_path.as_deref(),
                path,
            )
            .map(|(canonical, _)| canonical)
        })
        .transpose()?;

    tauri::async_runtime::spawn_blocking(move || {
        // 先解析并校验现有配置，再创建 Agent 文件，避免失败时留下文件。
        edit_agent_home_config(|document| {
            if document
                .get("agent")
                .is_some_and(|agent| agent.as_table().is_none())
            {
                return Err("agent config [agent] must be a table".into());
            }
            Ok(())
        })?;
        let (_, target_path, _) = crate::agents_catalog::resolve_agent_definition_target(
            &name,
            &scope,
            project_path.as_deref(),
        )?;
        if let Some(editing_path) = editing_path {
            if std::fs::canonicalize(&target_path).ok().as_deref() != Some(editing_path.as_path()) {
                return Err("Agent name cannot be changed while editing".into());
            }
            read_agent_definition_backup(&editing_path)?
                .ok_or_else(|| "Agent definition file was not found".to_string())?;
            crate::agents_catalog::write_agent_definition_file(
                &editing_path,
                markdown.as_bytes(),
                true,
            )?;
            Ok(crate::agents_catalog::AgentDefinitionCreateResult {
                name,
                path: editing_path.to_string_lossy().to_string(),
                scope: if scope == "project" { "project" } else { "user" }.into(),
                created: false,
                overwritten: true,
            })
        } else {
            let previous_contents = if force {
                read_agent_definition_backup(&target_path)?
            } else {
                None
            };
            let created = crate::agents_catalog::create_agent_markdown_definition(
                &name,
                &scope,
                project_path.as_deref(),
                force,
                markdown,
            )?;
            let path = created.path.clone();
            if let Err(error) = set_agent_definition_path(&path, project_path.as_deref()) {
                if let Err(restore_error) = restore_agent_definition_after_config_failure(
                    std::path::Path::new(&path),
                    previous_contents.as_deref(),
                    created.created,
                ) {
                    tracing::error!(%restore_error, "could not restore Agent file after config write failure");
                    return Err("config save failed and the Agent file could not be restored".into());
                }
                return Err(error);
            }
            Ok(created)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn clear_active_agent_definition_if_matches(
    canonical_target: &std::path::Path,
) -> Result<Option<Vec<u8>>, String> {
    let config_path = crate::paths::agent_home_dir().join("config.toml");
    let previous_config = read_agent_definition_backup(&config_path)?;
    let mut cleared = false;
    edit_agent_home_config(|document| {
        cleared = clear_agent_definition_in_document(document, &config_path, canonical_target)?;
        Ok(())
    })?;
    Ok(cleared.then_some(previous_config.unwrap_or_default()))
}

fn clear_agent_definition_in_document(
    document: &mut toml_edit::DocumentMut,
    config_path: &std::path::Path,
    canonical_target: &std::path::Path,
) -> Result<bool, String> {
    let Some(agent) = document.get_mut("agent") else {
        return Ok(false);
    };
    let agent = agent
        .as_table_mut()
        .ok_or_else(|| "agent config [agent] must be a table".to_string())?;
    let Some(definition) = agent.get("definition").and_then(toml_edit::Item::as_str) else {
        return Ok(false);
    };
    let raw = std::path::Path::new(definition);
    let path = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        config_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(raw)
    };
    if std::fs::canonicalize(path).ok().as_deref() == Some(canonical_target) {
        agent.remove("definition");
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn agents_delete_markdown_definition(
    path: String,
    scope: String,
    project_path: Option<String>,
) -> Result<(), String> {
    ensure_editable_independent_mode()?;
    let project_path = project_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| canonical_saved_workspace_root(Some(path)))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());
    let (target, _) = scoped_agent_definition_path(
        &crate::paths::agent_home_dir(),
        &scope,
        project_path.as_deref(),
        &path,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        read_agent_definition_backup(&target)?
            .ok_or_else(|| "Agent definition file was not found".to_string())?;
        let previous_config = clear_active_agent_definition_if_matches(&target)?;
        if let Err(error) = std::fs::remove_file(&target) {
            if let Some(contents) = previous_config.as_deref() {
                let config_path = crate::paths::agent_home_dir().join("config.toml");
                if let Err(restore_error) = crate::store_lock::write_bytes_atomic(&config_path, contents) {
                    tracing::error!(%restore_error, "could not restore default Agent pointer after delete failure");
                    return Err("Agent delete failed and its config pointer could not be restored".into());
                }
            }
            return Err(format!("could not delete Agent definition: {error}"));
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn set_agent_definition_path(path: &str, project_path: Option<&str>) -> Result<(), String> {
    let canonical = config_agent_definition_path(path, project_path)?;
    edit_agent_home_config(|document| {
        set_agent_definition_in_document(document, &canonical.to_string_lossy())
    })
}

fn set_agent_definition_in_document(
    document: &mut toml_edit::DocumentMut,
    path: &str,
) -> Result<(), String> {
    let agent = ensure_toml_table(document.as_table_mut(), "agent")?;
    agent.insert("definition", toml_edit::value(path));
    Ok(())
}

#[tauri::command]
pub async fn agents_set_default_definition(
    path: String,
    project_path: Option<String>,
) -> Result<(), String> {
    ensure_editable_independent_mode()?;
    let project_path = project_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| canonical_saved_workspace_root(Some(path)))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());
    tauri::async_runtime::spawn_blocking(move || {
        set_agent_definition_path(&path, project_path.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn validate_agent_file_definition(input: &AgentDefinitionFileInput) -> Result<(), String> {
    validate_agent_file_definition_name(&input.name)?;
    if !matches!(input.kind.as_str(), "role" | "persona") {
        return Err("unknown Agent definition kind".into());
    }
    if !matches!(input.scope.as_str(), "" | "user" | "global" | "project") {
        return Err("unknown Agent scope".into());
    }
    for (value, field) in [
        (input.description.as_deref(), "description"),
        (input.instructions.as_deref(), "instructions"),
        (input.instructions_file.as_deref(), "instructions_file"),
        (input.default_capability_mode.as_deref(), "default_capability_mode"),
        (input.model.as_deref(), "model"),
        (input.prompt_file.as_deref(), "prompt_file"),
        (input.prompt.as_deref(), "prompt"),
        (input.reasoning_effort.as_deref(), "reasoning_effort"),
        (input.default_isolation.as_deref(), "default_isolation"),
    ] {
        validate_agent_form_text(value, field)?;
    }
    for (value, field) in [(input.inputs.as_ref(), "inputs"), (input.outputs.as_ref(), "outputs")] {
        if let Some(value) = value {
            let encoded = serde_json::to_vec(value)
                .map_err(|_| format!("invalid Persona {field}"))?;
            if encoded.len() > MAX_AGENT_FIELD_BYTES {
                return Err(format!("Persona {field} are too large"));
            }
            toml::Value::try_from(value.clone())
                .map_err(|_| format!("invalid Persona {field}"))?;
        }
    }
    if input.kind == "role" {
        if !has_agent_text(input.prompt.as_deref()) {
            return Err("Role prompt is required".into());
        }
        if has_agent_text(input.instructions.as_deref())
            || has_agent_text(input.instructions_file.as_deref())
            || input.inputs.is_some()
            || input.outputs.is_some()
            || has_agent_text(input.reasoning_effort.as_deref())
            || has_agent_text(input.default_isolation.as_deref())
        {
            return Err("invalid Persona fields for Role".into());
        }
        if input
            .default_capability_mode
            .as_deref()
            .map(str::trim)
            .filter(|mode| !mode.is_empty())
            .is_some_and(|mode| !matches!(mode, "read-only" | "read-write" | "execute" | "all"))
        {
            return Err("invalid default capability mode".into());
        }
    } else {
        if has_agent_text(input.default_capability_mode.as_deref())
            || has_agent_text(input.prompt_file.as_deref())
            || has_agent_text(input.prompt.as_deref())
        {
            return Err("invalid Role fields for Persona".into());
        }
        if !has_agent_text(input.instructions.as_deref()) {
            return Err("Persona instructions are required".into());
        }
        if input
            .default_isolation
            .as_deref()
            .map(str::trim)
            .filter(|mode| !mode.is_empty())
            .is_some_and(|mode| !matches!(mode, "none" | "worktree"))
        {
            return Err("invalid default isolation".into());
        }
        if input
            .reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|effort| !effort.is_empty())
            .is_some_and(|effort| {
                !matches!(effort, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
            })
        {
            return Err("invalid reasoning effort".into());
        }
    }
    Ok(())
}

fn apply_agent_file_definition(
    document: &mut toml_edit::DocumentMut,
    input: &AgentDefinitionFileInput,
) -> Result<(), String> {
    validate_agent_file_definition(input)?;
    if input.kind != "role" {
        return Err("Persona fields are stored in the scoped config.toml".into());
    }
    let definition = document.as_table_mut();
    [
        ("description", input.description.as_deref()),
        ("default_capability_mode", input.default_capability_mode.as_deref()),
        ("model", input.model.as_deref()),
    ]
    .into_iter()
    .try_for_each(|(key, value_text)| {
        set_toml_string(definition, key, value_text)
    })?;
    definition.remove("prompt_file");
    Ok(())
}

fn set_toml_string(
    table: &mut toml_edit::Table,
    key: &str,
    value_text: Option<&str>,
) -> Result<(), String> {
    use toml_edit::value;

    if let Some(value_text) = value_text.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(item) = table.get_mut(key) {
            let existing = item
                .as_value_mut()
                .ok_or_else(|| format!("Agent definition field `{key}` must be a scalar"))?;
            let decor = existing.decor().clone();
            *existing = toml_edit::Value::from(value_text.to_string());
            *existing.decor_mut() = decor;
        } else {
            table.insert(key, value(value_text));
        }
    } else {
        table.remove(key);
    }
    Ok(())
}

fn ensure_subagent_definition_table<'a>(
    document: &'a mut toml_edit::DocumentMut,
    category: &str,
    agent_type: &str,
) -> Result<&'a mut toml_edit::Table, String> {
    if !matches!(category, "roles" | "personas") {
        return Err("unknown subagent definition category".into());
    }
    let subagents = ensure_toml_table(document.as_table_mut(), "subagents")?;
    let definitions = ensure_toml_table(subagents, category)?;
    ensure_toml_table(definitions, agent_type)
}

fn edit_scoped_config<T>(
    scope: &AgentDefinitionScopePaths,
    edit: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<T, String>,
) -> Result<T, String> {
    edit_toml_file_with_lock(&scope.root.join(".agent-definitions"), &scope.config, edit)
}

fn set_toml_json_value(
    table: &mut toml_edit::Table,
    key: &str,
    value: Option<&serde_json::Value>,
) -> Result<(), String> {
    let Some(value) = value else {
        table.remove(key);
        return Ok(());
    };
    let value = toml::Value::try_from(value.clone())
        .map_err(|_| format!("invalid Persona field `{key}`"))?;
    let mut temporary = toml::Table::new();
    temporary.insert(key.to_string(), value);
    let source = toml::to_string(&temporary)
        .map_err(|_| format!("could not encode Persona field `{key}`"))?;
    let parsed = parse_editable_toml(&source)?;
        let item = parsed
        .get(key)
        .cloned()
        .ok_or_else(|| format!("could not encode Persona field `{key}`"))?;
    if let (Some(existing), Some(replacement)) = (
        table.get_mut(key).and_then(toml_edit::Item::as_value_mut),
        item.as_value(),
    ) {
        let decor = existing.decor().clone();
        *existing = replacement.clone();
        *existing.decor_mut() = decor;
    } else {
        table.insert(key, item);
    }
    Ok(())
}

fn apply_persona_config_fields(
    table: &mut toml_edit::Table,
    input: &AgentDefinitionFileInput,
    instructions_file: &str,
) -> Result<(), String> {
    for (key, value) in [
        ("description", input.description.as_deref()),
        ("instructions_file", Some(instructions_file)),
        ("model", input.model.as_deref()),
        ("reasoning_effort", input.reasoning_effort.as_deref()),
        ("default_isolation", input.default_isolation.as_deref()),
    ] {
        set_toml_string(table, key, value)?;
    }
    table.remove("instructions");
    set_toml_json_value(table, "inputs", input.inputs.as_ref())?;
    set_toml_json_value(table, "outputs", input.outputs.as_ref())
}

fn remove_subagent_definition(
    document: &mut toml_edit::DocumentMut,
    category: &str,
    agent_type: &str,
) {
    document
        .get_mut("subagents")
        .and_then(toml_edit::Item::as_table_mut)
        .and_then(|subagents| subagents.get_mut(category))
        .and_then(toml_edit::Item::as_table_mut)
        .map(|definitions| definitions.remove(agent_type));
}

fn ensure_agent_type_exists(
    agent_home: &std::path::Path,
    scope: &AgentDefinitionScopePaths,
    agent_type: &str,
) -> Result<(), String> {
    let roots = if scope.label == "project" {
        vec![agent_home.to_path_buf(), scope.root.clone()]
    } else {
        vec![scope.root.clone()]
    };
    let mut warnings = Vec::new();
    let exists = roots.iter().any(|root| {
        [
            (root.join("agents"), "md"),
            (root.join("roles"), "toml"),
        ]
        .into_iter()
        .any(|(directory, extension)| {
            read_agent_catalog_dir_entries(&directory, scope.label, &mut warnings)
                .iter()
                .any(|entry| {
                    let path = entry.path();
                    path.extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
                        && path
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .is_some_and(|value| value.eq_ignore_ascii_case(agent_type))
                })
        })
    });
    if warnings
        .iter()
        .any(|warning| matches!(warning.code, CatalogWarningCode::DirectoryTruncated))
    {
        return Err("Agent type catalog is too large to validate safely".into());
    }
    if exists {
        Ok(())
    } else {
        Err("Persona requires an existing Agent or Role type in the selected scope".into())
    }
}

fn copy_persona_association(
    agent_home: &std::path::Path,
    target_agent_type: &str,
    target_scope_name: &str,
    target_project_path: Option<&str>,
    persona_agent_type: Option<&str>,
    persona_scope_name: Option<&str>,
    persona_project_path: Option<&str>,
) -> Result<(), String> {
    validate_agent_file_definition_name(target_agent_type)?;
    let target_scope = resolve_agent_definition_scope(
        agent_home,
        target_scope_name,
        target_project_path,
        true,
    )?;
    ensure_agent_type_exists(agent_home, &target_scope, target_agent_type)?;
    let source_scope = if let Some(persona_agent_type) = persona_agent_type
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        validate_agent_file_definition_name(persona_agent_type)?;
        let persona_scope_name = persona_scope_name
            .ok_or_else(|| "Persona scope is required".to_string())?;
        if target_scope.label == "user" && persona_scope_name != "user" {
            return Err("Global scope can only use Global Personas".into());
        }
        if !matches!(persona_scope_name, "user" | "project") {
            return Err("unknown Persona scope".into());
        }
        let source_scope = resolve_agent_definition_scope(
            agent_home,
            persona_scope_name,
            persona_project_path,
            false,
        )?;
        if source_scope.label == "project"
            && target_scope.label == "project"
            && source_scope.root != target_scope.root
        {
            return Err("Project Personas are limited to the selected workspace".into());
        }
        Some((source_scope, persona_agent_type.to_string()))
    } else {
        None
    };
    copy_persona_config_block(
        &target_scope,
        target_agent_type,
        source_scope.as_ref().map(|(scope, name)| (scope, name.as_str())),
    )
}

fn copy_persona_config_block(
    target_scope: &AgentDefinitionScopePaths,
    target_agent_type: &str,
    source: Option<(&AgentDefinitionScopePaths, &str)>,
) -> Result<(), String> {
    let persona_table = if let Some((source_scope, persona_agent_type)) = source {
        let source_document = edit_toml_file(&source_scope.config, |document| Ok(document.clone()))?;
        Some(
            source_document
                .get("subagents")
                .and_then(toml_edit::Item::as_table)
                .and_then(|subagents| subagents.get("personas"))
                .and_then(toml_edit::Item::as_table)
                .and_then(|personas| personas.get(persona_agent_type))
                .and_then(toml_edit::Item::as_table)
                .cloned()
                .ok_or_else(|| "selected Persona is no longer available".to_string())?,
        )
    } else {
        None
    };
    edit_scoped_config(target_scope, |document| {
        if let Some(persona_table) = persona_table {
            let subagents = ensure_toml_table(document.as_table_mut(), "subagents")?;
            let personas = ensure_toml_table(subagents, "personas")?;
            personas.insert(target_agent_type, toml_edit::Item::Table(persona_table));
        } else {
            remove_subagent_definition(document, "personas", target_agent_type);
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn agents_apply_persona(
    target_agent_type: String,
    target_scope: String,
    target_project_path: Option<String>,
    persona_agent_type: Option<String>,
    persona_scope: Option<String>,
    persona_project_path: Option<String>,
) -> Result<(), String> {
    ensure_editable_independent_mode()?;
    let normalize_project = |path: Option<String>| -> Result<Option<String>, String> {
        path.as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|path| canonical_saved_workspace_root(Some(path)))
            .transpose()
            .map(|path| path.map(|path| path.to_string_lossy().to_string()))
    };
    let target_project_path = normalize_project(target_project_path)?;
    let persona_project_path = normalize_project(persona_project_path)?;
    let agent_home = crate::paths::agent_home_dir();
    tauri::async_runtime::spawn_blocking(move || {
        copy_persona_association(
            &agent_home,
            &target_agent_type,
            &target_scope,
            target_project_path.as_deref(),
            persona_agent_type.as_deref(),
            persona_scope.as_deref(),
            persona_project_path.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn restore_prompt_rollback(rollback: Option<RolePromptFileRollback>) -> Result<(), String> {
    if let Some(rollback) = rollback {
        restore_agent_definition_after_config_failure(
            &rollback.path,
            rollback.previous_contents.as_deref(),
            rollback.created_by_call,
        )
        .map_err(|_| "could not restore the managed instruction file".to_string())?;
    }
    Ok(())
}

struct RolePromptFileRollback {
    path: std::path::PathBuf,
    previous_contents: Option<Vec<u8>>,
    created_by_call: bool,
}

fn apply_agent_file_definition_with_prompt(
    document: &mut toml_edit::DocumentMut,
    input: &AgentDefinitionFileInput,
    agent_home: &std::path::Path,
    rollback: &mut Option<RolePromptFileRollback>,
) -> Result<(), String> {
    validate_agent_file_definition(input)?;
    if input.kind != "role" {
        return Err("Role prompt files cannot be applied to Personas".into());
    }
    let mut effective_input = input.clone();
    let prompt = if input.kind == "role" {
        input
            .prompt
            .as_deref()
            .filter(|prompt| !prompt.trim().is_empty())
    } else {
        None
    };

    if input.kind == "role" {
        if prompt.is_some() {
            let path = crate::agents_catalog::managed_role_prompt_file(
                agent_home,
                &input.name,
                input.prompt_file.as_deref(),
            )?;
            effective_input.prompt_file = Some(path.to_string_lossy().into_owned());
        } else if input.prompt.is_some() {
            effective_input.prompt_file = None;
        }
    }

    apply_agent_file_definition(document, &effective_input)?;
    if let Some(prompt) = prompt {
        let path = std::path::PathBuf::from(
            effective_input
                .prompt_file
                .as_deref()
                .ok_or_else(|| "Role prompt path is unavailable".to_string())?,
        );
        let previous_contents = read_agent_definition_backup(&path)?;
        let prompt_directory =
            crate::agents_catalog::ensure_agent_home_prompt_directory(agent_home)?;
        if path.parent() != Some(prompt_directory.as_path()) {
            return Err("Role prompt path is outside agent-home/prompts".into());
        }
        let created_by_call = previous_contents.is_none();
        crate::agents_catalog::write_agent_definition_file(
            &path,
            prompt.as_bytes(),
            !created_by_call,
        )?;
        *rollback = Some(RolePromptFileRollback {
            path,
            previous_contents,
            created_by_call,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn agents_upsert_file_definition(
    input: AgentDefinitionFileInput,
) -> Result<(), String> {
    ensure_editable_independent_mode()?;
    validate_agent_file_definition(&input)?;
    let agent_home = crate::paths::agent_home_dir();
    tauri::async_runtime::spawn_blocking(move || {
        save_user_definition_file(&agent_home, &input)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn agents_delete_file_definition(
    kind: String,
    name: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<(), String> {
    ensure_editable_independent_mode()?;
    let agent_home = crate::paths::agent_home_dir();
    let scope = scope.unwrap_or_else(|| "user".into());
    tauri::async_runtime::spawn_blocking(move || {
        delete_user_definition_file(&agent_home, &kind, &name, &scope, project_path.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn is_independent_session_mode(session_data_mode: &str) -> bool {
    session_data_mode.trim().eq_ignore_ascii_case("independent")
}

// from PR #83

/// Build argv for `git worktree prune` (no binary name; caller prefixes `git`).
///
/// Layout: `[-C <project>] worktree prune -v [--dry-run] [--expire <age>]`
///
/// - `dry_run` → `--dry-run` (report only)
/// - `max_age` → `--expire <max_age>` when set
/// - `force` without `max_age` → `--expire now` (prune all stale admin files now)
/// - always `-v` so dry-run preview has useful lines
///
/// Pure; unit-tested. Never goes through a shell.
pub fn build_worktree_gc_args(
    project: &str,
    dry_run: bool,
    force: bool,
    max_age: Option<&str>,
) -> Result<Vec<String>, String> {
    let project = normalize_fs_path(project);
    if project.is_empty() {
        return Err("empty path".into());
    }
    if project.starts_with('-') {
        return Err("invalid project path".into());
    }
    let expire = match sanitize_worktree_gc_max_age(max_age)? {
        Some(age) => Some(age),
        None if force => Some("now".into()),
        None => None,
    };

    let mut args: Vec<String> = vec![
        "-C".into(),
        project,
        "worktree".into(),
        "prune".into(),
        "-v".into(),
    ];
    if dry_run {
        args.push("--dry-run".into());
    }
    if let Some(age) = expire {
        args.push("--expire".into());
        args.push(age);
    }
    Ok(args)
}

// from PR #64

/// Path placement for new linked worktrees (`cli` default, or `sibling`).
pub fn normalize_worktree_layout(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.eq_ignore_ascii_case("sibling") => "sibling",
        _ => "cli",
    }
}

/// Shared CLI GROK_HOME (`~/.grok`) used for worktree placement.
/// Matches Grok Build 0.2.x `~/.grok/worktrees/<repo>/…` regardless of
/// App independent agent-home (git worktrees are filesystem layout, not session store).
pub fn shared_cli_grok_home() -> std::path::PathBuf {
    crate::process_util::user_home().join(".grok")
}

/// CLI worktrees root: `{GROK_HOME}/worktrees`.
pub fn cli_worktrees_home(grok_home: &std::path::Path) -> std::path::PathBuf {
    grok_home.join("worktrees")
}

/// Repo folder slug for CLI layout (main worktree basename).
pub fn worktree_repo_slug(main_worktree_path: &str) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let main_pb = std::path::PathBuf::from(&main);
    main_pb
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "cannot derive repo folder name".to_string())
}

/// CLI-aligned path: `{GROK_HOME}/worktrees/<main_basename>/<name>`.
///
/// Example: grok_home `~/.grok`, main `/Users/me/Code/oss-grok-app`, name `feat`
/// → `~/.grok/worktrees/oss-grok-app/feat`.
///
/// Matches Grok Build 0.2.x (`grok --worktree=…`, `grok worktree list`).
pub fn build_worktree_cli_path(
    main_worktree_path: &str,
    name: &str,
    grok_home: &std::path::Path,
) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let safe = sanitize_worktree_name(name)?;
    let slug = worktree_repo_slug(&main)?;
    let path = cli_worktrees_home(grok_home).join(slug).join(safe);
    let s = path.to_string_lossy().replace('\\', "/");
    let s = normalize_fs_path(&s);
    if s == main || s.is_empty() {
        return Err("resolved worktree path is invalid".into());
    }
    Ok(s)
}

/// Build sibling worktree path: `<parent>/<main_basename>-<name>`.
///
/// Example: main `/Users/me/repo` + name `feat` → `/Users/me/repo-feat`.
///
/// Optional alternative to CLI home layout — matches common
/// `git worktree add ../repo-feat` practice.
pub fn build_worktree_sibling_path(main_worktree_path: &str, name: &str) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let safe = sanitize_worktree_name(name)?;
    let main_pb = std::path::PathBuf::from(&main);
    let base = main_pb
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "cannot derive repo folder name".to_string())?;
    let parent = main_pb
        .parent()
        .ok_or_else(|| "main worktree has no parent directory".to_string())?;
    let dir_name = format!("{base}-{safe}");
    let path = parent.join(dir_name);
    let s = path.to_string_lossy().replace('\\', "/");
    let s = normalize_fs_path(&s);
    if s == main || s.is_empty() {
        return Err("resolved worktree path is invalid".into());
    }
    Ok(s)
}

/// Resolve create path for layout (`cli` default, or `sibling`).
pub fn build_worktree_path_for_layout(
    layout: Option<&str>,
    main_worktree_path: &str,
    name: &str,
) -> Result<String, String> {
    match normalize_worktree_layout(layout) {
        "sibling" => build_worktree_sibling_path(main_worktree_path, name),
        _ => build_worktree_cli_path(main_worktree_path, name, &shared_cli_grok_home()),
    }
}

// from PR #88

/// Apply a CLI automatic remediation: `grok doctor fix <id> --yes`.
/// Returns redacted stdout/stderr; never throws on non-zero exit (ok=false).
#[tauri::command]
pub async fn cli_doctor_fix(id: String) -> Result<serde_json::Value, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("doctor fix id required".into());
    }
    if !is_safe_doctor_fix_id(&id) {
        return Err(format!("invalid doctor fix id: {id}"));
    }

    let id_for_cmd = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["doctor", "fix", &id_for_cmd, "--yes"],
            CLI_DOCTOR_FIX_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| format!("doctor fix worker panicked: {e}"))?;

    match result {
        Ok((stdout, stderr, exit_ok)) => Ok(serde_json::json!({
            "ok": exit_ok,
            "id": id,
            "stdout": redact_doctor_fix_output(&stdout, 2000),
            "stderr": redact_doctor_fix_output(&stderr, 800),
            "exitOk": exit_ok,
        })),
        Err(e) => {
            // Missing CLI / timeout — surface as structured failure, not panic.
            Ok(serde_json::json!({
                "ok": false,
                "id": id,
                "stdout": "",
                "stderr": redact_doctor_fix_output(&e, 400),
                "exitOk": false,
                "error": redact_doctor_fix_output(&e, 400),
            }))
        }
    }
}

// from PR #63

/// Run resolved `grok update --check --json` and return a typed DTO.
///
/// Also attaches App compatibility fields (#1009): current App version, absolute
/// floor, and a best-effort GitHub App-update probe so the UI can warn before
/// installing a newer CLI while the App bundle is behind.
#[tauri::command]
pub async fn cli_update_check() -> Result<crate::cli_update::CliUpdateCheck, String> {
    let mut dto = tauri::async_runtime::spawn_blocking(|| {
        let settings = store::load_settings();
        crate::cli_update::check_cli_update(settings.manual_cli_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;

    let app_ver = env!("CARGO_PKG_VERSION");
    let (latest_app, app_update_available) =
        match crate::app_update::check_app_update().await {
            Ok(check) => (Some(check.latest_version), Some(check.update_available)),
            Err(_) => (None, None),
        };
    crate::cli_update::enrich_cli_update_check_app_compat(
        &mut dto,
        app_ver,
        latest_app.as_deref(),
        app_update_available,
    );
    Ok(dto)
}

// from PR #63 / channel UX (CLI ≥ 0.2.117)

/// Install CLI update / switch channel / pin version.
///
/// Optional `channel` (`stable`|`alpha`), `version` pin, and `force` reinstall.
/// Channel switch and version pin are mutually exclusive; unknown channels error
/// (never invented). Plain update still falls back to App install trust-chain.
///
/// When the App is behind (#1009), pass `acknowledge_app_behind: true` after the
/// UI warning; otherwise Host soft-fails with an `APP_BEHIND:` error.
#[tauri::command]
pub async fn cli_update_install(
    app: tauri::AppHandle,
    channel: Option<String>,
    version: Option<String>,
    force: Option<bool>,
    acknowledge_app_behind: Option<bool>,
) -> Result<crate::cli_install::CliInstallResult, String> {
    let opts = crate::cli_update::CliUpdateInstallOpts {
        channel,
        version,
        force: force.unwrap_or(false),
        acknowledge_app_behind: acknowledge_app_behind.unwrap_or(false),
    };
    crate::cli_update::install_cli_update(app, opts).await
}

/// Recycle every warm agent process so the next send spawns fresh binaries.
/// Used after a CLI upgrade — running children keep executing the old image
/// until restarted (NEW-05). Chat history is untouched; sessions reconnect
/// lazily on the next send.
#[tauri::command]
pub async fn agents_recycle_all(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<(), String> {
    mgr.recycle_all_agents(&app, "cli_upgrade").await;
    Ok(())
}

// from PR #83

/// Count removal-like lines in `git worktree prune -v` output (best-effort).
pub fn count_worktree_prune_lines(output: &str) -> usize {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            lower.contains("remov") || lower.contains("prun") || lower.starts_with("would ")
        })
        .count()
}

// from PR #77

/// Best-effort YAML frontmatter `description:` (first line / plain value).
fn extract_agent_description_from_content(content: &str) -> Option<String> {
    if let Ok((frontmatter, _)) = crate::agents_catalog::parse_agent_markdown(content) {
        if let Some(description) = frontmatter
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|description| !description.is_empty())
        {
            return Some(description.to_string());
        }
    }
    if !content.starts_with("---") {
        return None;
    }
    let rest = &content[3..];
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    for (i, line) in fm.lines().enumerate() {
        let trimmed = line.trim_start();
        if let Some(val) = trimmed.strip_prefix("description:") {
            let v = val.trim();
            if v == ">" || v == "|" || v == ">-" || v == "|-" {
                // Folded block: first non-empty indented line after this one.
                for next in fm.lines().skip(i + 1) {
                    if next.starts_with(' ') || next.starts_with('\t') {
                        let t = next.trim();
                        if !t.is_empty() {
                            return Some(t.to_string());
                        }
                    } else if !next.trim().is_empty() {
                        break;
                    }
                }
                return None;
            }
            if v.is_empty() {
                return None;
            }
            let unquoted = v
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                .unwrap_or(v);
            let cleaned = unquoted.split_whitespace().collect::<Vec<_>>().join(" ");
            if cleaned.is_empty() {
                return None;
            }
            return Some(cleaned);
        }
    }
    None
}

// from PR #64

/// Create a linked git worktree, then return its path.
///
/// Default layout (`cli` / omitted): `{GROK_HOME}/worktrees/<repo>/<name>`
/// aligned with Grok Build 0.2.x (`grok --worktree=…`).
/// Optional `layout = "sibling"`: `<parent>/<main_basename>-<name>`.
///
/// Args are passed to `git` as an argv array (no shell) to avoid injection.
/// - Without `start_point`: `git worktree add -b <name> <path>` (branch from HEAD).
/// - With `start_point`: `git worktree add -b <name> <path> <start_point>`.
#[tauri::command]
pub async fn git_worktree_add(
    project_path: String,
    name: String,
    start_point: Option<String>,
    layout: Option<String>,
) -> Result<GitWorktreeAddResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let safe_name = sanitize_worktree_name(&name)?;
    let start = sanitize_worktree_ref(start_point.as_deref())?;
    let layout_kind = normalize_worktree_layout(layout.as_deref());

    // Worktree add materializes a full checkout (spawn + disk-heavy) — the
    // blocking pool keeps it from stalling the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        git_worktree_add_blocking(project, safe_name, start, layout_kind)
    })
    .await
    .map_err(|e| format!("git worktree add worker panicked: {e}"))?
}

fn git_worktree_add_blocking(
    project: String,
    safe_name: String,
    start: Option<String>,
    layout_kind: &'static str,
) -> Result<GitWorktreeAddResult, String> {
    // Resolve main worktree path (first porcelain entry) for path placement.
    let list_out = crate::process_util::command("git")
        .args(["-C", &project, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !list_out.status.success() {
        let err = String::from_utf8_lossy(&list_out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git worktree list failed".into()
        } else {
            err.chars().take(200).collect()
        });
    }
    let listed = parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout));
    let main_path = listed
        .first()
        .map(|w| w.path.clone())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "could not resolve main worktree path".to_string())?;

    let target = build_worktree_path_for_layout(Some(layout_kind), &main_path, &safe_name)?;
    let target_pb = std::path::PathBuf::from(&target);
    if target_pb.exists() {
        return Err(format!("path already exists: {target}"));
    }
    // Refuse if already registered as a worktree.
    if listed.iter().any(|w| {
        let p = normalize_fs_path(&w.path);
        p.eq_ignore_ascii_case(&target) || p == target
    }) {
        return Err(format!("worktree already registered: {target}"));
    }

    // CLI layout nests under ~/.grok/worktrees/<repo>/ — ensure parents exist.
    if let Some(parent) = target_pb.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("could not create worktree parent {}: {e}", parent.display())
        })?;
    }

    // Safe argv — never go through a shell.
    // `git worktree add -b <name> <path> [start_point]`
    let mut args: Vec<String> = vec![
        "-C".into(),
        project.clone(),
        "worktree".into(),
        "add".into(),
        "-b".into(),
        safe_name.clone(),
        target.clone(),
    ];
    if let Some(ref sp) = start {
        args.push(sp.clone());
    }

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree add failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    // Best-effort: re-list to pick up branch field for the new path.
    let branch = {
        let re = crate::process_util::command("git")
            .args(["-C", &project, "worktree", "list", "--porcelain"])
            .output()
            .ok();
        re.and_then(|o| {
            if !o.status.success() {
                return None;
            }
            let list = parse_worktree_porcelain(&String::from_utf8_lossy(&o.stdout));
            list.into_iter()
                .find(|w| {
                    let p = normalize_fs_path(&w.path);
                    p.eq_ignore_ascii_case(&target) || p == target
                })
                .and_then(|w| w.branch)
        })
        .or_else(|| Some(safe_name.clone()))
    };

    Ok(GitWorktreeAddResult {
        path: target,
        name: safe_name,
        start_point: start,
        branch,
    })
}

// from PR #83

/// Garbage-collect stale git worktree administrative files via `git worktree prune`.
///
/// Safe argv only (no shell). Soft-fails on missing git / non-repo with an Err.
/// When `dry_run` is true, nothing is deleted (`--dry-run`).
/// Optional `force` maps to `--expire now` when `max_age` is unset.
/// Optional `max_age` maps to `--expire <max_age>`.
#[tauri::command]
pub async fn git_worktree_gc(
    project_path: String,
    dry_run: bool,
    force: Option<bool>,
    max_age: Option<String>,
) -> Result<GitWorktreeGcResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let forced = force.unwrap_or(false);
    let age = sanitize_worktree_gc_max_age(max_age.as_deref())?;

    // Prune scans + removes admin files across the repo — blocking pool.
    tauri::async_runtime::spawn_blocking(move || {
        git_worktree_gc_blocking(project, dry_run, forced, age)
    })
    .await
    .map_err(|e| format!("git worktree gc worker panicked: {e}"))?
}

fn git_worktree_gc_blocking(
    project: String,
    dry_run: bool,
    forced: bool,
    age: Option<String>,
) -> Result<GitWorktreeGcResult, String> {
    // Snapshot prunable entries before prune for UI preview / summary.
    let prunable = {
        let list_out = crate::process_util::command("git")
            .args(["-C", &project, "worktree", "list", "--porcelain"])
            .output()
            .map_err(|e| e.to_string())?;
        if list_out.status.success() {
            parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout))
                .into_iter()
                .filter(|w| w.prunable)
                .map(|w| w.path)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        }
    };

    let args = build_worktree_gc_args(
        &project,
        dry_run,
        forced,
        age.as_deref(),
    )?;

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree prune failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    // prune -v writes progress to stderr on some git versions, stdout on others.
    let mut combined = String::new();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.trim().is_empty() {
        combined.push_str(stdout.trim());
    }
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(stderr.trim());
    }
    // Prefer verbose prune lines; fall back to porcelain prunable count on dry-run.
    let mut pruned_count = count_worktree_prune_lines(&combined);
    if pruned_count == 0 && !prunable.is_empty() {
        pruned_count = prunable.len();
    }

    let used_expire = match &age {
        Some(a) => Some(a.clone()),
        None if forced => Some("now".into()),
        None => None,
    };

    Ok(GitWorktreeGcResult {
        dry_run,
        forced,
        max_age: used_expire,
        output: combined.chars().take(4000).collect(),
        prunable,
        pruned_count,
    })
}

// from PR #74

/// Remove a linked git worktree via `git worktree remove` (argv only, no shell).
///
/// Refuses the main worktree. Optional `force` maps to `--force` (dirty / locked).
#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    force: Option<bool>,
) -> Result<GitWorktreeRemoveResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let target = normalize_fs_path(&worktree_path);
    if target.is_empty() {
        return Err("empty worktree path".into());
    }
    // Disallow option-like paths so a crafted path cannot become a git flag.
    if target.starts_with('-') {
        return Err("invalid worktree path".into());
    }

    // `git worktree remove` deletes a full checkout tree — blocking pool.
    tauri::async_runtime::spawn_blocking(move || {
        git_worktree_remove_blocking(project, target, force.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("git worktree remove worker panicked: {e}"))?
}

fn git_worktree_remove_blocking(
    project: String,
    target: String,
    forced: bool,
) -> Result<GitWorktreeRemoveResult, String> {
    let list_out = crate::process_util::command("git")
        .args(["-C", &project, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !list_out.status.success() {
        let err = String::from_utf8_lossy(&list_out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git worktree list failed".into()
        } else {
            err.chars().take(200).collect()
        });
    }
    let listed = parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout));
    if listed.is_empty() {
        return Err("no worktrees found".into());
    }

    refuse_remove_main_worktree(&listed, &target)?;

    let registered = listed.iter().any(|w| worktree_paths_equal(&w.path, &target));
    if !registered {
        return Err("worktree not registered for this repository".into());
    }

    // Use the path as listed by git (preserves real casing / form).
    let remove_path = listed
        .iter()
        .find(|w| worktree_paths_equal(&w.path, &target))
        .map(|w| w.path.clone())
        .unwrap_or(target.clone());

    // Safe argv — never go through a shell.
    // `git worktree remove [--force] <path>`
    let mut args: Vec<String> = vec![
        "-C".into(),
        project,
        "worktree".into(),
        "remove".into(),
    ];
    if forced {
        args.push("--force".into());
    }
    args.push(remove_path.clone());

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree remove failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    Ok(GitWorktreeRemoveResult {
        path: remove_path,
        forced,
    })
}

fn probe_binary_on_path(bin: &str) -> bool {
    let mut cmd = crate::process_util::command(bin);
    if let Some(path_env) = crate::process_util::enriched_path_env() {
        cmd.env("PATH", path_env);
    }
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn apply_ship_process_env(cmd: &mut std::process::Command) {
    if let Some(path_env) = crate::process_util::enriched_path_env() {
        cmd.env("PATH", path_env);
    }
    // `gh pr create` stdout is parsed for the PR URL — keep it free of ANSI.
    crate::process_util::apply_no_color_env_std(cmd);
    #[cfg(unix)]
    {
        if std::path::Path::new("/usr/bin/ssh").exists() {
            cmd.env("GIT_SSH_COMMAND", "/usr/bin/ssh");
        }
    }
}

#[cfg(test)]
mod agents_catalog_tests {
    use super::*;
    use std::path::PathBuf;

    struct TempCatalogDir(PathBuf);

    impl TempCatalogDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("grok-agent-catalog-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl std::ops::Deref for TempCatalogDir {
        type Target = std::path::Path;
        fn deref(&self) -> &Self::Target { &self.0 }
    }

    impl Drop for TempCatalogDir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn shared_mode_disallows_agent_edits() {
        assert!(!is_independent_session_mode("shared"));
        assert!(!is_independent_session_mode(" Shared "));
        assert!(is_independent_session_mode("independent"));
        assert!(!is_independent_session_mode("unknown"));
    }

    #[test]
    fn project_agent_directory_is_allowed_without_user_agent_directory() {
        let root = TempCatalogDir::new();
        let project = root.join("project");
        let project_agents = project.join(".grok").join("agents");
        std::fs::create_dir_all(&project_agents).unwrap();
        let missing_user_agents = root.join("missing-agent-home").join("agents");

        let allowed = allowed_agent_definition_roots(
            &missing_user_agents,
            Some(project.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(allowed, vec![std::fs::canonicalize(&project_agents).unwrap()]);
        assert!(allowed_agent_definition_roots(&missing_user_agents, None).is_err());
    }

    #[test]
    fn opening_missing_user_definition_directory_falls_back_to_active_home() {
        let root = TempCatalogDir::new();
        let home = root.join("active-home");
        std::fs::create_dir_all(&home).unwrap();

        let (target, used_home_fallback) =
            user_definition_directory_open_target(&home, "agents").unwrap();
        assert_eq!(target, home);
        assert!(used_home_fallback);

        let agents_dir = home.join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        let (target, used_home_fallback) =
            user_definition_directory_open_target(&home, "agents").unwrap();
        assert_eq!(target, agents_dir);
        assert!(!used_home_fallback);

        let roles_dir = home.join("roles");
        std::fs::create_dir_all(&roles_dir).unwrap();
        let (target, used_home_fallback) =
            user_definition_directory_open_target(&home, "roles").unwrap();
        assert_eq!(target, roles_dir);
        assert!(!used_home_fallback);
    }

    #[test]
    fn config_file_edit_preserves_other_sections_and_rejects_invalid_toml_without_write() {
        let root = TempCatalogDir::new();
        let config = root.join("config.toml");
        let malformed = "[subagents.roles\ninvalid = true\n";
        std::fs::write(&config, malformed).unwrap();
        assert!(edit_toml_file(&config, |_| Ok(())).is_err());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), malformed);

        let source = "# preserved comment\n[models]\ndefault = 'grok-4.6'\n[agent]\nname = 'keep-this-field'\n";
        std::fs::write(&config, source).unwrap();
        edit_toml_file(&config, |document| {
            set_agent_definition_in_document(document, "/tmp/agent-home/agents/example.md")
        })
        .unwrap();
        let updated = std::fs::read_to_string(&config).unwrap();
        let parsed: toml::Value = toml::from_str(&updated).unwrap();
        assert!(updated.contains("# preserved comment"));
        assert_eq!(parsed["models"]["default"].as_str(), Some("grok-4.6"));
        assert_eq!(parsed["agent"]["name"].as_str(), Some("keep-this-field"));
        assert_eq!(parsed["agent"]["definition"].as_str(), Some("/tmp/agent-home/agents/example.md"));
    }

    #[test]
    fn deleting_default_agent_clears_only_matching_definition_pointer() {
        let root = TempCatalogDir::new();
        let target = root.join("agents/reviewer.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "agent").unwrap();
        let target = std::fs::canonicalize(target).unwrap();
        let config_path = root.join("config.toml");
        let mut document = parse_editable_toml(&format!(
            "[agent]\ndefinition = {:?}\nname = 'preserve'\n[models]\ndefault = 'grok-4.6'\n",
            target.to_string_lossy()
        ))
        .unwrap();

        assert!(clear_agent_definition_in_document(&mut document, &config_path, &target).unwrap());

        let updated: toml::Value = toml::from_str(&document.to_string()).unwrap();
        assert!(updated["agent"].get("definition").is_none());
        assert_eq!(updated["agent"]["name"].as_str(), Some("preserve"));
        assert_eq!(updated["models"]["default"].as_str(), Some("grok-4.6"));
    }

    #[test]
    fn deleting_non_default_agent_keeps_definition_pointer() {
        let root = TempCatalogDir::new();
        let target = root.join("agents/other.md");
        let configured = root.join("agents/reviewer.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "other").unwrap();
        std::fs::write(&configured, "default").unwrap();
        let target = std::fs::canonicalize(target).unwrap();
        let configured = std::fs::canonicalize(configured).unwrap();
        let config_path = root.join("config.toml");
        let mut document = parse_editable_toml(&format!(
            "[agent]\ndefinition = {:?}\n",
            configured.to_string_lossy()
        ))
        .unwrap();

        assert!(!clear_agent_definition_in_document(&mut document, &config_path, &target).unwrap());
        assert!(document.to_string().contains(&configured.to_string_lossy().to_string()));
    }

    #[test]
    fn agent_file_rollback_restores_overwrites_and_removes_new_files() {
        let root = TempCatalogDir::new();
        let existing = root.join("existing-agent.md");
        std::fs::write(&existing, "original contents").unwrap();
        let backup = read_agent_definition_backup(&existing).unwrap().unwrap();
        std::fs::write(&existing, "replacement contents").unwrap();
        restore_agent_definition_after_config_failure(&existing, Some(&backup), false).unwrap();
        assert_eq!(std::fs::read_to_string(&existing).unwrap(), "original contents");

        let created = root.join("new-agent.md");
        std::fs::write(&created, "new contents").unwrap();
        restore_agent_definition_after_config_failure(&created, None, true).unwrap();
        assert!(!created.exists());
    }

    #[test]
    fn parses_nested_inline_role_and_persona_tables() {
        let root = TempCatalogDir::new();
        let config = root.join("config.toml");
        std::fs::write(&config, r#"[subagents.roles.reviewer]
description = "Review"
instructions = "private"
[subagents.personas.writer]
description = "Writing"
"#).unwrap();
        let (mut roles, mut personas, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
        let configured = discover_inline_definitions_in_home(
            &config,
            &mut roles,
            &mut personas,
            &mut warnings,
        );
        assert!(!roles.is_empty());
        assert_eq!(roles[0].name, "reviewer");
        assert_eq!(roles[0].description.as_deref(), Some("Review"));
        assert_eq!(personas[0].name, "writer");
        assert_eq!(personas[0].description.as_deref(), Some("Writing"));
        assert!(warnings.is_empty());
        assert!(configured.is_none());
        assert!(!serde_json::to_string(&roles).unwrap().contains("private"));
    }

    #[test]
    fn role_toml_fields_and_shared_persona_file_metadata_are_discovered() {
        let root = TempCatalogDir::new();
        let roles_dir = root.join("roles");
        let personas_dir = root.join("personas");
        std::fs::create_dir_all(&roles_dir).unwrap();
        std::fs::create_dir_all(&personas_dir).unwrap();
        std::fs::write(
            roles_dir.join("reviewer.toml"),
            "description = 'Role = description'\nmodel = 'ignored'\n",
        )
        .unwrap();
        std::fs::write(
            personas_dir.join("concise.toml"),
            "description = 'Persona description'\ninstructions = 'private'\n",
        )
        .unwrap();
        std::fs::write(roles_dir.join("ignored.md"), "not a TOML role").unwrap();

        let mut warnings = Vec::new();
        let roles = scan_catalog_dir::<RoleDefDto>(&roles_dir, "user", &mut warnings, true);

        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0].description.as_deref(), Some("Role = description"));
        assert_eq!(roles[0].model.as_deref(), Some("ignored"));
        let shared_personas = scan_catalog_dir::<PersonaDefDto>(
            &personas_dir,
            "bundled",
            &mut warnings,
            false,
        );
        assert_eq!(shared_personas.len(), 1);
        assert_eq!(shared_personas[0].description.as_deref(), Some("Persona description"));
        assert!(shared_personas[0].instructions.is_none());
        assert!(warnings.is_empty());
    }

    #[test]
    fn catalog_directory_cap_returns_a_truncation_warning() {
        let root = TempCatalogDir::new();
        (0..=MAX_AGENT_CATALOG_ENTRIES_PER_DIR).for_each(|index| {
            std::fs::write(
                root.join(format!("role-{index:03}.toml")),
                "description = 'Test role'\n",
            )
            .unwrap();
        });
        let mut warnings = Vec::new();

        let roles = scan_catalog_dir::<RoleDefDto>(&root, "user", &mut warnings, false);

        assert_eq!(roles.len(), MAX_AGENT_CATALOG_ENTRIES_PER_DIR);
        assert!(warnings
            .iter()
            .any(|warning| matches!(warning.code, CatalogWarningCode::DirectoryTruncated)));
    }

    #[test]
    fn config_warnings_are_safe_and_missing_config_is_silent() {
        let root = TempCatalogDir::new();
        let missing = root.join("absent.toml");
        let (mut roles, mut personas, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
        let _ = discover_inline_definitions_in_home(
            &missing,
            &mut roles,
            &mut personas,
            &mut warnings,
        );
        assert!(warnings.is_empty());
        std::fs::write(&missing, "[subagents.roles\nsecret = 'never expose'").unwrap();
        let markdown_agents = [AgentDefDto {
            name: "existing-agent".into(),
            path: root.join("agent.md").to_string_lossy().to_string(),
            scope: "user".into(),
            description: Some("Existing Markdown result".into()),
            is_default: false,
        }];
        let _ = discover_inline_definitions_in_home(
            &missing,
            &mut roles,
            &mut personas,
            &mut warnings,
        );
        assert_eq!(markdown_agents[0].name, "existing-agent");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].code, CatalogWarningCode::ConfigRead));
        assert!(!serde_json::to_string(&warnings).unwrap().contains("never expose"));
    }

    #[test]
    fn config_and_project_user_bundled_precedence_is_deterministic() {
        let selected = apply_catalog_precedence(vec![
            RoleDefDto { name: "same".into(), path: "bundle".into(), scope: "bundled".into(), description: None, default_capability_mode: None, model: None, prompt_file: None, prompt: None },
            RoleDefDto { name: "same".into(), path: "user".into(), scope: "user".into(), description: None, default_capability_mode: None, model: None, prompt_file: None, prompt: None },
            RoleDefDto { name: "same".into(), path: "project".into(), scope: "project".into(), description: None, default_capability_mode: None, model: None, prompt_file: None, prompt: None },
            RoleDefDto { name: "same".into(), path: "config".into(), scope: "config".into(), description: None, default_capability_mode: None, model: None, prompt_file: None, prompt: None },
        ]);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].path, "config");

        let selected = apply_catalog_precedence(vec![
            RoleDefDto { name: "same".into(), path: "bundle".into(), scope: "bundled".into(), description: None, default_capability_mode: None, model: None, prompt_file: None, prompt: None },
            RoleDefDto { name: "same".into(), path: "user".into(), scope: "user".into(), description: None, default_capability_mode: None, model: None, prompt_file: None, prompt: None },
            RoleDefDto { name: "same".into(), path: "project".into(), scope: "project".into(), description: None, default_capability_mode: None, model: None, prompt_file: None, prompt: None },
        ]);
        assert_eq!(selected[0].path, "project");
    }

    #[test]
    fn project_scope_catalog_keeps_same_named_global_and_project_entries() {
        let entries = sort_catalog_by_scope(vec![
            RoleDefDto {
                name: "reviewer".into(),
                path: "/home/user/.grok/roles/reviewer.toml".into(),
                scope: "user".into(),
                description: Some("Global role".into()),
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
            RoleDefDto {
                name: "reviewer".into(),
                path: "/work/project/.grok/roles/reviewer.toml".into(),
                scope: "project".into(),
                description: Some("Project role".into()),
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
        ]);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].scope, "project");
        assert_eq!(entries[1].scope, "user");
    }

    #[test]
    fn independent_role_files_and_persona_config_instructions_are_discovered() {
        let root = TempCatalogDir::new();
        let active_home = root.join("agent-home");
        let roles_dir = active_home.join("roles");
        let personas_dir = active_home.join("personas");
        let prompts_dir = active_home.join("prompts");
        std::fs::create_dir_all(&roles_dir).unwrap();
        std::fs::create_dir_all(&personas_dir).unwrap();
        std::fs::create_dir_all(&prompts_dir).unwrap();
        let role_prompt = prompts_dir.join("researcher.md");
        let persona_instructions = personas_dir.join("writer.md");
        std::fs::write(&role_prompt, "Investigate thoroughly.").unwrap();
        std::fs::write(&persona_instructions, "Write clearly.").unwrap();
        let config = active_home.join("config.toml");
        std::fs::write(
            &config,
            format!(
                "[subagents.roles.researcher]\nprompt_file = {:?}\n[subagents.personas.writer]\ndescription = 'File persona'\ninstructions_file = {:?}\nmodel = 'grok-4.6'\ninputs = [{{ name = 'task', io_type = 'text' }}]\n[subagents.personas.legacy]\ninstructions = 'Legacy inline text'\n",
                std::fs::canonicalize(&role_prompt).unwrap().to_string_lossy(),
                std::fs::canonicalize(&persona_instructions).unwrap().to_string_lossy(),
            ),
        )
        .unwrap();
        std::fs::write(
            roles_dir.join("researcher.toml"),
            "description = 'File role'\ndefault_capability_mode = 'read-only'\n",
        )
        .unwrap();
        std::fs::write(
            personas_dir.join("writer.toml"),
            "description = 'File persona'\ninstructions = 'Write clearly'\n",
        )
        .unwrap();

        let mut warnings = Vec::new();
        let mut roles = scan_catalog_dir::<RoleDefDto>(&roles_dir, "user", &mut warnings, true);
        apply_role_config_pointers(&config, "user", &mut roles, &mut warnings);
        load_managed_role_prompt_content(&mut roles, &active_home, None);
        let mut personas = Vec::new();
        append_independent_personas_from_config(
            &config,
            &active_home,
            &active_home,
            "user",
            &mut personas,
            &mut warnings,
        );
        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0].name, "researcher");
        assert_eq!(roles[0].default_capability_mode.as_deref(), Some("read-only"));
        assert_eq!(roles[0].prompt.as_deref(), Some("Investigate thoroughly."));
        assert_eq!(personas.len(), 2);
        let writer = personas.iter().find(|persona| persona.name == "writer").unwrap();
        assert_eq!(writer.instructions.as_deref(), Some("Write clearly."));
        assert_eq!(writer.model.as_deref(), Some("grok-4.6"));
        let legacy = personas.iter().find(|persona| persona.name == "legacy").unwrap();
        assert!(legacy.instructions.is_none());
        assert_eq!(discover_configured_agent_definition(&config, &mut warnings), None);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn project_persona_config_can_reuse_global_instruction_file() {
        let root = TempCatalogDir::new();
        let global_home = root.join("agent-home");
        let global_personas = global_home.join("personas");
        let project_grok = root.join("workspace/.grok");
        std::fs::create_dir_all(&global_personas).unwrap();
        std::fs::create_dir_all(&project_grok).unwrap();
        let global_instruction = global_personas.join("concise.md");
        std::fs::write(&global_instruction, "Be concise.").unwrap();
        let config = project_grok.join("config.toml");
        std::fs::write(
            &config,
            format!(
                "[subagents.personas.reviewer]\ndescription = 'Concise'\ninstructions_file = {:?}\n",
                std::fs::canonicalize(&global_instruction).unwrap().to_string_lossy()
            ),
        )
        .unwrap();

        let mut personas = Vec::new();
        let mut warnings = Vec::new();
        append_independent_personas_from_config(
            &config,
            &project_grok,
            &global_home,
            "project",
            &mut personas,
            &mut warnings,
        );

        assert_eq!(personas.len(), 1);
        assert_eq!(personas[0].scope, "project");
        assert_eq!(personas[0].instructions.as_deref(), Some("Be concise."));
        assert_eq!(
            personas[0].path,
            std::fs::canonicalize(global_instruction)
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn file_definition_crud_preserves_unedited_toml() {
        let home = TempCatalogDir::new();
        let config_path = home.join("config.toml");
        let config_source = "# config comment\n[agent]\ndefinition = 'agents/main.md'\n[custom]\nkeep = true\n";
        std::fs::write(&config_path, config_source).unwrap();

        let role_directory = home.join("roles");
        std::fs::create_dir_all(&role_directory).unwrap();
        let role_path = role_directory.join("reviewer.toml");
        std::fs::write(
            &role_path,
            "# preserve role file comment\ndescription = 'Old description'\ncustom_policy = 'retain'\n",
        )
        .unwrap();
        let role = AgentDefinitionFileInput {
            kind: "role".into(),
            name: "reviewer".into(),
            description: Some("Review source changes".into()),
            instructions: None,
            default_capability_mode: Some("read-only".into()),
            model: Some("grok-4.6".into()),
            prompt_file: None,
            prompt: Some("Review findings carefully.".into()),
            reasoning_effort: None,
            default_isolation: None,
            ..Default::default()
        };
        save_user_definition_file(&home, &role).unwrap();
        let role_contents = std::fs::read_to_string(&role_path).unwrap();
        let parsed_role: toml::Value = toml::from_str(&role_contents).unwrap();
        let expected_prompt_path = std::fs::canonicalize(&home.0)
            .unwrap()
            .join("prompts")
            .join("reviewer.md")
            .to_string_lossy()
            .into_owned();
        assert!(role_contents.contains("# preserve role file comment"));
        assert_eq!(parsed_role["description"].as_str(), Some("Review source changes"));
        assert_eq!(parsed_role["custom_policy"].as_str(), Some("retain"));
        assert_eq!(parsed_role["default_capability_mode"].as_str(), Some("read-only"));
        assert!(parsed_role.get("prompt_file").is_none());
        let role_config: toml::Value = toml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(role_config["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(), Some(expected_prompt_path.as_str()));
        assert!(parsed_role.get("subagents").is_none());

        let writer_type = role_directory.join("writer.toml");
        std::fs::write(&writer_type, "description = 'Writer type'\n").unwrap();
        let persona_directory = home.join("personas");
        let persona_path = persona_directory.join("writer.md");
        let persona = AgentDefinitionFileInput {
            kind: "persona".into(),
            name: "writer".into(),
            scope: "user".into(),
            description: Some("Updated persona".into()),
            instructions: Some("Write clearly".into()),
            model: Some("grok-4.6".into()),
            reasoning_effort: Some("high".into()),
            default_isolation: Some("worktree".into()),
            inputs: Some(serde_json::json!([{"name":"task","io_type":"text"}])),
            outputs: Some(serde_json::json!([{"name":"summary","io_type":"text"}])),
            ..Default::default()
        };
        save_user_definition_file(&home, &persona).unwrap();
        assert_eq!(std::fs::read_to_string(&persona_path).unwrap(), "Write clearly");
        let saved_config: toml::Value =
            toml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        let persona_config = &saved_config["subagents"]["personas"]["writer"];
        assert_eq!(persona_config["description"].as_str(), Some("Updated persona"));
        assert_eq!(persona_config["model"].as_str(), Some("grok-4.6"));
        assert_eq!(persona_config["reasoning_effort"].as_str(), Some("high"));
        assert_eq!(persona_config["default_isolation"].as_str(), Some("worktree"));
        assert_eq!(persona_config["instructions_file"].as_str(), Some(std::fs::canonicalize(&persona_path).unwrap().to_string_lossy().as_ref()));
        assert_eq!(persona_config["inputs"][0]["name"].as_str(), Some("task"));
        assert_eq!(persona_config["outputs"][0]["name"].as_str(), Some("summary"));
        assert!(persona_config.get("instructions").is_none());

        let scope = AgentDefinitionScopePaths {
            root: std::fs::canonicalize(&home.0).unwrap(),
            config: config_path.clone(),
            label: "user",
        };
        let config_sources = [(config_path.clone(), scope.root.clone())];
        delete_user_definition_file_in_scope(&scope, "role", "REVIEWER").unwrap();
        delete_user_definition_file_in_scope_with_config_sources(
            &scope,
            "persona",
            "WRITER",
            Some(&config_sources),
        )
        .unwrap();
        assert!(!role_path.exists());
        assert!(!persona_path.exists());
        assert!(writer_type.is_file());
        let final_config = std::fs::read_to_string(&config_path).unwrap();
        assert!(final_config.contains("definition = 'agents/main.md'"));
        assert!(final_config.contains("keep = true"));
        assert!(!final_config.contains("[subagents.personas.writer]"));
    }

    #[test]
    fn role_prompt_text_writes_managed_file_and_role_toml_pointer() {
        let root = TempCatalogDir::new();
        let agent_home = root.join("agent-home");
        std::fs::create_dir_all(&agent_home).unwrap();
        let config = agent_home.join("config.toml");
        let config_source = "[agent]\ndefinition = 'agents/main.md'\n";
        std::fs::write(&config, config_source).unwrap();
        let input = AgentDefinitionFileInput {
            kind: "role".into(),
            name: "reviewer".into(),
            description: Some("Review source changes".into()),
            instructions: None,
            default_capability_mode: Some("read-only".into()),
            model: Some("grok-4.6".into()),
            prompt_file: None,
            prompt: Some("Review changed lines and report findings.".into()),
            reasoning_effort: None,
            default_isolation: None,
            ..Default::default()
        };

        save_user_definition_file(&agent_home, &input).unwrap();
        let role_path = agent_home.join("roles").join("reviewer.toml");
        let parsed: toml::Value = toml::from_str(&std::fs::read_to_string(&role_path).unwrap()).unwrap();
        assert!(parsed.get("prompt_file").is_none());
        let configured: toml::Value = toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        let prompt_file = configured["subagents"]["roles"]["reviewer"]["prompt_file"].as_str().unwrap().to_string();
        let canonical_prompt_directory = std::fs::canonicalize(agent_home.join("prompts")).unwrap();
        assert!(std::path::Path::new(&prompt_file).starts_with(canonical_prompt_directory));
        assert_eq!(std::fs::read_to_string(&prompt_file).unwrap(), "Review changed lines and report findings.");
        assert!(parsed.get("subagents").is_none());
        assert_eq!(configured["agent"]["definition"].as_str(), Some("agents/main.md"));
        assert_eq!(configured["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(), Some(prompt_file.as_str()));

        let mut updated_input = input.clone();
        updated_input.prompt_file = Some(prompt_file.clone());
        updated_input.prompt = Some("Report risks and edge cases.".into());
        save_user_definition_file(&agent_home, &updated_input).unwrap();
        let updated: toml::Value = toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(updated["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(), Some(prompt_file.as_str()));
        assert_eq!(std::fs::read_to_string(&prompt_file).unwrap(), "Report risks and edge cases.");

        let mut warnings = Vec::new();
        let mut roles = scan_catalog_dir::<RoleDefDto>(
            &agent_home.join("roles"),
            "user",
            &mut warnings,
            true,
        );
        apply_role_config_pointers(&config, "user", &mut roles, &mut warnings);
        load_managed_role_prompt_content(&mut roles, &agent_home, None);
        assert_eq!(roles[0].prompt.as_deref(), Some("Report risks and edge cases."));
        assert!(warnings.is_empty());
        let updated_config: toml::Value = toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(updated_config["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(), Some(prompt_file.as_str()));
        assert_eq!(updated_config["agent"]["definition"].as_str(), Some("agents/main.md"));

    }

    #[test]
    fn malformed_role_toml_fails_without_writing_prompt_asset() {
        let root = TempCatalogDir::new();
        let agent_home = root.join("agent-home");
        let invalid_roles = agent_home.join("roles");
        std::fs::create_dir_all(&invalid_roles).unwrap();
        let invalid_role = invalid_roles.join("reviewer.toml");
        let malformed = "[role\nprompt_file = 'broken'";
        std::fs::write(&invalid_role, malformed).unwrap();
        let input = AgentDefinitionFileInput {
            kind: "role".into(),
            name: "reviewer".into(),
            description: Some("Review changes".into()),
            default_capability_mode: Some("read-only".into()),
            prompt: Some("Review changed files.".into()),
            ..Default::default()
        };

        assert!(save_user_definition_file(&agent_home, &input).is_err());
        assert_eq!(std::fs::read_to_string(&invalid_role).unwrap(), malformed);
        assert!(!agent_home.join("prompts").exists());
    }

    #[test]
    fn project_scope_keeps_role_prompt_and_persona_config_inside_workspace() {
        let root = TempCatalogDir::new();
        let global_home = root.join("agent-home");
        std::fs::create_dir_all(&global_home).unwrap();
        let global_config = global_home.join("config.toml");
        let global_source = "[models]\ndefault = 'grok-4.6'\n";
        std::fs::write(&global_config, global_source).unwrap();
        let workspace = root.join("workspace");
        let project_grok = workspace.join(".grok");
        std::fs::create_dir_all(project_grok.join("roles")).unwrap();
        let project_config = project_grok.join("config.toml");
        std::fs::write(&project_config, "# project config\n[models]\ndefault = 'project-model'\n").unwrap();
        std::fs::write(project_grok.join("roles/reviewer.toml"), "description = 'Review'\n").unwrap();
        let scope = AgentDefinitionScopePaths {
            root: project_grok.clone(),
            config: project_config.clone(),
            label: "project",
        };
        let role = AgentDefinitionFileInput {
            kind: "role".into(),
            name: "reviewer".into(),
            scope: "project".into(),
            project_path: Some(workspace.to_string_lossy().to_string()),
            description: Some("Review changes".into()),
            default_capability_mode: Some("read-only".into()),
            model: None,
            prompt: Some("Inspect changed files.".into()),
            ..Default::default()
        };
        save_user_definition_file_in_scope(&global_home, &role, &scope).unwrap();
        let prompt_path = project_grok.join("prompts/reviewer.md");
        assert_eq!(std::fs::read_to_string(&prompt_path).unwrap(), "Inspect changed files.");
        let project_value: toml::Value = toml::from_str(&std::fs::read_to_string(&project_config).unwrap()).unwrap();
        assert_eq!(project_value["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(), Some(std::fs::canonicalize(&prompt_path).unwrap().to_string_lossy().as_ref()));

        let persona = AgentDefinitionFileInput {
            kind: "persona".into(),
            name: "reviewer".into(),
            scope: "project".into(),
            project_path: Some(workspace.to_string_lossy().to_string()),
            description: Some("Concise review style".into()),
            instructions: Some("Return concise findings.".into()),
            ..Default::default()
        };
        save_user_definition_file_in_scope(&global_home, &persona, &scope).unwrap();
        let persona_path = project_grok.join("personas/reviewer.md");
        assert_eq!(std::fs::read_to_string(&persona_path).unwrap(), "Return concise findings.");
        let configured: toml::Value = toml::from_str(&std::fs::read_to_string(&project_config).unwrap()).unwrap();
        assert_eq!(configured["subagents"]["personas"]["reviewer"]["instructions_file"].as_str(), Some(std::fs::canonicalize(&persona_path).unwrap().to_string_lossy().as_ref()));
        assert_eq!(configured["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(), Some(std::fs::canonicalize(&prompt_path).unwrap().to_string_lossy().as_ref()));
        assert_eq!(std::fs::read_to_string(&global_config).unwrap(), global_source);
    }

    #[test]
    fn persona_config_can_be_reused_for_another_project_agent_type() {
        let root = TempCatalogDir::new();
        let global_home = root.join("agent-home");
        let project_grok = root.join("workspace/.grok");
        std::fs::create_dir_all(global_home.join("personas")).unwrap();
        std::fs::create_dir_all(project_grok.join("roles")).unwrap();
        let instruction_file = global_home.join("personas/concise.md");
        std::fs::write(&instruction_file, "Be concise.").unwrap();
        let global_config = global_home.join("config.toml");
        std::fs::write(
            &global_config,
            format!(
                "[subagents.personas.researcher]\ndescription = 'Concise researcher'\ninstructions_file = {:?}\nmodel = 'grok-4.6'\n",
                std::fs::canonicalize(&instruction_file).unwrap().to_string_lossy()
            ),
        )
        .unwrap();
        let project_config = project_grok.join("config.toml");
        std::fs::write(&project_config, "[models]\ndefault = 'grok-4.6'\n").unwrap();
        std::fs::write(project_grok.join("roles/reviewer.toml"), "description = 'Review'\n").unwrap();
        let global_scope = AgentDefinitionScopePaths {
            root: global_home,
            config: global_config,
            label: "user",
        };
        let project_scope = AgentDefinitionScopePaths {
            root: project_grok,
            config: project_config.clone(),
            label: "project",
        };

        copy_persona_config_block(
            &project_scope,
            "reviewer",
            Some((&global_scope, "researcher")),
        )
        .unwrap();

        let project: toml::Value = toml::from_str(&std::fs::read_to_string(project_config).unwrap()).unwrap();
        let persona = &project["subagents"]["personas"]["reviewer"];
        assert_eq!(persona["description"].as_str(), Some("Concise researcher"));
        assert_eq!(persona["model"].as_str(), Some("grok-4.6"));
        assert_eq!(persona["instructions_file"].as_str(), Some(std::fs::canonicalize(instruction_file).unwrap().to_string_lossy().as_ref()));
    }

    #[test]
    fn malformed_persona_config_toml_is_rejected() {
        assert!(parse_editable_toml("[subagents.personas\ninstructions = 'broken'").is_err());
    }

    #[test]
    fn role_without_prompt_is_rejected_without_mutating_toml() {
        let mut document = parse_editable_toml("[models]\ndefault = 'grok-4.6'\n").unwrap();
        let original = document.to_string();
        let role_without_prompt = AgentDefinitionFileInput {
            kind: "role".into(),
            name: "reviewer".into(),
            description: None,
            instructions: None,
            default_capability_mode: None,
            model: None,
            prompt_file: None,
            prompt: None,
            reasoning_effort: None,
            default_isolation: None,
            ..Default::default()
        };
        assert!(apply_agent_file_definition(&mut document, &role_without_prompt).is_err());
        assert_eq!(document.to_string(), original);
    }

    #[test]
    fn persona_rejects_invalid_reasoning_effort() {
        let input = AgentDefinitionFileInput {
            kind: "persona".into(),
            name: "writer".into(),
            description: None,
            instructions: Some("Write clearly".into()),
            reasoning_effort: Some("invalid".into()),
            ..Default::default()
        };
        assert!(validate_agent_file_definition(&input).is_err());
    }

    #[test]
    fn deleting_missing_persona_configuration_fails() {
        let root = TempCatalogDir::new();
        assert!(delete_user_definition_file(&root.0, "persona", "missing", "user", None).is_err());
    }

    fn valid_agent_frontmatter() -> serde_json::Value {
        serde_json::json!({
            "name": "reviewer",
            "description": "Reviews code",
            "promptMode": "full",
            "tools": ["Read", "Bash"],
            "disallowedTools": ["Write"],
            "permissionMode": "plan",
            "skills": ["code-review"],
            "agentsMd": true,
            "outputFormat": "concise",
            "bash": {"timeoutSecs": 120.0, "outputByteLimit": 200000, "cmdPrefix": null},
            "toolNameOverrides": {"Read": "read_file"},
            "paramNameOverrides": {"Read": {"file_path": "path"}},
            "completionRequirement": {"tool": "submit", "reminder": "Submit findings."},
            "toolConfig": {"Bash": {"retry": {"maxRetries": 2}}},
            "mcpServers": [{"name": "local"}],
            "mcpInheritance": {"named": ["local"]}
        })
    }

    #[test]
    fn agent_frontmatter_schema_accepts_documented_fields() {
        let valid = valid_agent_frontmatter();
        assert!(validate_agent_frontmatter_schema(&valid).is_ok());
    }

    #[test]
    fn agent_frontmatter_rejects_tools_with_wrong_shape() {
        let mut invalid = valid_agent_frontmatter();
        invalid["tools"] = serde_json::json!("Read,Bash");
        assert!(validate_agent_frontmatter_schema(&invalid).is_err());
    }

    #[test]
    fn agent_frontmatter_rejects_model_field() {
        let mut invalid = valid_agent_frontmatter();
        invalid["model"] = serde_json::json!("grok-4.6");
        assert!(validate_agent_frontmatter_schema(&invalid).is_err());
    }

    #[test]
    fn agent_frontmatter_rejects_invalid_mcp_inheritance_shape() {
        let mut invalid = valid_agent_frontmatter();
        invalid["mcpInheritance"] = serde_json::json!({"named": "local"});
        assert!(validate_agent_frontmatter_schema(&invalid).is_err());
    }

    #[test]
    fn optional_empty_role_and_persona_fields_are_omitted() {
        let mut role_document = parse_editable_toml("").unwrap();
        let role = AgentDefinitionFileInput {
            kind: "role".into(),
            name: "reviewer".into(),
            description: Some(String::new()),
            instructions: Some(String::new()),

            default_capability_mode: Some(String::new()),
            model: Some(String::new()),
            prompt_file: Some(String::new()),
            prompt: Some("Role prompt".into()),
            reasoning_effort: Some(String::new()),
            default_isolation: Some(String::new()),
            ..Default::default()
        };
        apply_agent_file_definition(&mut role_document, &role).unwrap();
        let parsed_role: toml::Value = toml::from_str(&role_document.to_string()).unwrap();
        assert!(parsed_role.as_table().unwrap().is_empty());

        let mut persona_document = parse_editable_toml("").unwrap();
        let persona = AgentDefinitionFileInput {
            kind: "persona".into(),
            name: "writer".into(),
            description: Some(String::new()),
            instructions: Some("Write clearly".into()),
            model: Some(String::new()),
            reasoning_effort: Some(String::new()),
            default_isolation: Some(String::new()),
            ..Default::default()
        };
        let table = ensure_subagent_definition_table(
            &mut persona_document,
            "personas",
            "writer",
        )
        .unwrap();
        apply_persona_config_fields(table, &persona, "/grok/personas/writer.md").unwrap();

        let parsed_persona: toml::Value = toml::from_str(&persona_document.to_string()).unwrap();
        let definition = &parsed_persona["subagents"]["personas"]["writer"];
        assert_eq!(definition["instructions_file"].as_str(), Some("/grok/personas/writer.md"));
        assert!(definition.get("instructions").is_none());
        assert!(definition.get("model").is_none());
        assert!(definition.get("reasoning_effort").is_none());
        assert!(definition.get("default_isolation").is_none());
    }

    #[test]
    fn shared_and_independent_modes_use_their_effective_config() {
        let shared = PathBuf::from("/user/.grok");
        let independent = PathBuf::from("/app/agent-home");
        assert_eq!(discovery_config_path(&shared, &independent, false), shared.join("config.toml"));
        assert_eq!(discovery_config_path(&shared, &independent, true), independent.join("config.toml"));
    }

    #[test]
    fn independent_agent_home_markdown_is_discovered_without_creating_directories() {
        let root = TempCatalogDir::new();
        let shared_agents = root.join(".grok").join("agents");
        std::fs::create_dir_all(&shared_agents).unwrap();
        std::fs::write(shared_agents.join("shared-only.md"), "shared definition").unwrap();
        let active_agents = root.join("agent-home").join("agents");
        assert!(!active_agents.exists());
        std::fs::create_dir_all(&active_agents).unwrap();
        let definition = active_agents.join("custom.md");
        std::fs::write(&definition, "---\ndescription: Active agent\n---\nprivate instructions").unwrap();
        let mut warnings = Vec::new();
        let discovered = scan_user_agent_defs(&shared_agents, &active_agents, true, &mut warnings);
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].path, definition.to_string_lossy());
        assert!(!discovered[0].is_default);
        assert!(warnings.is_empty());
        assert!(!active_agents.join("roles").exists());
        assert!(!active_agents.join("personas").exists());
    }

    #[test]
    fn shared_agent_discovery_uses_shared_grok_home() {
        let root = TempCatalogDir::new();
        let shared_agents = root.join(".grok").join("agents");
        let active_agents = root.join("agent-home").join("agents");
        std::fs::create_dir_all(&shared_agents).unwrap();
        std::fs::create_dir_all(&active_agents).unwrap();
        std::fs::write(shared_agents.join("shared.md"), "shared definition").unwrap();
        std::fs::write(active_agents.join("independent.md"), "independent definition").unwrap();

        let mut warnings = Vec::new();
        let discovered = scan_user_agent_defs(&shared_agents, &active_agents, false, &mut warnings);

        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].path, shared_agents.join("shared.md").to_string_lossy());
        assert!(warnings.is_empty());
    }

    #[test]
    fn configured_definition_is_included_or_marks_matching_scan_row() {
        let root = TempCatalogDir::new();
        let config = root.join("config.toml");
        let outside = root.join("outside").join("chosen.markdown");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        std::fs::write(&outside, "---\ndescription: Chosen\n---\nprivate instructions").unwrap();
        std::fs::write(&config, format!("[agent]\ndefinition = {:?}\n", outside.to_string_lossy())).unwrap();
        let (mut roles, mut personas, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
        let configured = discover_inline_definitions_in_home(
            &config,
            &mut roles,
            &mut personas,
            &mut warnings,
        )
        .unwrap();
        let mut agents = vec![];
        add_configured_definition(&mut agents, &configured);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].scope, "config");
        assert!(agents[0].is_default);
        assert_eq!(agents[0].description.as_deref(), Some("Chosen"));
        assert!(!serde_json::to_string(&agents).unwrap().contains("private instructions"));

        let mut scanned = AgentDefDto {
            name: "chosen".into(),
            path: outside.to_string_lossy().to_string(),
            scope: "user".into(),
            description: None,
            is_default: false,
        };
        let mut agents = vec![scanned.clone()];
        add_configured_definition(&mut agents, &configured);
        assert_eq!(agents.len(), 1);
        scanned.is_default = true;
        assert!(agents[0].is_default);
        assert_eq!(agents[0].path, scanned.path);
        assert!(warnings.is_empty());
    }

    #[test]
    fn configured_definition_rejects_non_markdown_and_oversized_files() {
        let root = TempCatalogDir::new();
        let config = root.join("config.toml");
        let bad = root.join("definition.toml");
        std::fs::write(&bad, "private = true").unwrap();
        let mut warnings = Vec::new();
        assert!(validate_configured_definition(&bad.to_string_lossy(), &config, &mut warnings).is_none());
        let large = root.join("large.md");
        std::fs::write(&large, vec![b'x'; MAX_AGENT_DEFINITION_BYTES as usize + 1]).unwrap();
        assert!(validate_configured_definition(&large.to_string_lossy(), &config, &mut warnings).is_none());
        assert_eq!(warnings.len(), 2);
    }
}
