import { describe, expect, it } from "vitest";
import {
  canManageAgentWorkspace,
  agentProjectPathForScope,
  agentWorkspaceIdForScope,
  agentWorkspaceScopeOptions,
  isCurrentAgentCatalogRequest,
  mapAgentDefinitions,
} from "./agentsWorkspace";

const workspaces = [
  {
    id: "workspace-a",
    name: "Project A",
    primaryProjectId: "project-a",
    roots: [{ path: "/work/project-a", role: "primary" as const, access: "write" as const, pathOk: true }],
    capability: "contextOnly" as const,
    updatedAt: "2026-11-24T00:00:00.000Z",
  },
  {
    id: "workspace-missing",
    name: "Missing root",
    primaryProjectId: "project-missing",
    roots: [{ path: "/work/missing", role: "primary" as const, access: "write" as const, pathOk: false }],
    capability: "contextOnly" as const,
    updatedAt: "2026-11-24T00:00:00.000Z",
  },
];

describe("Agent scope selection", () => {
  it("lists Global and only saved workspaces with a usable primary root", () => {
    expect(agentWorkspaceScopeOptions(workspaces, "Global")).toEqual([
      { value: "global", label: "Global" },
      { value: "workspace:workspace-a", label: "Project A" },
    ]);
  });

  it("resolves Global and selected workspace paths", () => {
    expect(agentProjectPathForScope(workspaces, "global")).toBeNull();
    expect(agentProjectPathForScope(workspaces, "workspace:workspace-a")).toBe("/work/project-a");
    expect(agentProjectPathForScope(workspaces, "workspace:workspace-missing")).toBeNull();
    expect(agentWorkspaceIdForScope("workspace:workspace-a")).toBe("workspace-a");
  });
});

describe("canManageAgentWorkspace", () => {
  it("keeps Shared mode read-only and enables Independent workspace actions", () => {
    expect(canManageAgentWorkspace()).toBe(false);
    expect(canManageAgentWorkspace("shared")).toBe(false);
    expect(canManageAgentWorkspace("independent")).toBe(true);
    expect(canManageAgentWorkspace(" Independent ")).toBe(true);
    expect(canManageAgentWorkspace("unknown")).toBe(false);
  });
});

describe("mapAgentDefinitions", () => {
  it("preserves the host default flag and definition metadata", () => {
    const agents = [
      {
        name: "configured-agent",
        path: "/home/user/.grok/agents/configured-agent.md",
        scope: "user",
        isDefault: true,
      },
      {
        name: "other-agent",
        path: "/home/user/.grok/agents/other-agent.md",
        scope: "user",
        isDefault: false,
      },
    ];

    expect(mapAgentDefinitions(agents)).toEqual([
      { ...agents[0], description: null },
      { ...agents[1], description: null },
    ]);
  });
});

describe("isCurrentAgentCatalogRequest", () => {
  it("ignores stale responses after a request or project changes", () => {
    expect(isCurrentAgentCatalogRequest(3, 3, "/project/a", "/project/a")).toBe(true);
    expect(isCurrentAgentCatalogRequest(2, 3, "/project/a", "/project/a")).toBe(false);
    expect(isCurrentAgentCatalogRequest(3, 3, "/project/a", "/project/b")).toBe(false);
  });
});
