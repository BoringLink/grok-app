import type { AgentDefLike } from "@/lib/agentsDiscovery";
import type { AgentDefDto } from "@/lib/api/agents";
import { primaryRoot, type WorkspaceRecord } from "@/lib/multiRootWorkspace";

export type AgentWorkspaceView = "agents" | "roles" | "personas";

export type AgentScopeOption = { value: string; label: string };

const WORKSPACE_SCOPE_PREFIX = "workspace:";

/** Build a scope menu from only saved workspaces with an available primary root. */
export function agentWorkspaceScopeOptions(
  workspaces: WorkspaceRecord[],
  globalLabel: string,
): AgentScopeOption[] {
  return [
    { value: "global", label: globalLabel },
    ...workspaces.flatMap((workspace) => {
      const root = primaryRoot(workspace);
      return root && root.pathOk !== false
        ? [{ value: `${WORKSPACE_SCOPE_PREFIX}${workspace.id}`, label: workspace.name }]
        : [];
    }),
  ];
}

/** Resolve a scope selection to its saved workspace id, or null for Global. */
export function agentWorkspaceIdForScope(selection: string): string | null {
  return selection.startsWith(WORKSPACE_SCOPE_PREFIX)
    ? selection.slice(WORKSPACE_SCOPE_PREFIX.length)
    : null;
}

/** Resolve a selected saved workspace to its primary project path. */
export function agentProjectPathForScope(
  workspaces: WorkspaceRecord[],
  selection: string,
): string | null {
  const workspaceId = agentWorkspaceIdForScope(selection);
  if (!workspaceId) return null;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const root = workspace ? primaryRoot(workspace) : null;
  return root && root.pathOk !== false ? root.path : null;
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
