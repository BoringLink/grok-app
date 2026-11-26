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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceDto {
    pub name: String,
    pub path: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub is_default: bool,
}

impl From<AgentDefDto> for AgentWorkspaceDto {
    fn from(agent: AgentDefDto) -> Self {
        Self {
            name: agent.name,
            path: agent.path,
            scope: agent.scope,
            description: agent.description,
            is_default: false,
        }
    }
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
    pub agents: Vec<AgentWorkspaceDto>,
    pub roles: Vec<RoleDefDto>,
    pub personas: Vec<PersonaWorkspaceDto>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaWorkspaceDto {
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
        .map(|path| canonical_saved_project_root(Some(path)))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::process_util::user_home();
        let grok = home.join(".grok");
        let user_agents = grok.join("agents");
        let bundled_agents = grok.join("bundled").join("agents");

        let project_agents = project
            .as_ref()
            .map(|p| std::path::PathBuf::from(p).join(".grok").join("agents"));

        let settings = store::load_settings();
        let independent = !settings
            .session_data_mode
            .trim()
            .eq_ignore_ascii_case("shared");
        let active_home = if independent {
            crate::paths::agent_home_dir()
        } else {
            grok.clone()
        };
        let active_user_agents = active_home.join("agents");

        let mut warnings = Vec::new();
        let mut agents = Vec::new();
        if let Some(ref dir) = project_agents {
            agents.extend(scan_worktree_agent_dir(dir, "project", &mut warnings));
        }
        agents.extend(scan_user_agent_defs(
            &user_agents,
            &active_user_agents,
            independent,
            &mut warnings,
        ));
        agents.extend(scan_worktree_agent_dir(
            &bundled_agents,
            "bundled",
            &mut warnings,
        ));

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
                let project_grok = std::path::Path::new(project_path).join(".grok");
                let _ = discover_inline_definitions_in_home(
                    &project_config,
                    &project_grok,
                    &grok,
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
                &grok,
                &grok,
                &mut roles,
                &mut personas,
                &mut warnings,
            )
        };
        let saved_project_agent_dirs = store::load_projects()
            .into_iter()
            .filter(|project| project.path_ok && !project.is_ssh_remote())
            .map(|project| {
                std::path::PathBuf::from(project.path)
                    .join(".grok")
                    .join("agents")
            })
            .filter_map(|directory| std::fs::canonicalize(directory).ok())
            .collect::<Vec<_>>();
        let configured_definition = configured_definition.filter(|path| {
            configured_agent_is_visible_in_scope(
                path,
                &active_home,
                project.as_deref(),
                &saved_project_agent_dirs,
            )
        });
        if let Some(path) = configured_definition.as_deref() {
            add_configured_definition(&mut agents, path);
        }
        let agents = map_agent_workspace_definitions(agents, configured_definition.as_deref());
        let role_directories: Vec<(std::path::PathBuf, &str)> = if independent {
            project
                .as_ref()
                .map(|path| {
                    (
                        std::path::PathBuf::from(path).join(".grok").join("roles"),
                        "project",
                    )
                })
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
                .map(|path| {
                    let scope_root = std::path::PathBuf::from(path).join(".grok");
                    (scope_root.join("personas"), scope_root, "project")
                })
                .into_iter()
                .chain([
                    (grok.join("personas"), grok.clone(), "user"),
                    (
                        grok.join("bundled").join("personas"),
                        grok.join("bundled"),
                        "bundled",
                    ),
                ])
                .collect::<Vec<_>>();
            persona_directories
                .into_iter()
                .for_each(|(directory, scope_root, scope)| {
                    personas.extend(scan_persona_catalog_dir(
                        &directory,
                        &scope_root,
                        scope,
                        &mut warnings,
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

        AgentsListResult {
            agents,
            roles,
            personas,
            warnings,
            user_agents_dir: if independent {
                active_user_agents.to_string_lossy().to_string()
            } else {
                user_agents_dir
            },
            project_agents_dir: project_agents
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            bundled_agents_dir: bundled_agents.to_string_lossy().to_string(),
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

fn user_definition_directory_open_target(
    active_home: &std::path::Path,
    kind: &str,
) -> Result<std::path::PathBuf, String> {
    let folder = match kind {
        "agents" | "roles" | "personas" => kind,
        _ => return Err("unknown Agent directory kind".into()),
    };
    let target = active_home.join(folder);
    if target.is_dir() {
        Ok(target)
    } else if active_home.is_dir() {
        Ok(active_home.to_path_buf())
    } else {
        Err("agent home directory is unavailable".into())
    }
}

#[tauri::command]
pub async fn agents_open_user_directory(
    kind: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<(), String> {
    if !matches!(kind.as_str(), "agents" | "roles" | "personas") {
        return Err("unknown Agent directory kind".into());
    }
    let scope = scope.as_deref().unwrap_or("user");
    if scope == "project" {
        let project_root = canonical_saved_project_root(project_path.as_deref())?;
        return tauri::async_runtime::spawn_blocking(move || {
            let grok_dir = project_root.join(".grok");
            let target = grok_dir.join(&kind);
            let path = if target.is_dir()
                && std::fs::canonicalize(&target)
                    .is_ok_and(|resolved| resolved.starts_with(&project_root))
            {
                target
            } else if grok_dir.is_dir() {
                grok_dir
            } else {
                project_root
            };
            crate::process_util::reveal_in_file_manager(&path)?;
            Ok(())
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
        let path = user_definition_directory_open_target(&active_home, &kind)?;
        crate::process_util::reveal_in_file_manager(&path)?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

const MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR: usize = 128;

fn read_worktree_agent_catalog_dir_entries(
    dir: &std::path::Path,
    scope: &str,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Vec<std::fs::DirEntry> {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(_) => {
            warnings.push(CatalogWarningDto {
                source: scope.to_string(),
                path: dir.to_string_lossy().to_string(),
                code: CatalogWarningCode::DirectoryRead,
            });
            return Vec::new();
        }
    };
    let mut entries = read_dir
        .take(MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR + 1)
        .collect::<Vec<_>>();
    let truncated = entries.len() > MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR;
    entries.sort_by_key(|entry| {
        entry
            .as_ref()
            .map(|entry| entry.file_name())
            .unwrap_or_default()
    });
    if truncated {
        entries.truncate(MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR);
        warnings.push(CatalogWarningDto {
            source: scope.to_string(),
            path: dir.to_string_lossy().to_string(),
            code: CatalogWarningCode::DirectoryTruncated,
        });
    }
    entries.into_iter().filter_map(Result::ok).collect()
}

fn scan_worktree_agent_dir(
    dir: &std::path::Path,
    scope: &str,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Vec<AgentDefDto> {
    read_worktree_agent_catalog_dir_entries(dir, scope, warnings)
        .into_iter()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let file_name = path.file_name()?.to_str()?;
            if !is_agent_def_file(file_name) {
                return None;
            }
            let name = stem_name(file_name);
            (!name.is_empty()).then(|| AgentDefDto {
                name,
                path: path.to_string_lossy().to_string(),
                scope: scope.to_string(),
                description: read_agent_description(&path),
            })
        })
        .collect()
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
    scan_worktree_agent_dir(user_dir, "user", warnings)
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
    read_worktree_agent_catalog_dir_entries(dir, scope, warnings)
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

fn scan_persona_catalog_dir(
    directory: &std::path::Path,
    scope_root: &std::path::Path,
    scope: &str,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Vec<PersonaWorkspaceDto> {
    if [directory, scope_root].into_iter().any(|path| {
        std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    }) {
        warnings.push(CatalogWarningDto {
            source: scope.to_string(),
            path: directory.to_string_lossy().to_string(),
            code: CatalogWarningCode::DirectoryRead,
        });
        return Vec::new();
    }
    scan_catalog_dir::<PersonaWorkspaceDto>(directory, scope, warnings, false)
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

fn discovery_config_path(
    shared_home: &std::path::Path,
    active_home: &std::path::Path,
    independent: bool,
) -> std::path::PathBuf {
    if independent {
        active_home.join("config.toml")
    } else {
        shared_home.join("config.toml")
    }
}

impl From<(String, String, String, Option<String>)> for RoleDefDto {
    fn from((name, path, scope, description): (String, String, String, Option<String>)) -> Self {
        Self {
            name,
            path,
            scope,
            description,
            default_capability_mode: None,
            model: None,
            prompt_file: None,
            prompt: None,
        }
    }
}
impl From<(String, String, String, Option<String>)> for PersonaWorkspaceDto {
    fn from((name, path, scope, description): (String, String, String, Option<String>)) -> Self {
        Self {
            name,
            path,
            scope,
            description,
            instructions: None,
            instructions_file: None,
            inputs: None,
            outputs: None,
            model: None,
            reasoning_effort: None,
            default_isolation: None,
        }
    }
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
    scope_root: &std::path::Path,
    global_home: &std::path::Path,
    roles: &mut Vec<RoleDefDto>,
    personas: &mut Vec<PersonaWorkspaceDto>,
    warnings: &mut Vec<CatalogWarningDto>,
) -> Option<String> {
    let parsed = parse_catalog_toml(path, "config", warnings)?;
    let configured_definition = configured_agent_definition(&parsed, path, warnings);
    for (key, is_role) in [("roles", true), ("personas", false)] {
        let Some(definitions) = parsed
            .get("subagents")
            .and_then(|value| value.get(key))
            .and_then(toml::Value::as_table)
        else {
            continue;
        };
        for (name, definition) in definitions {
            let description = definition
                .get("description")
                .and_then(toml::Value::as_str)
                .map(str::to_string);
            let row = (
                name.clone(),
                path.to_string_lossy().to_string(),
                "config".to_string(),
                description,
            );
            if is_role {
                let mut role: RoleDefDto = row.into();
                role.default_capability_mode = definition
                    .get("default_capability_mode")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string);
                role.model = definition
                    .get("model")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string);
                role.prompt_file = definition
                    .get("prompt_file")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string);
                roles.push(role);
            } else {
                let mut persona: PersonaWorkspaceDto = row.into();
                persona.instructions_file = definition
                    .get("instructions_file")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string);
                let resolved_instruction =
                    persona
                        .instructions_file
                        .as_deref()
                        .and_then(|instruction_file| {
                            resolve_persona_instruction_file(
                                scope_root,
                                global_home,
                                instruction_file,
                            )
                        });
                let instructions_from_file =
                    resolved_instruction.as_deref().and_then(|instruction| {
                        read_scoped_text_file(instruction, MAX_AGENT_FIELD_BYTES)
                    });
                if persona.instructions_file.is_some() && instructions_from_file.is_none() {
                    warnings.push(CatalogWarningDto {
                        source: "config".into(),
                        path: path.to_string_lossy().to_string(),
                        code: CatalogWarningCode::DefinitionRead,
                    });
                }
                persona.instructions = definition
                    .get("instructions")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string)
                    .or(instructions_from_file);
                if let Some(instruction_path) = resolved_instruction {
                    persona.path = instruction_path.to_string_lossy().to_string();
                }
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
        let Some(prompt_file) = definition.get("prompt_file").and_then(toml::Value::as_str) else {
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
    personas: &mut Vec<PersonaWorkspaceDto>,
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
            .and_then(|path| resolve_persona_instruction_file(scope_root, global_home, path));
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
        let mut persona = PersonaWorkspaceDto::from((
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
            && definition
                .get("instructions")
                .and_then(toml::Value::as_str)
                .is_some()
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
    let scope_root_metadata = std::fs::symlink_metadata(scope_root).ok()?;
    if scope_root_metadata.file_type().is_symlink() || !scope_root_metadata.is_dir() {
        return None;
    }
    let canonical_root = std::fs::canonicalize(scope_root).ok()?;
    let persona_directory_path = canonical_root.join("personas");
    let persona_directory_metadata = std::fs::symlink_metadata(&persona_directory_path).ok()?;
    if persona_directory_metadata.file_type().is_symlink() || !persona_directory_metadata.is_dir() {
        return None;
    }
    let persona_directory = std::fs::canonicalize(persona_directory_path).ok()?;
    let metadata = std::fs::symlink_metadata(&candidate).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_AGENT_FIELD_BYTES as u64
    {
        return None;
    }
    let canonical = std::fs::canonicalize(candidate).ok()?;
    canonical
        .starts_with(persona_directory)
        .then_some(canonical)
}

fn resolve_persona_instruction_file(
    scope_root: &std::path::Path,
    global_home: &std::path::Path,
    raw_path: &str,
) -> Option<std::path::PathBuf> {
    resolve_scoped_persona_instruction_file(scope_root, raw_path).or_else(|| {
        (scope_root != global_home)
            .then(|| resolve_scoped_persona_instruction_file(global_home, raw_path))
            .flatten()
    })
}

fn read_scoped_text_file(path: &std::path::Path, max_bytes: usize) -> Option<String> {
    use std::io::Read as _;
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes as u64
    {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(path)
        .ok()?
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= max_bytes)
        .then(|| String::from_utf8(bytes).ok())
        .flatten()
}

fn load_managed_role_prompt_content(
    roles: &mut [RoleDefDto],
    global_home: &std::path::Path,
    project_grok: Option<&std::path::Path>,
) {
    roles.iter_mut().for_each(|role| {
        let root = match role.scope.as_str() {
            "project" => project_grok,
            "user" => Some(global_home),
            _ => None,
        };
        role.prompt = root.and_then(|root| {
            role.prompt_file
                .as_deref()
                .and_then(|path| crate::agents_catalog::read_managed_role_prompt(root, path))
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
        config_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(expanded)
    };
    let extension = definition_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
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
    if agents.iter().any(|agent| {
        std::fs::canonicalize(&agent.path).unwrap_or_else(|_| std::path::PathBuf::from(&agent.path))
            == configured
    }) {
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
    });
}

fn map_agent_workspace_definitions(
    agents: Vec<AgentDefDto>,
    configured_path: Option<&str>,
) -> Vec<AgentWorkspaceDto> {
    sort_agent_defs(agents)
        .into_iter()
        .map(|agent| {
            let is_default = configured_path.is_some_and(|path| {
                std::fs::canonicalize(&agent.path)
                    .unwrap_or_else(|_| std::path::PathBuf::from(&agent.path))
                    == std::path::Path::new(path)
            });
            let mut workspace_agent = AgentWorkspaceDto::from(agent);
            workspace_agent.is_default = is_default;
            workspace_agent
        })
        .collect()
}

fn configured_agent_is_visible_in_scope(
    configured_path: &str,
    active_home: &std::path::Path,
    selected_project: Option<&str>,
    saved_project_agent_dirs: &[std::path::PathBuf],
) -> bool {
    let configured_path = std::fs::canonicalize(configured_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(configured_path));
    let global_agent_dir = std::fs::canonicalize(active_home.join("agents"))
        .unwrap_or_else(|_| active_home.join("agents"));
    if configured_path.starts_with(global_agent_dir) {
        return true;
    }
    let belongs_to_project = saved_project_agent_dirs
        .iter()
        .any(|directory| configured_path.starts_with(directory));
    if !belongs_to_project {
        return true;
    }
    selected_project
        .map(|project_path| {
            let selected_agent_dir = std::path::Path::new(project_path)
                .join(".grok")
                .join("agents");
            std::fs::canonicalize(&selected_agent_dir).unwrap_or(selected_agent_dir)
        })
        .is_some_and(|directory| configured_path.starts_with(directory))
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

impl CatalogEntry for PersonaWorkspaceDto {
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
            .then_with(|| {
                a.name()
                    .to_ascii_lowercase()
                    .cmp(&b.name().to_ascii_lowercase())
            })
    });
    items
}

fn apply_catalog_precedence<T: CatalogEntry>(items: Vec<T>) -> Vec<T> {
    let items = sort_catalog_by_scope(items);
    let mut result: Vec<T> = Vec::new();
    for item in items {
        if !result
            .iter()
            .any(|existing| existing.name().eq_ignore_ascii_case(item.name()))
        {
            result.push(item);
        }
    }
    result
}
