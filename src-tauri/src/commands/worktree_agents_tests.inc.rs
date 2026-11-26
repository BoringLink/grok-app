#[cfg(test)]
mod agents_catalog_tests {
    use super::*;
    use std::path::PathBuf;

    struct TempCatalogDir(PathBuf);

    impl TempCatalogDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("grok-agent-catalog-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl std::ops::Deref for TempCatalogDir {
        type Target = std::path::Path;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for TempCatalogDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
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

        let allowed =
            allowed_agent_definition_roots(&missing_user_agents, Some(project.to_str().unwrap()))
                .unwrap();
        assert_eq!(
            allowed,
            vec![std::fs::canonicalize(&project_agents).unwrap()]
        );
        assert!(allowed_agent_definition_roots(&missing_user_agents, None).is_err());
    }

    #[test]
    fn opening_missing_user_definition_directory_falls_back_to_active_home() {
        let root = TempCatalogDir::new();
        let home = root.join("active-home");
        std::fs::create_dir_all(&home).unwrap();

        let target = user_definition_directory_open_target(&home, "agents").unwrap();
        assert_eq!(target, home);

        let agents_dir = home.join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        let target = user_definition_directory_open_target(&home, "agents").unwrap();
        assert_eq!(target, agents_dir);

        let roles_dir = home.join("roles");
        std::fs::create_dir_all(&roles_dir).unwrap();
        let target = user_definition_directory_open_target(&home, "roles").unwrap();
        assert_eq!(target, roles_dir);
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
        assert_eq!(
            parsed["agent"]["definition"].as_str(),
            Some("/tmp/agent-home/agents/example.md")
        );
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
        let configured_path = configured.to_string_lossy().to_string();
        let mut document =
            parse_editable_toml(&format!("[agent]\ndefinition = {:?}\n", configured_path)).unwrap();

        assert!(!clear_agent_definition_in_document(&mut document, &config_path, &target).unwrap());
        let updated: toml::Value = toml::from_str(&document.to_string()).unwrap();
        assert_eq!(
            updated["agent"]["definition"].as_str(),
            Some(configured_path.as_str())
        );
    }

    #[test]
    fn agent_file_rollback_restores_overwrites_and_removes_new_files() {
        let root = TempCatalogDir::new();
        let existing = root.join("existing-agent.md");
        std::fs::write(&existing, "original contents").unwrap();
        let backup = read_agent_definition_backup(&existing).unwrap().unwrap();
        std::fs::write(&existing, "replacement contents").unwrap();
        restore_agent_definition_after_config_failure(&existing, Some(&backup), false).unwrap();
        assert_eq!(
            std::fs::read_to_string(&existing).unwrap(),
            "original contents"
        );

        let created = root.join("new-agent.md");
        std::fs::write(&created, "new contents").unwrap();
        restore_agent_definition_after_config_failure(&created, None, true).unwrap();
        assert!(!created.exists());
    }

    #[test]
    fn parses_nested_inline_role_and_persona_tables() {
        let root = TempCatalogDir::new();
        let config = root.join("config.toml");
        std::fs::write(
            &config,
            r#"[subagents.roles.reviewer]
description = "Review"
instructions = "private"
[subagents.personas.writer]
description = "Writing"
"#,
        )
        .unwrap();
        let (mut roles, mut personas, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
        let configured = discover_inline_definitions_in_home(
            &config,
            &root,
            &root,
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
        let shared_personas =
            scan_persona_catalog_dir(&personas_dir, &root.0, "bundled", &mut warnings);
        assert_eq!(shared_personas.len(), 1);
        assert_eq!(
            shared_personas[0].description.as_deref(),
            Some("Persona description")
        );
        assert!(shared_personas[0].instructions.is_none());
        assert!(warnings.is_empty());
    }

    #[test]
    fn catalog_directory_cap_returns_a_truncation_warning() {
        let root = TempCatalogDir::new();
        (0..=MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR).for_each(|index| {
            std::fs::write(
                root.join(format!("role-{index:03}.toml")),
                "description = 'Test role'\n",
            )
            .unwrap();
        });
        let mut warnings = Vec::new();

        let roles = scan_catalog_dir::<RoleDefDto>(&root, "user", &mut warnings, false);

        assert_eq!(roles.len(), MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR);
        assert!(warnings
            .iter()
            .any(|warning| matches!(warning.code, CatalogWarningCode::DirectoryTruncated)));
    }

    #[test]
    fn project_agent_scan_respects_catalog_entry_cap() {
        let root = TempCatalogDir::new();
        let agents = root.join(".grok/agents");
        std::fs::create_dir_all(&agents).unwrap();
        (0..=MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR).for_each(|index| {
            std::fs::write(agents.join(format!("agent-{index:03}.md")), "definition").unwrap();
        });
        let mut warnings = Vec::new();

        let discovered = scan_worktree_agent_dir(&agents, "project", &mut warnings);

        assert_eq!(discovered.len(), MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR);
        assert!(warnings
            .iter()
            .any(|warning| matches!(warning.code, CatalogWarningCode::DirectoryTruncated)));
    }

    #[test]
    fn project_persona_scan_respects_catalog_entry_cap() {
        let root = TempCatalogDir::new();
        let scope_root = root.join(".grok");
        let personas = scope_root.join("personas");
        std::fs::create_dir_all(&personas).unwrap();
        (0..=MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR).for_each(|index| {
            std::fs::write(
                personas.join(format!("persona-{index:03}.toml")),
                "description = 'Test persona'\n",
            )
            .unwrap();
        });
        let mut warnings = Vec::new();

        let discovered = scan_persona_catalog_dir(&personas, &scope_root, "project", &mut warnings);

        assert_eq!(discovered.len(), MAX_WORKTREE_AGENT_CATALOG_ENTRIES_PER_DIR);
        assert!(warnings
            .iter()
            .any(|warning| matches!(warning.code, CatalogWarningCode::DirectoryTruncated)));
    }

    #[test]
    fn persona_scan_ignores_hidden_files_and_subdirectories_without_warnings() {
        let root = TempCatalogDir::new();
        let scope_root = root.join(".grok");
        let personas = scope_root.join("personas");
        std::fs::create_dir_all(personas.join("nested")).unwrap();
        std::fs::write(personas.join(".DS_Store"), "metadata").unwrap();
        let mut warnings = Vec::new();

        let discovered = scan_persona_catalog_dir(&personas, &scope_root, "project", &mut warnings);

        assert!(discovered.is_empty());
        assert!(warnings.is_empty());
    }

    #[test]
    fn config_warnings_are_safe_and_missing_config_is_silent() {
        let root = TempCatalogDir::new();
        let missing = root.join("absent.toml");
        let (mut roles, mut personas, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
        let _ = discover_inline_definitions_in_home(
            &missing,
            &root,
            &root,
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
        }];
        let _ = discover_inline_definitions_in_home(
            &missing,
            &root,
            &root,
            &mut roles,
            &mut personas,
            &mut warnings,
        );
        assert_eq!(markdown_agents[0].name, "existing-agent");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].code, CatalogWarningCode::ConfigRead));
        assert!(!serde_json::to_string(&warnings)
            .unwrap()
            .contains("never expose"));
    }

    #[test]
    fn config_and_project_user_bundled_precedence_is_deterministic() {
        let selected = apply_catalog_precedence(vec![
            RoleDefDto {
                name: "same".into(),
                path: "bundle".into(),
                scope: "bundled".into(),
                description: None,
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
            RoleDefDto {
                name: "same".into(),
                path: "user".into(),
                scope: "user".into(),
                description: None,
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
            RoleDefDto {
                name: "same".into(),
                path: "project".into(),
                scope: "project".into(),
                description: None,
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
            RoleDefDto {
                name: "same".into(),
                path: "config".into(),
                scope: "config".into(),
                description: None,
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
        ]);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].path, "config");

        let selected = apply_catalog_precedence(vec![
            RoleDefDto {
                name: "same".into(),
                path: "bundle".into(),
                scope: "bundled".into(),
                description: None,
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
            RoleDefDto {
                name: "same".into(),
                path: "user".into(),
                scope: "user".into(),
                description: None,
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
            RoleDefDto {
                name: "same".into(),
                path: "project".into(),
                scope: "project".into(),
                description: None,
                default_capability_mode: None,
                model: None,
                prompt_file: None,
                prompt: None,
            },
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
        assert_eq!(
            roles[0].default_capability_mode.as_deref(),
            Some("read-only")
        );
        assert_eq!(roles[0].prompt.as_deref(), Some("Investigate thoroughly."));
        assert_eq!(personas.len(), 2);
        let writer = personas
            .iter()
            .find(|persona| persona.name == "writer")
            .unwrap();
        assert_eq!(writer.instructions.as_deref(), Some("Write clearly."));
        assert_eq!(writer.model.as_deref(), Some("grok-4.6"));
        let legacy = personas
            .iter()
            .find(|persona| persona.name == "legacy")
            .unwrap();
        assert!(legacy.instructions.is_none());
        assert_eq!(
            discover_configured_agent_definition(&config, &mut warnings),
            None
        );
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

    #[cfg(unix)]
    #[test]
    fn persona_instruction_resolver_rejects_symlinked_persona_directory() {
        let root = TempCatalogDir::new();
        let scope_root = root.join("global");
        let external_personas = root.join("external-personas");
        std::fs::create_dir_all(&scope_root).unwrap();
        std::fs::create_dir_all(&external_personas).unwrap();
        let external_instruction = external_personas.join("secret.md");
        std::fs::write(&external_instruction, "must not be exposed").unwrap();
        std::os::unix::fs::symlink(&external_personas, scope_root.join("personas")).unwrap();

        assert!(resolve_scoped_persona_instruction_file(
            &scope_root,
            external_instruction.to_string_lossy().as_ref(),
        )
        .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn shared_persona_catalog_does_not_scan_symlinked_directory() {
        let root = TempCatalogDir::new();
        let scope_root = root.join("project/.grok");
        let external_personas = root.join("external-personas");
        std::fs::create_dir_all(&scope_root).unwrap();
        std::fs::create_dir_all(&external_personas).unwrap();
        std::fs::write(
            external_personas.join("secret.toml"),
            "description = 'external private definition'\n",
        )
        .unwrap();
        let persona_directory = scope_root.join("personas");
        std::os::unix::fs::symlink(&external_personas, &persona_directory).unwrap();

        let mut warnings = Vec::new();
        let personas =
            scan_persona_catalog_dir(&persona_directory, &scope_root, "project", &mut warnings);

        assert!(personas.is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            warnings[0].code,
            CatalogWarningCode::DirectoryRead
        ));
        assert!(!serde_json::to_string(&personas)
            .unwrap()
            .contains("external private definition"));
    }

    #[test]
    fn shared_inline_persona_only_reads_approved_persona_directories() {
        let root = TempCatalogDir::new();
        let global_home = root.join("global");
        let project_grok = root.join("project/.grok");
        let global_personas = global_home.join("personas");
        let project_personas = project_grok.join("personas");
        std::fs::create_dir_all(&global_personas).unwrap();
        std::fs::create_dir_all(&project_personas).unwrap();

        let global_instruction = global_personas.join("global.md");
        let project_instruction = project_personas.join("project.md");
        let private_file = root.join("private.txt");
        std::fs::write(&global_instruction, "global persona text").unwrap();
        std::fs::write(&project_instruction, "project persona text").unwrap();
        std::fs::write(&private_file, "private local data").unwrap();

        let config = project_grok.join("config.toml");
        std::fs::write(
            &config,
            format!(
                "[subagents.personas.global]\ninstructions_file = {:?}\n[subagents.personas.project]\ninstructions_file = {:?}\n[subagents.personas.unsafe]\ninstructions_file = {:?}\n",
                std::fs::canonicalize(&global_instruction).unwrap().to_string_lossy(),
                std::fs::canonicalize(&project_instruction).unwrap().to_string_lossy(),
                std::fs::canonicalize(&private_file).unwrap().to_string_lossy(),
            ),
        )
        .unwrap();

        let mut personas = Vec::new();
        let mut warnings = Vec::new();
        discover_inline_definitions_in_home(
            &config,
            &project_grok,
            &global_home,
            &mut Vec::new(),
            &mut personas,
            &mut warnings,
        );

        let global = personas
            .iter()
            .find(|persona| persona.name == "global")
            .unwrap();
        let project = personas
            .iter()
            .find(|persona| persona.name == "project")
            .unwrap();
        let unsafe_persona = personas
            .iter()
            .find(|persona| persona.name == "unsafe")
            .unwrap();
        assert_eq!(global.instructions.as_deref(), Some("global persona text"));
        assert_eq!(
            project.instructions.as_deref(),
            Some("project persona text")
        );
        assert!(unsafe_persona.instructions.is_none());
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            warnings[0].code,
            CatalogWarningCode::DefinitionRead
        ));
        assert!(!serde_json::to_string(&personas)
            .unwrap()
            .contains("private local data"));
    }

    #[test]
    fn file_definition_crud_preserves_unedited_toml() {
        let home = TempCatalogDir::new();
        let config_path = home.join("config.toml");
        let config_source =
            "# config comment\n[agent]\ndefinition = 'agents/main.md'\n[custom]\nkeep = true\n";
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
        assert_eq!(
            parsed_role["description"].as_str(),
            Some("Review source changes")
        );
        assert_eq!(parsed_role["custom_policy"].as_str(), Some("retain"));
        assert_eq!(
            parsed_role["default_capability_mode"].as_str(),
            Some("read-only")
        );
        assert!(parsed_role.get("prompt_file").is_none());
        let role_config: toml::Value =
            toml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(
            role_config["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(),
            Some(expected_prompt_path.as_str())
        );
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
        assert_eq!(
            std::fs::read_to_string(&persona_path).unwrap(),
            "Write clearly"
        );
        let saved_config: toml::Value =
            toml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        let persona_config = &saved_config["subagents"]["personas"]["writer"];
        assert_eq!(
            persona_config["description"].as_str(),
            Some("Updated persona")
        );
        assert_eq!(persona_config["model"].as_str(), Some("grok-4.6"));
        assert_eq!(persona_config["reasoning_effort"].as_str(), Some("high"));
        assert_eq!(
            persona_config["default_isolation"].as_str(),
            Some("worktree")
        );
        assert_eq!(
            persona_config["instructions_file"].as_str(),
            Some(
                std::fs::canonicalize(&persona_path)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(persona_config["inputs"][0]["name"].as_str(), Some("task"));
        assert_eq!(
            persona_config["outputs"][0]["name"].as_str(),
            Some("summary")
        );
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
        let parsed: toml::Value =
            toml::from_str(&std::fs::read_to_string(&role_path).unwrap()).unwrap();
        assert!(parsed.get("prompt_file").is_none());
        let configured: toml::Value =
            toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        let prompt_file = configured["subagents"]["roles"]["reviewer"]["prompt_file"]
            .as_str()
            .unwrap()
            .to_string();
        let canonical_prompt_directory = std::fs::canonicalize(agent_home.join("prompts")).unwrap();
        assert!(std::path::Path::new(&prompt_file).starts_with(canonical_prompt_directory));
        assert_eq!(
            std::fs::read_to_string(&prompt_file).unwrap(),
            "Review changed lines and report findings."
        );
        assert!(parsed.get("subagents").is_none());
        assert_eq!(
            configured["agent"]["definition"].as_str(),
            Some("agents/main.md")
        );
        assert_eq!(
            configured["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(),
            Some(prompt_file.as_str())
        );

        let mut updated_input = input.clone();
        updated_input.prompt_file = Some(prompt_file.clone());
        updated_input.prompt = Some("Report risks and edge cases.".into());
        save_user_definition_file(&agent_home, &updated_input).unwrap();
        let updated: toml::Value =
            toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(
            updated["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(),
            Some(prompt_file.as_str())
        );
        assert_eq!(
            std::fs::read_to_string(&prompt_file).unwrap(),
            "Report risks and edge cases."
        );

        let mut warnings = Vec::new();
        let mut roles =
            scan_catalog_dir::<RoleDefDto>(&agent_home.join("roles"), "user", &mut warnings, true);
        apply_role_config_pointers(&config, "user", &mut roles, &mut warnings);
        load_managed_role_prompt_content(&mut roles, &agent_home, None);
        assert_eq!(
            roles[0].prompt.as_deref(),
            Some("Report risks and edge cases.")
        );
        assert!(warnings.is_empty());
        let updated_config: toml::Value =
            toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(
            updated_config["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(),
            Some(prompt_file.as_str())
        );
        assert_eq!(
            updated_config["agent"]["definition"].as_str(),
            Some("agents/main.md")
        );
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
        std::fs::write(
            &project_config,
            "# project config\n[models]\ndefault = 'project-model'\n",
        )
        .unwrap();
        std::fs::write(
            project_grok.join("roles/reviewer.toml"),
            "description = 'Review'\n",
        )
        .unwrap();
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
        assert_eq!(
            std::fs::read_to_string(&prompt_path).unwrap(),
            "Inspect changed files."
        );
        let project_value: toml::Value =
            toml::from_str(&std::fs::read_to_string(&project_config).unwrap()).unwrap();
        assert_eq!(
            project_value["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(),
            Some(
                std::fs::canonicalize(&prompt_path)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );

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
        assert_eq!(
            std::fs::read_to_string(&persona_path).unwrap(),
            "Return concise findings."
        );
        let configured: toml::Value =
            toml::from_str(&std::fs::read_to_string(&project_config).unwrap()).unwrap();
        assert_eq!(
            configured["subagents"]["personas"]["reviewer"]["instructions_file"].as_str(),
            Some(
                std::fs::canonicalize(&persona_path)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            configured["subagents"]["roles"]["reviewer"]["prompt_file"].as_str(),
            Some(
                std::fs::canonicalize(&prompt_path)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            std::fs::read_to_string(&global_config).unwrap(),
            global_source
        );
    }

    #[test]
    fn project_scope_requires_a_saved_accessible_local_project_path() {
        let root = TempCatalogDir::new();
        let saved_project = root.join("saved-project");
        let unsaved_project = root.join("unsaved-project");
        std::fs::create_dir_all(&saved_project).unwrap();
        std::fs::create_dir_all(&unsaved_project).unwrap();
        let canonical_saved = std::fs::canonicalize(&saved_project).unwrap();

        assert!(saved_local_project_matches(
            &canonical_saved,
            saved_project.to_str().unwrap(),
            true,
            false,
        ));
        assert!(!saved_local_project_matches(
            &canonical_saved,
            unsaved_project.to_str().unwrap(),
            true,
            false,
        ));
        assert!(!saved_local_project_matches(
            &canonical_saved,
            saved_project.to_str().unwrap(),
            false,
            false,
        ));
        assert!(!saved_local_project_matches(
            &canonical_saved,
            saved_project.to_str().unwrap(),
            true,
            true,
        ));
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
                "[subagents.personas.researcher]\ndescription = 'Concise researcher'\ninstructions = 'legacy inline text'\ninstructions_file = {:?}\nmodel = 'grok-4.6'\n",
                std::fs::canonicalize(&instruction_file).unwrap().to_string_lossy()
            ),
        )
        .unwrap();
        let project_config = project_grok.join("config.toml");
        std::fs::write(&project_config, "[models]\ndefault = 'grok-4.6'\n").unwrap();
        std::fs::write(
            project_grok.join("roles/reviewer.toml"),
            "description = 'Review'\n",
        )
        .unwrap();
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
            &global_scope.root,
            &project_scope,
            "reviewer",
            Some((&global_scope, "researcher")),
        )
        .unwrap();

        let project: toml::Value =
            toml::from_str(&std::fs::read_to_string(project_config).unwrap()).unwrap();
        let persona = &project["subagents"]["personas"]["reviewer"];
        assert_eq!(persona["description"].as_str(), Some("Concise researcher"));
        assert_eq!(persona["model"].as_str(), Some("grok-4.6"));
        assert!(persona.get("instructions").is_none());
        assert_eq!(
            persona["instructions_file"].as_str(),
            Some(
                std::fs::canonicalize(&instruction_file)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );

        let project_sources = persona_config_sources(&global_scope.root, [root.join("workspace")]);
        let canonical_instruction_file = std::fs::canonicalize(&instruction_file).unwrap();
        assert!(persona_instruction_file_is_referenced(
            &canonical_instruction_file,
            Some(&project_sources),
        ));
    }

    #[cfg(unix)]
    #[test]
    fn deleting_persona_rejects_instruction_file_symlink_paths() {
        let root = TempCatalogDir::new();
        let canonical_root = std::fs::canonicalize(&root.0).unwrap();
        let personas = canonical_root.join("personas");
        std::fs::create_dir_all(&personas).unwrap();
        let target = personas.join("target.md");
        let instruction_link = canonical_root.join("linked.md");
        let directory_link = canonical_root.join("persona-alias");
        let external_directory = canonical_root.join("outside");
        let external_directory_link = canonical_root.join("outside-alias");
        std::fs::create_dir_all(&external_directory).unwrap();
        let external_instruction = external_directory.join("instruction.md");
        std::fs::write(&target, "keep this file").unwrap();
        std::fs::write(&external_instruction, "leave external file").unwrap();
        std::os::unix::fs::symlink(&target, &instruction_link).unwrap();
        std::os::unix::fs::symlink(&personas, &directory_link).unwrap();
        std::os::unix::fs::symlink(&external_directory, &external_directory_link).unwrap();
        let config = canonical_root.join("config.toml");
        std::fs::write(
            &config,
            format!(
                "[subagents.personas.file_link]\ninstructions_file = {:?}\n[subagents.personas.parent_link]\ninstructions_file = {:?}\n[subagents.personas.external_parent]\ninstructions_file = {:?}\n",
                instruction_link.to_string_lossy(),
                directory_link.join("target.md").to_string_lossy(),
                external_directory_link.join("instruction.md").to_string_lossy(),
            ),
        )
        .unwrap();
        let scope = AgentDefinitionScopePaths {
            root: canonical_root,
            config: config.clone(),
            label: "user",
        };

        assert!(delete_user_definition_file_in_scope(&scope, "persona", "file_link").is_err());
        assert!(delete_user_definition_file_in_scope(&scope, "persona", "parent_link").is_err());
        assert!(
            delete_user_definition_file_in_scope(&scope, "persona", "external_parent").is_err()
        );
        assert!(std::fs::symlink_metadata(&instruction_link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::symlink_metadata(&directory_link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::symlink_metadata(&external_directory_link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "keep this file");
        assert_eq!(
            std::fs::read_to_string(external_instruction).unwrap(),
            "leave external file"
        );
        let config_source = std::fs::read_to_string(config).unwrap();
        assert!(config_source.contains("[subagents.personas.file_link]"));
        assert!(config_source.contains("[subagents.personas.parent_link]"));
        assert!(config_source.contains("[subagents.personas.external_parent]"));
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
        let table =
            ensure_subagent_definition_table(&mut persona_document, "personas", "writer").unwrap();
        apply_persona_config_fields(table, &persona, "/grok/personas/writer.md").unwrap();

        let parsed_persona: toml::Value = toml::from_str(&persona_document.to_string()).unwrap();
        let definition = &parsed_persona["subagents"]["personas"]["writer"];
        assert_eq!(
            definition["instructions_file"].as_str(),
            Some("/grok/personas/writer.md")
        );
        assert!(definition.get("instructions").is_none());
        assert!(definition.get("model").is_none());
        assert!(definition.get("reasoning_effort").is_none());
        assert!(definition.get("default_isolation").is_none());
    }

    #[test]
    fn shared_and_independent_modes_use_their_effective_config() {
        let shared = PathBuf::from("/user/.grok");
        let independent = PathBuf::from("/app/agent-home");
        assert_eq!(
            discovery_config_path(&shared, &independent, false),
            shared.join("config.toml")
        );
        assert_eq!(
            discovery_config_path(&shared, &independent, true),
            independent.join("config.toml")
        );
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
        std::fs::write(
            &definition,
            "---\ndescription: Active agent\n---\nprivate instructions",
        )
        .unwrap();
        let mut warnings = Vec::new();
        let discovered = scan_user_agent_defs(&shared_agents, &active_agents, true, &mut warnings);
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].path, definition.to_string_lossy());
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
        std::fs::write(
            active_agents.join("independent.md"),
            "independent definition",
        )
        .unwrap();

        let mut warnings = Vec::new();
        let discovered = scan_user_agent_defs(&shared_agents, &active_agents, false, &mut warnings);

        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0].path,
            shared_agents.join("shared.md").to_string_lossy()
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn configured_definition_is_included_or_marks_matching_scan_row() {
        let root = TempCatalogDir::new();
        let config = root.join("config.toml");
        let outside = root.join("outside").join("chosen.markdown");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        std::fs::write(
            &outside,
            "---\ndescription: Chosen\n---\nprivate instructions",
        )
        .unwrap();
        std::fs::write(
            &config,
            format!("[agent]\ndefinition = {:?}\n", outside.to_string_lossy()),
        )
        .unwrap();
        let (mut roles, mut personas, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
        let configured = discover_inline_definitions_in_home(
            &config,
            &root,
            &root,
            &mut roles,
            &mut personas,
            &mut warnings,
        )
        .unwrap();
        let mut agents = vec![];
        add_configured_definition(&mut agents, &configured);
        let agents = map_agent_workspace_definitions(agents, Some(&configured));
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].scope, "config");
        assert!(agents[0].is_default);
        assert_eq!(agents[0].description.as_deref(), Some("Chosen"));
        assert!(!serde_json::to_string(&agents)
            .unwrap()
            .contains("private instructions"));

        let scanned = AgentDefDto {
            name: "chosen".into(),
            path: outside.to_string_lossy().to_string(),
            scope: "user".into(),
            description: None,
        };
        let mut agents = vec![scanned.clone()];
        add_configured_definition(&mut agents, &configured);
        let agents = map_agent_workspace_definitions(agents, Some(&configured));
        assert_eq!(agents.len(), 1);
        assert!(agents[0].is_default);
        assert_eq!(agents[0].path, scanned.path);
        assert!(warnings.is_empty());
    }

    #[test]
    fn configured_project_agent_is_visible_only_in_its_origin_scope() {
        let root = TempCatalogDir::new();
        let active_home = root.join("agent-home");
        let global_agents = active_home.join("agents");
        let project_a_agents = root.join("project-a/.grok/agents");
        let project_b_agents = root.join("project-b/.grok/agents");
        std::fs::create_dir_all(&global_agents).unwrap();
        std::fs::create_dir_all(&project_a_agents).unwrap();
        std::fs::create_dir_all(&project_b_agents).unwrap();
        let project_agent = project_a_agents.join("agent-for-project-a.md");
        std::fs::write(&project_agent, "project agent").unwrap();
        let project_agent = std::fs::canonicalize(project_agent).unwrap();
        let global_agents = std::fs::canonicalize(global_agents).unwrap();
        let project_a_agents = std::fs::canonicalize(project_a_agents).unwrap();
        let project_b_agents = std::fs::canonicalize(project_b_agents).unwrap();
        let saved_project_agent_dirs = vec![project_a_agents.clone(), project_b_agents];

        assert!(!configured_agent_is_visible_in_scope(
            &project_agent.to_string_lossy(),
            &active_home,
            None,
            &saved_project_agent_dirs,
        ));
        assert!(!configured_agent_is_visible_in_scope(
            &project_agent.to_string_lossy(),
            &active_home,
            Some(root.join("project-b").to_str().unwrap()),
            &saved_project_agent_dirs,
        ));
        assert!(configured_agent_is_visible_in_scope(
            &project_agent.to_string_lossy(),
            &active_home,
            Some(root.join("project-a").to_str().unwrap()),
            &saved_project_agent_dirs,
        ));
        assert!(configured_agent_is_visible_in_scope(
            &global_agents.join("global-agent.md").to_string_lossy(),
            &active_home,
            Some(root.join("project-b").to_str().unwrap()),
            &saved_project_agent_dirs,
        ));
    }

    #[test]
    fn configured_definition_rejects_non_markdown_and_oversized_files() {
        let root = TempCatalogDir::new();
        let config = root.join("config.toml");
        let bad = root.join("definition.toml");
        std::fs::write(&bad, "private = true").unwrap();
        let mut warnings = Vec::new();
        assert!(
            validate_configured_definition(&bad.to_string_lossy(), &config, &mut warnings)
                .is_none()
        );
        let large = root.join("large.md");
        std::fs::write(&large, vec![b'x'; MAX_AGENT_DEFINITION_BYTES as usize + 1]).unwrap();
        assert!(
            validate_configured_definition(&large.to_string_lossy(), &config, &mut warnings)
                .is_none()
        );
        assert_eq!(warnings.len(), 2);
    }
}
