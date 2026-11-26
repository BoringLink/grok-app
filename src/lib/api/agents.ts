/** API domain: agents */

import {
  invoke,
} from "./host";

export type AgentCatalogEntry = {
  name: string;
  source: string;
  description?: string | null;
  path?: string | null;
};

export type AgentsCatalogResult = {
  agents: AgentCatalogEntry[];
};

export async function agentsCatalog(projectPath?: string | null) {
  return invoke<AgentsCatalogResult>("agents_catalog", {
    projectPath: projectPath ?? null,
  });
}

/** Agent, Role, or Persona definition row from host `agents_list`. */
export type AgentDefDto = {
  name: string;
  path: string;
  /** "project" | "user" | "bundled" | "config" */
  scope: string;
  description?: string | null;
  isDefault: boolean;
};

export type AgentDefinitionDto = {
  name: string;
  path: string;
  scope: string;
  description?: string | null;
  defaultCapabilityMode?: string | null;
  model?: string | null;
  promptFile?: string | null;
  prompt?: string | null;
  instructions?: string | null;
  instructionsFile?: string | null;
  inputs?: unknown;
  outputs?: unknown;
  reasoningEffort?: string | null;
  defaultIsolation?: string | null;
};

export type AgentDiscoveryWarningDto = {
  source: string;
  path: string;
  code:
    | "directoryRead"
    | "directoryTruncated"
    | "definitionRead"
    | "configRead"
    | "agentDefinitionInvalid";
};

export type AgentsListResult = {
  agents: AgentDefDto[];
  roles: AgentDefinitionDto[];
  personas: AgentDefinitionDto[];
  warnings: AgentDiscoveryWarningDto[];
  userAgentsDir: string;
  projectAgentsDir?: string | null;
  bundledAgentsDir?: string;
};

/** List Agent, Role, and Persona definitions (no CLI required). */
export async function agentsList(projectPath?: string | null) {
  return invoke<AgentsListResult>("agents_list", {
    projectPath: projectPath ?? null,
  });
}

export async function agentsOpenUserDirectory(
  kind: "agents" | "roles" | "personas",
  scope: "user" | "project" = "user",
  projectPath?: string | null,
) {
  return invoke<void>("agents_open_user_directory", {
    kind,
    scope,
    projectPath: projectPath ?? null,
  });
}

/** Discovered workflow script row from host `workflows_list`. */
export type WorkflowDefDto = {
  name: string;
  path: string;
  scope: string;
};

export type WorkflowsListResult = {
  workflows: WorkflowDefDto[];
  userDir?: string;
  projectDir?: string | null;
  agentHomeDir?: string | null;
  /** Bundled create-workflow skill path (may be missing on disk). */
  createWorkflowSkill?: string;
};

/**
 * Read-only soft-fail discovery of Grok Build workflow `.rhai` files.
 * No CLI required; missing dirs return an empty list.
 */
export async function workflowsList(projectPath?: string | null) {
  return invoke<WorkflowsListResult>("workflows_list", {
    projectPath: projectPath ?? null,
  });
}

/** Soft-fail headless workflow invoke result from host `workflows_run`. */
export type WorkflowRunResultDto = {
  ok: boolean;
  reason: string;
  workflowName: string;
  mode: string;
  log?: string | null;
  truncated?: boolean;
  durationMs?: number;
  cliPath?: string | null;
  cliVersion?: string | null;
  /** Always `headless_workflow_tool` — no top-level `grok workflow` subcommand. */
  invokePath?: string;
};

/**
 * Soft-fail headless run of a registered workflow by name.
 *
 * Host spawns short `grok -p` that must call the agent `workflow` tool
 * (no CLI `workflow` subcommand). Default mode `validate` = validate_only smoke.
 */
export async function workflowsRun(opts: {
  name: string;
  projectPath?: string | null;
  mode?: "validate" | "launch" | string | null;
  timeoutMs?: number | null;
}) {
  return invoke<WorkflowRunResultDto>("workflows_run", {
    name: opts.name,
    projectPath: opts.projectPath ?? null,
    mode: opts.mode ?? "validate",
    timeoutMs: opts.timeoutMs ?? null,
  });
}

/** Result of host `workflows_create` (template `.rhai` write). */
export type WorkflowsCreateResult = {
  name: string;
  path: string;
  scope: string;
  created: boolean;
  overwritten: boolean;
};

/**
 * Create a minimal `.rhai` workflow template under user (`~/.grok/workflows`)
 * or project (`.grok/workflows`). Refuses overwrite unless `force`.
 */
export async function workflowsCreate(opts: {
  name: string;
  scope?: "user" | "project" | string;
  projectPath?: string | null;
  force?: boolean;
}) {
  return invoke<WorkflowsCreateResult>("workflows_create", {
    name: opts.name,
    scope: opts.scope ?? "user",
    projectPath: opts.projectPath ?? null,
    force: opts.force ?? false,
  });
}

export type AgentDefinitionCreateResult = {
  name: string;
  path: string;
  scope: string;
  created: boolean;
  overwritten: boolean;
};

export type AgentMarkdownDefinitionDto = {
  path: string;
  scope: string;
  frontmatter: Record<string, unknown>;
  instructions: string;
};

export type AgentDefinitionFileInput = {
  kind: "role" | "persona";
  name: string;
  scope: "user" | "project";
  projectPath?: string | null;
  description?: string | null;
  instructions?: string | null;
  instructionsFile?: string | null;
  inputs?: unknown;
  outputs?: unknown;
  defaultCapabilityMode?: string | null;
  model?: string | null;
  promptFile?: string | null;
  prompt?: string | null;
  reasoningEffort?: string | null;
  defaultIsolation?: string | null;
};

export async function agentsCreateDefinition(opts: {
  name: string;
  description: string;
  instructions: string;
  scope: "user" | "project";
  projectPath?: string | null;
  force?: boolean;
  frontmatter?: Record<string, unknown>;
  path?: string | null;
}) {
  return invoke<AgentDefinitionCreateResult>("agents_create_definition", {
    input: {
      name: opts.name,
      description: opts.description,
      instructions: opts.instructions,
      scope: opts.scope,
      projectPath: opts.projectPath ?? null,
      force: opts.force ?? false,
      frontmatter: opts.frontmatter ?? null,
      path: opts.path ?? null,
    },
  });
}

export async function agentsReadMarkdownDefinition(
  path: string,
  scope: "user" | "project",
  projectPath?: string | null,
) {
  return invoke<AgentMarkdownDefinitionDto>("agents_read_markdown_definition", {
    path,
    scope,
    projectPath: projectPath ?? null,
  });
}

export async function agentsDeleteMarkdownDefinition(
  path: string,
  scope: "user" | "project",
  projectPath?: string | null,
) {
  return invoke<void>("agents_delete_markdown_definition", {
    path,
    scope,
    projectPath: projectPath ?? null,
  });
}

export async function agentsSetDefaultDefinition(
  path: string,
  projectPath?: string | null,
) {
  return invoke<void>("agents_set_default_definition", {
    path,
    projectPath: projectPath ?? null,
  });
}

export async function agentsUpsertFileDefinition(
  input: AgentDefinitionFileInput,
) {
  return invoke<void>("agents_upsert_file_definition", { input });
}

export async function agentsApplyPersona(input: {
  targetAgentType: string;
  targetScope: "user" | "project";
  targetProjectPath?: string | null;
  personaAgentType?: string | null;
  personaScope?: "user" | "project" | null;
  personaProjectPath?: string | null;
}) {
  return invoke<void>("agents_apply_persona", {
    targetAgentType: input.targetAgentType,
    targetScope: input.targetScope,
    targetProjectPath: input.targetProjectPath ?? null,
    personaAgentType: input.personaAgentType ?? null,
    personaScope: input.personaScope ?? null,
    personaProjectPath: input.personaProjectPath ?? null,
  });
}

export async function agentsDeleteFileDefinition(
  kind: "role" | "persona",
  name: string,
  scope: "user" | "project",
  projectPath?: string | null,
) {
  return invoke<void>("agents_delete_file_definition", {
    kind,
    name,
    scope,
    projectPath: projectPath ?? null,
  });
}
