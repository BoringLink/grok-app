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
        (
            "permissionMode",
            &["default", "acceptEdits", "dontAsk", "plan"][..],
        ),
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
    if object
        .get("agentsMd")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("Agent field `agentsMd` must be a boolean".into());
    }
    for field in [
        "bash",
        "toolNameOverrides",
        "paramNameOverrides",
        "completionRequirement",
        "toolConfig",
    ] {
        if object.get(field).is_some_and(|value| !value.is_object()) {
            return Err(format!("Agent field `{field}` must be an object"));
        }
    }
    if object.get("bash").is_some_and(|bash| {
        bash.get("timeoutSecs")
            .is_some_and(|value| !value.is_number())
            || bash
                .get("outputByteLimit")
                .is_some_and(|value| value.as_u64().is_none())
            || bash
                .get("cmdPrefix")
                .is_some_and(|value| !value.is_string() && !value.is_null())
    }) {
        return Err("invalid Agent field `bash`".into());
    }
    if object
        .get("toolNameOverrides")
        .is_some_and(|value| !json_object_values_are_strings(value))
    {
        return Err("Agent field `toolNameOverrides` must map strings to strings".into());
    }
    if object.get("paramNameOverrides").is_some_and(|value| {
        value.as_object().is_none_or(|mappings| {
            mappings
                .values()
                .any(|mapping| !json_object_values_are_strings(mapping))
        })
    }) {
        return Err("Agent field `paramNameOverrides` must map tools to string mappings".into());
    }
    if object.get("completionRequirement").is_some_and(|value| {
        value.get("tool").is_some_and(|tool| !tool.is_string())
            || value
                .get("reminder")
                .is_some_and(|reminder| !reminder.is_string())
            || value.get("recovery").is_some_and(|recovery| {
                recovery.as_object().is_none()
                    || ["maxRetries", "baseDelayMs", "maxDelayMs"]
                        .iter()
                        .any(|field| {
                            recovery
                                .get(field)
                                .is_some_and(|number| number.as_u64().is_none())
                        })
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
                                .any(|field| {
                                    retry
                                        .get(field)
                                        .is_some_and(|number| number.as_u64().is_none())
                                })
                    })
            })
        })
    }) {
        return Err("invalid Agent field `toolConfig`".into());
    }
    if object
        .get("mcpServers")
        .is_some_and(|value| !value.is_array())
    {
        return Err("Agent field `mcpServers` must be an array".into());
    }
    if object
        .get("mcpServers")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|servers| servers.iter().any(|server| !server.is_object()))
    {
        return Err("Agent field `mcpServers` entries must be objects".into());
    }
    if let Some(inheritance) = object.get("mcpInheritance") {
        match inheritance {
            serde_json::Value::String(value) if matches!(value.as_str(), "all" | "none") => {}
            serde_json::Value::Object(mapping) if mapping.len() == 1 => {
                let (mode, servers) = mapping
                    .iter()
                    .next()
                    .ok_or_else(|| "invalid mcpInheritance".to_string())?;
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
    value
        .as_object()
        .is_some_and(|object| object.values().all(serde_json::Value::is_string))
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

fn canonical_saved_project_root(raw_path: Option<&str>) -> Result<std::path::PathBuf, String> {
    let raw_path = raw_path
        .map(str::trim)
        .filter(|path| !path.is_empty() && !path.chars().any(char::is_control))
        .ok_or_else(|| "a saved Project is required for project scope".to_string())?;
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|_| "the selected Project path is unavailable".to_string())?;
    if !canonical.is_dir() {
        return Err("the selected Project path is unavailable".into());
    }
    let is_saved_project = store::load_projects().iter().any(|project| {
        saved_local_project_matches(
            &canonical,
            &project.path,
            project.path_ok,
            project.is_ssh_remote(),
        )
    });
    if !is_saved_project {
        return Err("project scope is limited to saved Projects".into());
    }
    Ok(canonical)
}

fn saved_local_project_matches(
    canonical_scope: &std::path::Path,
    project_path: &str,
    path_ok: bool,
    is_ssh_remote: bool,
) -> bool {
    path_ok
        && !is_ssh_remote
        && std::fs::canonicalize(project_path)
            .is_ok_and(|canonical_project| canonical_project == canonical_scope)
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
            let workspace_root = canonical_saved_project_root(project_path)?;
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
        let entries = read_worktree_agent_catalog_dir_entries(&directory, "user", &mut warnings);
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
        let definition_path =
            user_definition_file_path(&scope.root, &input.kind, &input.name, true)?;
        let previous_definition = read_agent_definition_backup(&definition_path)?;
        let mut effective_input = input.clone();
        if input
            .prompt
            .as_deref()
            .is_some_and(|prompt| !prompt.trim().is_empty())
        {
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
        let save_definition =
            edit_agent_definition_toml(&scope.root, &definition_path, |document| {
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

    let instructions =
        validate_agent_form_text(input.instructions.as_deref(), "persona instructions")?
            .ok_or_else(|| "Persona instructions are required".to_string())?;
    let reusable_instruction_file = input
        .instructions_file
        .as_deref()
        .and_then(|path| resolve_persona_instruction_file(&scope.root, agent_home, path))
        .filter(|path| {
            read_scoped_text_file(path, MAX_AGENT_FIELD_BYTES).as_deref() == Some(instructions)
        });
    let (definition_path, reusing_instruction_file) = match reusable_instruction_file {
        Some(path) => (path, true),
        None => (
            user_definition_file_path(&scope.root, "persona", &input.name, true)?,
            false,
        ),
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
                personas
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
            })
            .ok_or_else(|| "Persona configuration was not found".to_string())?;
        let persona_key = persona_key.to_string();
        let instruction_file = persona
            .as_table()
            .and_then(|persona| persona.get("instructions_file"))
            .and_then(toml_edit::Item::as_str)
            .map(str::to_string);
        if instruction_file
            .as_deref()
            .and_then(|path| config_path_candidate(&scope.root, path))
            .is_some_and(|path| persona_instruction_path_uses_symlink(&path))
        {
            return Err("Persona instruction file must not be a symbolic link".into());
        }
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
        if let Some(role) = role_key.as_deref().and_then(|role_key| {
            document
                .get_mut("subagents")
                .and_then(toml_edit::Item::as_table_mut)
                .and_then(|subagents| subagents.get_mut("roles"))
                .and_then(toml_edit::Item::as_table_mut)
                .and_then(|roles| roles.get_mut(role_key))
                .and_then(toml_edit::Item::as_table_mut)
        }) {
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

fn config_path_candidate(
    scope_root: &std::path::Path,
    raw_path: &str,
) -> Option<std::path::PathBuf> {
    if raw_path.is_empty() || raw_path.len() > 4096 || raw_path.chars().any(char::is_control) {
        return None;
    }
    let raw = std::path::Path::new(raw_path);
    Some(if raw.is_absolute() {
        raw.to_path_buf()
    } else if scope_root.file_name().is_some_and(|name| name == ".grok") && raw.starts_with(".grok")
    {
        scope_root.parent()?.join(raw)
    } else {
        scope_root.join(raw)
    })
}

fn resolve_config_path(scope_root: &std::path::Path, raw_path: &str) -> Option<std::path::PathBuf> {
    std::fs::canonicalize(config_path_candidate(scope_root, raw_path)?).ok()
}

fn persona_instruction_path_uses_symlink(path: &std::path::Path) -> bool {
    let mut current = std::path::PathBuf::new();
    path.components().any(|component| {
        current.push(component);
        std::fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.file_type().is_symlink())
    })
}

fn path_is_within_directory(directory: &std::path::Path, path: &std::path::Path) -> bool {
    std::fs::canonicalize(directory)
        .is_ok_and(|canonical_directory| path.starts_with(canonical_directory))
}

fn persona_config_sources(
    active_home: &std::path::Path,
    project_roots: impl IntoIterator<Item = std::path::PathBuf>,
) -> Vec<(std::path::PathBuf, std::path::PathBuf)> {
    let mut sources = vec![(active_home.join("config.toml"), active_home.to_path_buf())];
    project_roots.into_iter().for_each(|project_root| {
        let project_grok = project_root.join(".grok");
        sources.push((project_grok.join("config.toml"), project_grok));
    });
    sources
}

fn persona_instruction_file_is_referenced(
    target: &std::path::Path,
    config_sources_override: Option<&[(std::path::PathBuf, std::path::PathBuf)]>,
) -> bool {
    let config_sources = match config_sources_override {
        Some(sources) => sources.to_vec(),
        None => {
            let active_home = crate::paths::agent_home_dir();
            let project_roots = crate::store::load_projects()
                .iter()
                .filter(|project| project.path_ok && !project.is_ssh_remote())
                .map(|project| std::path::PathBuf::from(&project.path))
                .collect::<Vec<_>>();
            persona_config_sources(&active_home, project_roots)
        }
    };
    config_sources.iter().any(|(config_path, scope_root)| {
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
            std::path::Path::new(project_path)
                .join(".grok")
                .join("agents"),
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
            canonical_saved_project_root(project_path)?
                .join(".grok")
                .join("agents"),
            "project",
        ),
        _ => return Err("unknown Agent scope".into()),
    };
    let metadata = std::fs::symlink_metadata(raw_path)
        .map_err(|_| "Agent definition file is unavailable".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_AGENT_DEFINITION_BYTES
    {
        return Err("Agent definition path must be a regular Markdown file".into());
    }
    let canonical_directory = std::fs::canonicalize(&directory)
        .map_err(|_| "Agent definition directory is unavailable".to_string())?;
    let canonical_path = std::fs::canonicalize(raw_path)
        .map_err(|_| "Agent definition file is unavailable".to_string())?;
    if !canonical_path.starts_with(canonical_directory)
        || !canonical_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
            })
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
        .map(|path| canonical_saved_project_root(Some(path)))
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
        .map(|path| canonical_saved_project_root(Some(path)))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());
    crate::agents_catalog::sanitize_agent_file_stem_name(&name)?;
    let mut frontmatter = frontmatter
        .unwrap_or_else(|| {
            serde_json::json!({
                "promptMode": "full",
                "agentsMd": true,
                "mcpInheritance": "all"
            })
        })
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
    let markdown =
        crate::agents_catalog::agent_markdown_from_frontmatter(frontmatter, &instructions)?;
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
        .map(|path| canonical_saved_project_root(Some(path)))
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
        .map(|path| canonical_saved_project_root(Some(path)))
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
        (
            input.default_capability_mode.as_deref(),
            "default_capability_mode",
        ),
        (input.model.as_deref(), "model"),
        (input.prompt_file.as_deref(), "prompt_file"),
        (input.prompt.as_deref(), "prompt"),
        (input.reasoning_effort.as_deref(), "reasoning_effort"),
        (input.default_isolation.as_deref(), "default_isolation"),
    ] {
        validate_agent_form_text(value, field)?;
    }
    for (value, field) in [
        (input.inputs.as_ref(), "inputs"),
        (input.outputs.as_ref(), "outputs"),
    ] {
        if let Some(value) = value {
            let encoded =
                serde_json::to_vec(value).map_err(|_| format!("invalid Persona {field}"))?;
            if encoded.len() > MAX_AGENT_FIELD_BYTES {
                return Err(format!("Persona {field} are too large"));
            }
            toml::Value::try_from(value.clone()).map_err(|_| format!("invalid Persona {field}"))?;
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
                !matches!(
                    effort,
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                )
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
        (
            "default_capability_mode",
            input.default_capability_mode.as_deref(),
        ),
        ("model", input.model.as_deref()),
    ]
    .into_iter()
    .try_for_each(|(key, value_text)| set_toml_string(definition, key, value_text))?;
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
        [(root.join("agents"), "md"), (root.join("roles"), "toml")]
            .into_iter()
            .any(|(directory, extension)| {
                read_worktree_agent_catalog_dir_entries(&directory, scope.label, &mut warnings)
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
    let target_scope =
        resolve_agent_definition_scope(agent_home, target_scope_name, target_project_path, true)?;
    ensure_agent_type_exists(agent_home, &target_scope, target_agent_type)?;
    let source_scope = if let Some(persona_agent_type) = persona_agent_type
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        validate_agent_file_definition_name(persona_agent_type)?;
        let persona_scope_name =
            persona_scope_name.ok_or_else(|| "Persona scope is required".to_string())?;
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
        agent_home,
        &target_scope,
        target_agent_type,
        source_scope
            .as_ref()
            .map(|(scope, name)| (scope, name.as_str())),
    )
}

fn copy_persona_config_block(
    agent_home: &std::path::Path,
    target_scope: &AgentDefinitionScopePaths,
    target_agent_type: &str,
    source: Option<(&AgentDefinitionScopePaths, &str)>,
) -> Result<(), String> {
    let persona_table = if let Some((source_scope, persona_agent_type)) = source {
        let source_document =
            edit_toml_file(&source_scope.config, |document| Ok(document.clone()))?;
        let mut persona = source_document
            .get("subagents")
            .and_then(toml_edit::Item::as_table)
            .and_then(|subagents| subagents.get("personas"))
            .and_then(toml_edit::Item::as_table)
            .and_then(|personas| personas.get(persona_agent_type))
            .and_then(toml_edit::Item::as_table)
            .cloned()
            .ok_or_else(|| "selected Persona is no longer available".to_string())?;
        let instruction_file = persona
            .get("instructions_file")
            .and_then(toml_edit::Item::as_str)
            .ok_or_else(|| "selected Persona requires instructions_file".to_string())?;
        let instruction_path = crate::commands::resolve_persona_instruction_file(
            &source_scope.root,
            agent_home,
            instruction_file,
        )
        .ok_or_else(|| "selected Persona instruction file is unavailable".to_string())?;
        if read_scoped_text_file(&instruction_path, MAX_AGENT_FIELD_BYTES).is_none() {
            return Err("selected Persona instruction file is unavailable".into());
        }
        persona.remove("instructions");
        Some(persona)
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
            .map(|path| canonical_saved_project_root(Some(path)))
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
pub async fn agents_upsert_file_definition(input: AgentDefinitionFileInput) -> Result<(), String> {
    ensure_editable_independent_mode()?;
    validate_agent_file_definition(&input)?;
    let agent_home = crate::paths::agent_home_dir();
    tauri::async_runtime::spawn_blocking(move || save_user_definition_file(&agent_home, &input))
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
