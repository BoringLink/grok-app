import type { AgentDefLike } from "@/lib/agentsDiscovery";
import type { AgentDefDto, AgentDefinitionDto } from "@/lib/api/agents";
import type { ProjectRecord } from "@/lib/api/project";

export type AgentWorkspaceView = "agents" | "roles" | "personas";

export type AgentScopeOption = { value: string; label: string };

const PROJECT_SCOPE_PREFIX = "project:";

/** Build a scope menu from saved Projects whose paths are available. */
export function agentProjectScopeOptions(
  projects: ProjectRecord[],
  globalLabel: string,
): AgentScopeOption[] {
  return [
    { value: "global", label: globalLabel },
    ...projects
      .filter(
        (project) =>
          !project.system &&
          !project.sshAlias &&
          project.pathOk &&
          !!project.path.trim(),
      )
      .map((project) => ({
        value: `${PROJECT_SCOPE_PREFIX}${project.id}`,
        label: project.name,
      })),
  ];
}

/** Resolve a scope selection to its saved Project id, or null for Global. */
export function agentProjectIdForScope(selection: string): string | null {
  return selection.startsWith(PROJECT_SCOPE_PREFIX)
    ? selection.slice(PROJECT_SCOPE_PREFIX.length)
    : null;
}

/** Resolve a selected saved Project to its primary path. */
export function agentProjectPathForScope(
  projects: ProjectRecord[],
  selection: string,
): string | null {
  const projectId = agentProjectIdForScope(selection);
  if (!projectId) return null;
  const project = projects.find(
    (item) => item.id === projectId && !item.system && !item.sshAlias && item.pathOk,
  );
  return project?.path.trim() ? project.path : null;
}

/** Only offer Personas backed by a readable instruction file for reuse. */
export function reusablePersonaDefinitions(
  personas: AgentDefinitionDto[],
): AgentDefinitionDto[] {
  return personas.filter(
    (persona) => Boolean(persona.instructionsFile?.trim() && persona.instructions?.trim()),
  );
}

export function canManageAgentWorkspace(sessionDataMode?: string): boolean {
  return (sessionDataMode ?? "").trim().toLowerCase() === "independent";
}

export function isCurrentAgentCatalogRequest(
  requestedSequence: number,
  currentSequence: number,
  requestedProjectPath: string | null | undefined,
  currentProjectPath: string | null | undefined,
): boolean {
  return (
    requestedSequence === currentSequence &&
    requestedProjectPath === currentProjectPath
  );
}

export function mapAgentDefinitions(agents: AgentDefDto[]): AgentDefLike[] {
  return agents.map((agent) => ({
    name: agent.name,
    path: agent.path,
    scope: (agent.scope as AgentDefLike["scope"]) || "user",
    description: agent.description ?? null,
    isDefault: agent.isDefault,
  }));
}
