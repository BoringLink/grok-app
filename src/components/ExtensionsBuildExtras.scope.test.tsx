/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  agentsList: vi.fn(),
  agentsOpenUserDirectory: vi.fn(),
  inspectMcp: vi.fn(),
  isTauri: vi.fn(),
  workspacesList: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, ...apiMocks };
});

import { ExtensionsBuildExtras } from "@/components/ExtensionsBuildExtras";

const savedWorkspace = {
  id: "workspace-a",
  name: "Project A",
  primaryProjectId: "project-a",
  roots: [
    {
      path: "/work/project-a",
      role: "primary" as const,
      access: "write" as const,
      pathOk: true,
    },
  ],
  capability: "contextOnly" as const,
  updatedAt: "2026-11-24T00:00:00.000Z",
};

const emptyCatalog = {
  agents: [],
  roles: [],
  personas: [],
  warnings: [],
  userAgentsDir: "/home/user/.grok/agents",
  projectAgentsDir: null,
  bundledAgentsDir: "/home/user/.grok/bundled/agents",
};

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.isTauri.mockReturnValue(true);
  apiMocks.workspacesList.mockResolvedValue([savedWorkspace]);
  apiMocks.agentsList.mockResolvedValue(emptyCatalog);
  apiMocks.inspectMcp.mockResolvedValue({ servers: [] });
  apiMocks.agentsOpenUserDirectory.mockResolvedValue(false);
});

describe("Agents workspace scope picker", () => {
  it("renders no search controls in Agent, Role, Persona, or scope options", async () => {
    const user = userEvent.setup();
    render(
      <ExtensionsBuildExtras
        locale="en"
        sessionDataMode="independent"
        mode="agents"
      />,
    );

    expect(screen.queryByRole("searchbox")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Roles" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Personas" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scope" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("places scope beside Open directory and opens the selected workspace directory", async () => {
    const user = userEvent.setup();
    render(
      <ExtensionsBuildExtras
        locale="en"
        sessionDataMode="independent"
        mode="agents"
      />,
    );

    const openGlobalDirectory = await screen.findByRole("button", {
      name: "Open user folder",
    });
    const scopePicker = screen.getByRole("button", { name: "Scope" });
    expect(
      openGlobalDirectory.compareDocumentPosition(scopePicker) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(scopePicker);
    await user.click(await screen.findByRole("button", { name: "Project A" }));
    await waitFor(() => {
      expect(apiMocks.agentsList).toHaveBeenLastCalledWith("/work/project-a");
    });

    const openProjectDirectory = screen.getByRole("button", {
      name: "Open project folder",
    });
    await user.click(openProjectDirectory);
    await waitFor(() => {
      expect(apiMocks.agentsOpenUserDirectory).toHaveBeenLastCalledWith(
        "agents",
        "project",
        "/work/project-a",
      );
    });
  });
});
