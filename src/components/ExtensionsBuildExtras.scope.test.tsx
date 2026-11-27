/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  agentsList: vi.fn(),
  agentsDeleteMarkdownDefinition: vi.fn(),
  agentsOpenUserDirectory: vi.fn(),
  inspectMcp: vi.fn(),
  isTauri: vi.fn(),
  projectsList: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, ...apiMocks };
});

import { ExtensionsBuildExtras } from "@/components/ExtensionsBuildExtras";
import type { ExtAgentsTabActions } from "@/components/ExtensionsBuildExtras";

const savedWorkspace = {
  id: "project-a",
  name: "Project A",
  path: "/work/project-a",
  trusted: true,
  pathOk: true,
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
  apiMocks.projectsList.mockResolvedValue([savedWorkspace]);
  apiMocks.agentsList.mockResolvedValue(emptyCatalog);
  apiMocks.agentsDeleteMarkdownDefinition.mockResolvedValue(undefined);
  apiMocks.inspectMcp.mockResolvedValue({ servers: [] });
  apiMocks.agentsOpenUserDirectory.mockResolvedValue(false);
});

describe("Agents workspace scope picker", () => {
  it("rechecks Projects added while the Agents page remains mounted", async () => {
    const user = userEvent.setup();
    apiMocks.projectsList
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([savedWorkspace]);
    let actions: ExtAgentsTabActions | null = null;
    render(
      <ExtensionsBuildExtras
        locale="en"
        sessionDataMode="independent"
        mode="agents"
        hidePageToolbar
        onTabActionsChange={(nextActions) => {
          actions = nextActions;
        }}
      />,
    );

    const scopePicker = await screen.findByRole("button", { name: "Scope" });
    expect(scopePicker.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(actions).not.toBeNull());
    await act(async () => actions?.refresh());

    await waitFor(() => expect(apiMocks.projectsList).toHaveBeenCalledTimes(2));
    expect(scopePicker.hasAttribute("disabled")).toBe(false);
    await user.click(scopePicker);
    await user.click(await screen.findByRole("button", { name: "Project A" }));
    await waitFor(() => {
      expect(apiMocks.agentsList).toHaveBeenLastCalledWith("/work/project-a");
    });
  });

  it("shows only the empty-state copy after deleting an Agent", async () => {
    const user = userEvent.setup();
    apiMocks.agentsList.mockResolvedValueOnce({
      ...emptyCatalog,
      agents: [
        {
          name: "test-agent",
          path: "/home/user/.grok/agents/test-agent.md",
          scope: "user",
          description: "Agent for deletion test",
          isDefault: false,
        },
      ],
    });
    render(
      <ExtensionsBuildExtras
        locale="en"
        sessionDataMode="independent"
        mode="agents"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Delete test-agent" }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));

    await waitFor(() => {
      expect(apiMocks.agentsDeleteMarkdownDefinition).toHaveBeenCalledWith(
        "/home/user/.grok/agents/test-agent.md",
        "user",
        null,
      );
    });
    expect(await screen.findByText("No agent definition files found")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows discovery warnings across Agent, Role, and Persona views", async () => {
    const user = userEvent.setup();
    apiMocks.agentsList.mockResolvedValueOnce({
      ...emptyCatalog,
      warnings: [{
        source: "personas",
        path: "/home/user/.grok/personas",
        code: "directoryRead",
      }],
    });
    render(
      <ExtensionsBuildExtras
        locale="en"
        sessionDataMode="independent"
        mode="agents"
      />,
    );

    expect(await screen.findByText("Could not scan this definition folder.")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Roles" }));
    expect(screen.getByText("Could not scan this definition folder.")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Personas" }));
    expect(screen.getByText("Could not scan this definition folder.")).toBeTruthy();
  });

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
