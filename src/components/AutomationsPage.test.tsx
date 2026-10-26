/**
 * @vitest-environment jsdom
 */
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AutomationsPage } from "./AutomationsPage";

vi.mock("@/lib/api", () => ({
  isTauri: () => false,
  automationsList: vi.fn().mockResolvedValue([]),
  automationRunnerStatus: vi.fn().mockResolvedValue({
    running: false,
    tickIntervalSecs: 30,
    windowRequired: false,
    processRequired: true,
    enabledCount: 0,
    keepTrayForSchedules: false,
    honesty: "",
  }),
  schedulesLaunchAgentStatus: vi.fn().mockResolvedValue({
    supported: false,
    enabled: false,
    installed: false,
    honesty: "",
  }),
  schedulesLaunchAgentSetEnabled: vi.fn(),
  schedulesLaunchAgentRevealHelper: vi.fn(),
  automationCreate: vi.fn(),
  automationUpdate: vi.fn(),
  automationSetEnabled: vi.fn(),
  automationDelete: vi.fn(),
  automationMarkRun: vi.fn(),
}));

afterEach(() => cleanup());

const t = (key: string) => key;

const sessions = [
  {
    id: "chat-a-111111",
    title: "Same title",
    projectId: null,
    updatedAt: "2026-10-20T10:00:00Z",
  },
  {
    id: "chat-b-222222",
    title: "Same title",
    projectId: null,
    updatedAt: "2026-10-21T10:00:00Z",
  },
];

function renderPage(
  overrides: Partial<ComponentProps<typeof AutomationsPage>> = {},
) {
  return render(
    <AutomationsPage
      t={t}
      projects={[]}
      sessionOptions={sessions}
      onAiCreate={() => {}}
      {...overrides}
    />,
  );
}

const relay = {
  id: "relay-a",
  name: "Relay A",
  model: "qwen3.8-max",
  baseUrl: "https://relay.example/v1",
  models: [{ id: "qwen3.8-max", name: "Qwen 3.8 Max" }],
  efforts: [
    { id: "low", name: "Low" },
    { id: "high", name: "High", isDefault: true },
  ],
};

async function openCreate() {
  fireEvent.click(await screen.findByText("automations.create"));
  fireEvent.click(
    screen.getByRole("menuitem", { name: /automations.createManual/ }),
  );
}

describe("AutomationsPage route controls", () => {
  it("renders one model/effort pair and a session-keyed picker", async () => {
    renderPage();
    await openCreate();

    await waitFor(() =>
      expect(screen.getAllByText("automations.field.model")).toHaveLength(1),
    );
    expect(screen.getAllByText("automations.field.effort")).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "automations.field.runIn" }),
    );
    fireEvent.click(screen.getByText("automations.sessionMode.reuse"));

    await waitFor(() =>
      expect(screen.queryByText("automations.field.model")).toBeNull(),
    );
    expect(screen.getByText("automations.field.session")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "automations.field.session" }),
    );
    const search = screen.getByPlaceholderText(
      "automations.field.sessionSearchPh",
    );
    expect(screen.getByText(/Same title · .*#111111/)).toBeInTheDocument();
    expect(screen.getByText(/Same title · .*#222222/)).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "111111" } });
    expect(screen.queryByText(/Same title · .*#222222/)).toBeNull();
    const picked = screen.getByText(/Same title · .*#111111/);
    fireEvent.click(picked);
    expect(
      screen.getByRole("button", { name: "automations.field.session" }),
    ).toHaveTextContent(/Same title · .*#111111/);
  });

  it("starts a new task on the active custom provider", async () => {
    renderPage({
      providers: [relay],
      defaultProviderId: relay.id,
      defaultModelId: "qwen3.8-max",
    });
    await openCreate();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "automations.field.model" }),
      ).toHaveTextContent(/Relay A · Qwen 3.8 Max/),
    );
  });

  it("switches an SSH project to the official route", async () => {
    renderPage({
      providers: [relay],
      defaultProviderId: relay.id,
      defaultModelId: "qwen3.8-max",
      projects: [{ id: "ssh-1", name: "Remote", isSshRemote: true }],
    });
    await openCreate();
    expect(
      screen.getByRole("button", { name: "automations.field.model" }),
    ).toHaveTextContent(/Relay A/);

    fireEvent.click(
      screen.getByRole("button", { name: "automations.field.project" }),
    );
    fireEvent.click(screen.getByText("Remote"));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "automations.field.model" }),
      ).toHaveTextContent(/composer.modelGroupOfficial/),
    );
    expect(
      screen.getByRole("button", { name: "automations.field.model" }),
    ).not.toHaveTextContent(/Relay A/);
  });
});
