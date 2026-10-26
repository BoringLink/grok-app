/**
 * @vitest-environment jsdom
 */
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import * as api from "@/lib/api";
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

afterEach(() => {
  cleanup();
  vi.mocked(api.automationsList).mockReset();
  vi.mocked(api.automationsList).mockResolvedValue([]);
  vi.mocked(api.automationCreate).mockReset();
  vi.mocked(api.automationUpdate).mockReset();
});

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

const otherRelay = {
  id: "relay-b",
  name: "Relay B",
  model: "llama-3",
  baseUrl: "https://other.example/v1",
  models: [{ id: "llama-3", name: "Llama 3" }],
};

function legacyRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "auto-legacy",
    title: "Legacy nightly",
    prompt: "Summarize overnight mail",
    enabled: true,
    projectId: null,
    modelId: "qwen3.8-max",
    providerId: null,
    effort: "high",
    sessionMode: "new",
    sessionId: null,
    frequency: "daily",
    time: "09:00",
    weekdays: [],
    notify: "all",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function submitForm(buttonName: string) {
  const form = screen.getByRole("complementary", {
    name: "automations.formTitle",
  });
  fireEvent.click(within(form).getByRole("button", { name: buttonName }));
}

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

    fireEvent.change(screen.getByPlaceholderText("automations.field.titlePh"), {
      target: { value: "Nightly digest" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("automations.field.promptPh"),
      { target: { value: "Summarize overnight mail" } },
    );
    submitForm("automations.create");
    await waitFor(() =>
      expect(api.automationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "relay-a",
          modelId: "qwen3.8-max",
        }),
      ),
    );
  });

  it("infers the only custom provider that lists a legacy model", async () => {
    vi.mocked(api.automationsList).mockResolvedValue([legacyRow()] as never);
    renderPage({
      providers: [relay, otherRelay],
      defaultProviderId: "official",
      defaultModelId: "grok-4.7",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Legacy nightly/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "automations.field.model" }),
      ).toHaveTextContent(/Relay A · Qwen 3.8 Max/),
    );
    expect(
      screen.getByRole("button", { name: "automations.field.model" }),
    ).not.toHaveTextContent(/Relay B/);

    submitForm("automations.save");
    await waitFor(() =>
      expect(api.automationUpdate).toHaveBeenCalledWith(
        "auto-legacy",
        expect.objectContaining({
          providerId: "relay-a",
          modelId: "qwen3.8-max",
        }),
      ),
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

    fireEvent.change(screen.getByPlaceholderText("automations.field.titlePh"), {
      target: { value: "Remote digest" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("automations.field.promptPh"),
      { target: { value: "Check the host" } },
    );
    submitForm("automations.create");
    await waitFor(() =>
      expect(api.automationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "ssh-1",
          providerId: "official",
          modelId: "grok-4.7",
        }),
      ),
    );
  });

  it("pins an edited SSH task to the official route", async () => {
    vi.mocked(api.automationsList).mockResolvedValue([
      legacyRow({
        id: "auto-ssh",
        title: "Remote nightly",
        projectId: "ssh-1",
        providerId: "relay-a",
      }),
    ] as never);
    renderPage({
      providers: [relay],
      defaultProviderId: relay.id,
      defaultModelId: "qwen3.8-max",
      projects: [{ id: "ssh-1", name: "Remote", isSshRemote: true }],
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Remote nightly/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "automations.field.model" }),
      ).toHaveTextContent(/composer.modelGroupOfficial/),
    );
    expect(
      screen.getByRole("button", { name: "automations.field.model" }),
    ).not.toHaveTextContent(/Relay A/);

    submitForm("automations.save");
    await waitFor(() =>
      expect(api.automationUpdate).toHaveBeenCalledWith(
        "auto-ssh",
        expect.objectContaining({
          projectId: "ssh-1",
          providerId: "official",
          modelId: "grok-4.7",
        }),
      ),
    );
  });
});
