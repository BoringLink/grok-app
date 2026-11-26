import { describe, expect, it } from "vitest";
import {
  canManageAgentWorkspace,
  agentProjectPathForScope,
  agentProjectIdForScope,
  agentProjectScopeOptions,
  reusablePersonaDefinitions,
  isCurrentAgentCatalogRequest,
  mapAgentDefinitions,
} from "./agentsWorkspace";

const projects = [
  {
    id: "project-a",
    name: "Project A",
    path: "/work/project-a",
    trusted: true,
    pathOk: true,
  },
  {
    id: "project-missing",
    name: "Missing root",
    path: "/work/missing",
    trusted: true,
    pathOk: false,
  },
  {
    id: "project-ssh",
    name: "Remote project",
    path: "/remote/project",
    trusted: true,
    pathOk: true,
    sshAlias: "remote-host",
  },
];

describe("Agent scope selection", () => {
  it("lists Global and only accessible local Projects", () => {
    expect(agentProjectScopeOptions(projects, "Global")).toEqual([
      { value: "global", label: "Global" },
      { value: "project:project-a", label: "Project A" },
    ]);
  });

  it("resolves Global and selected Project paths", () => {
    expect(agentProjectPathForScope(projects, "global")).toBeNull();
    expect(agentProjectPathForScope(projects, "project:project-a")).toBe("/work/project-a");
    expect(agentProjectPathForScope(projects, "project:project-missing")).toBeNull();
    expect(agentProjectIdForScope("project:project-a")).toBe("project-a");
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

describe("reusablePersonaDefinitions", () => {
  it("offers only Personas with a readable instruction file", () => {
    const personas = [
      { name: "readable", path: "/.grok/personas/readable.md", scope: "user", instructionsFile: "/.grok/personas/readable.md", instructions: "Be concise." },
      { name: "inline-only", path: "/.grok/config.toml", scope: "user", instructions: "Legacy inline." },
      { name: "missing-file", path: "/.grok/personas/missing.md", scope: "user", instructionsFile: "/.grok/personas/missing.md" },
    ];

    expect(reusablePersonaDefinitions(personas).map((persona) => persona.name)).toEqual([
      "readable",
    ]);
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
