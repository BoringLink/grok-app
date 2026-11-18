/**
 * @vitest-environment jsdom
 */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ProvidersListResult } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  providersList: vi.fn(),
  providersUpsert: vi.fn(),
  providersListModels: vi.fn(),
  secretsGetMasked: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  isTauri: () => true,
  providersList: mocks.providersList,
  secretsGetMasked: mocks.secretsGetMasked,
  providersBalance: vi.fn(),
  providersCcSwitchImport: vi.fn(),
  providersCcSwitchScan: vi.fn(),
  providersListModels: mocks.providersListModels,
  providersRemove: vi.fn(),
  providersTestModel: vi.fn(),
  providersUpsert: mocks.providersUpsert,
  openExternalUrl: vi.fn(),
  secretsSet: vi.fn(),
}));

import { ProvidersPanel } from "./ProvidersPanel";

const corruptProvider = {
  id: "relay",
  name: "Relay",
  baseUrl: "https://relay.example/v1",
  model: "m1",
  models: [{ id: "m1", name: "m1" }],
  modelCatalogCorrupt: true,
  hasApiKey: true,
  apiBackend: "chat_completions",
  providerMode: "generic",
  isDefault: false,
};

const healthyProvider = {
  ...corruptProvider,
  id: "good-relay",
  name: "Good relay",
  modelCatalogCorrupt: false,
};

const listResult: ProvidersListResult = {
  providers: [corruptProvider, healthyProvider],
  defaultModel: null,
  configPath: "",
  agentHome: "",
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mocks.providersList.mockResolvedValue(listResult);
  mocks.secretsGetMasked.mockResolvedValue({ hasOfficialKey: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(<ProvidersPanel locale="en" />);
}

describe("ProvidersPanel route activation", () => {
  it("does not offer a global Use action on provider cards", async () => {
    renderPanel();

    await screen.findByRole("button", { name: /Relay/ });

    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
    expect(screen.queryByText("Use")).toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
  });
});

describe("ProvidersPanel corrupt catalog", () => {
  it("disables model settings for an untouched corrupt catalog", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /Relay/ }));

    expect(
      screen.getByText(/The saved model catalog can't be read/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model settings" })).toBeDisabled();
  });

  it("keeps model settings enabled for a readable catalog", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: /Good relay/ }),
    );

    expect(
      screen.queryByText(/The saved model catalog can't be read/),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Model settings" }),
    ).toBeEnabled();
  });

  it("lists readable rows from a partially invalid catalog and keeps the warning", async () => {
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [
        {
          ...corruptProvider,
          models: [
            { id: "m1", name: "M1" },
            { id: "m2", name: "M2" },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /Relay/ }));

    expect(screen.getByDisplayValue("m1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("m2")).toBeInTheDocument();
    expect(
      screen.getByText(/The saved model catalog can't be read/),
    ).toBeInTheDocument();
    const gears = screen.getAllByRole("button", { name: "Model settings" });
    expect(gears).toHaveLength(2);
    expect(gears.every((gear) => (gear as HTMLButtonElement).disabled)).toBe(
      true,
    );
  });

  it("disables model settings for a create that collides with a corrupt id", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Add provider" }),
    );
    await user.click(await screen.findByText("Custom"));
    await user.type(screen.getByPlaceholderText("e.g. Work relay"), "Relay");
    await user.type(screen.getAllByLabelText("Model id")[0], "preset-model");
    await user.click(screen.getByRole("button", { name: "Add model" }));

    expect(
      screen.getByText(/The saved model catalog can't be read/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model settings" })).toBeDisabled();
  });

  it("blocks a save that leaves a model row without an id", async () => {
    mocks.providersUpsert.mockResolvedValue(listResult);
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: /Good relay/ }),
    );
    await user.clear(screen.getAllByLabelText("Model id")[0]!);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Every request model row needs a model id. Enter an id or remove the row.",
      ),
    ).toBeInTheDocument();
    expect(mocks.providersUpsert).not.toHaveBeenCalled();
  });

  it("keeps the stored channel model and metadata on an unrelated save", async () => {
    // Only `m2` survives the corrupt read; the channel still runs `m1` with its
    // own window / vision / efforts. A name-and-key save must not promote the
    // recovered row onto the channel.
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [
        {
          ...corruptProvider,
          model: "m1",
          contextWindow: 32000,
          supportsVision: true,
          efforts: [{ id: "high", name: "High", isDefault: true }],
          models: [
            {
              id: "m2",
              name: "M2",
              contextWindow: 64000,
              supportsVision: false,
              efforts: [{ id: "low", name: "Low", isDefault: true }],
            },
          ],
        },
      ],
    });
    mocks.providersUpsert.mockResolvedValue(listResult);

    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /Relay/ }));
    const name = screen.getByDisplayValue("Relay");
    await user.clear(name);
    await user.type(name, "Relay renamed");
    await user.type(
      screen.getByPlaceholderText("Leave blank to keep saved key"),
      "sk-new",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const payload = mocks.providersUpsert.mock.calls[0]?.[0];
    expect(payload?.name).toBe("Relay renamed");
    expect(payload?.apiKey).toBe("sk-new");
    expect(payload?.model).toBe("m1");
    expect(payload?.models).toBeUndefined();
    expect(payload?.contextWindow).toBe(32000);
    expect(payload?.supportsVision).toBe(true);
    expect(payload?.efforts?.map((e: { id: string }) => e.id)).toEqual([
      "high",
    ]);
  });
});

describe("ProvidersPanel per-model metadata", () => {
  function metadataProvider(overrides: Record<string, unknown> = {}) {
    return {
      ...healthyProvider,
      contextWindow: 200_000,
      efforts: [{ id: "high", name: "High", isDefault: true }],
      models: [
        {
          id: "m1",
          name: "M1",
          contextWindow: 128_000,
          supportsVision: true,
          efforts: [{ id: "high", name: "High", isDefault: true }],
        },
        {
          id: "m2",
          name: "M2",
          contextWindow: 512_000,
          contextWindowSource: "remote",
          effortsSource: "remote",
          efforts: [{ id: "low", name: "Low", isDefault: true }],
          supportsReasoningEffort: true,
          supportsReasoningEffortSource: "remote",
        },
      ],
      ...overrides,
    };
  }

  it("updates API-sourced rows on refresh and keeps user overrides", async () => {
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [metadataProvider()],
    });
    mocks.providersListModels.mockResolvedValue({
      endpoint: "https://relay.example/v1/models",
      models: [
        {
          id: "m1",
          contextWindow: 1_048_576,
          reasoningEfforts: [{ id: "low" }, { id: "medium" }],
          supportsReasoningEffort: true,
          supportsVision: true,
        },
        {
          id: "m2",
          contextWindow: 640_000,
          reasoningEfforts: [{ id: "low" }, { id: "medium" }],
          supportsReasoningEffort: false,
          supportsVision: false,
        },
      ],
    });
    mocks.providersUpsert.mockResolvedValue(listResult);

    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: /Good relay/ }),
    );
    await user.click(screen.getByRole("button", { name: "Fetch models" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const payload = mocks.providersUpsert.mock.calls[0]?.[0];
    const rows = payload?.models as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    const userRow = rows.find((row) => row.id === "m1");
    expect(userRow?.contextWindow).toBe(128_000);
    expect(userRow?.contextWindowSource).toBe("user");
    expect(userRow?.supportsVision).toBe(true);
    expect(
      (userRow?.efforts as Array<{ id: string }>).map((effort) => effort.id),
    ).toEqual(["high"]);

    const remoteRow = rows.find((row) => row.id === "m2");
    expect(remoteRow?.contextWindow).toBe(640_000);
    expect(remoteRow?.contextWindowSource).toBe("remote");
    expect(remoteRow?.supportsReasoningEffort).toBe(true);
    expect(remoteRow?.supportsReasoningEffortSource).toBe("remote");
    expect(
      (remoteRow?.efforts as Array<{ id: string; isDefault?: boolean }>).map(
        (effort) => effort.id,
      ),
    ).toEqual(["low", "medium"]);
    // 无 API default 时取首个非 none 档（与 Composer/Host 默认规则一致）。
    expect(
      (remoteRow?.efforts as Array<{ id: string; isDefault?: boolean }>).find(
        (effort) => effort.isDefault,
      )?.id,
    ).toBe("low");
  });

  it("keeps user overrides across repeated refreshes and applies the newest remote value", async () => {
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [metadataProvider()],
    });
    mocks.providersListModels
      .mockResolvedValueOnce({
        endpoint: "https://relay.example/v1/models",
        models: [
          {
            id: "m1",
            contextWindow: 1_048_576,
            reasoningEfforts: [{ id: "low" }, { id: "high" }],
          },
          { id: "m2", contextWindow: 640_000 },
        ],
      })
      .mockResolvedValueOnce({
        endpoint: "https://relay.example/v1/models",
        models: [
          {
            id: "m1",
            contextWindow: 2_000_000,
            reasoningEfforts: [{ id: "minimum" }, { id: "maximum" }],
          },
          { id: "m2", contextWindow: 700_000 },
        ],
      });
    mocks.providersUpsert.mockResolvedValue(listResult);

    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: /Good relay/ }),
    );
    await user.click(screen.getByRole("button", { name: "Fetch models" }));
    await waitFor(() =>
      expect(mocks.providersListModels).toHaveBeenCalledTimes(1),
    );
    await user.click(screen.getByRole("button", { name: "Fetch models" }));
    await waitFor(() =>
      expect(mocks.providersListModels).toHaveBeenCalledTimes(2),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const payload = mocks.providersUpsert.mock.calls[0]?.[0];
    const rows = payload?.models as Array<Record<string, unknown>>;
    const userRow = rows.find((row) => row.id === "m1");
    expect(userRow?.contextWindow).toBe(128_000);
    expect(userRow?.contextWindowSource).toBe("user");
    expect(
      (userRow?.efforts as Array<{ id: string }>).map((effort) => effort.id),
    ).toEqual(["high"]);

    const remoteRow = rows.find((row) => row.id === "m2");
    expect(remoteRow?.contextWindow).toBe(700_000);
    expect(remoteRow?.contextWindowSource).toBe("remote");
  });

  it("seeds an added API model with the 1M / four-level fallbacks", async () => {
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [metadataProvider({ id: "empty-relay", name: "Empty relay", models: [] })],
    });
    mocks.providersListModels.mockResolvedValue({
      endpoint: "https://relay.example/v1/models",
      models: [{ id: "plain-model" }],
    });
    mocks.providersUpsert.mockResolvedValue(listResult);

    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: /Empty relay/ }),
    );
    await user.click(screen.getByRole("button", { name: "Fetch models" }));
    await user.click(screen.getByTitle("plain-model"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const payload = mocks.providersUpsert.mock.calls[0]?.[0];
    const rows = payload?.models as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contextWindow).toBe(1_000_000);
    expect(rows[0]?.contextWindowSource).toBe("fallback");
    expect(
      (rows[0]?.efforts as Array<{ id: string }>).map((effort) => effort.id),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(rows[0]?.supportsReasoningEffort).toBe(true);
    expect(rows[0]?.supportsReasoningEffortSource).toBe("fallback");
    expect(rows[0]?.supportsVision).toBeUndefined();
    expect(rows[0]?.supportsVideo).toBeUndefined();
  });

  it("persists gear edits as user overrides", async () => {
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [metadataProvider()],
    });
    mocks.providersUpsert.mockResolvedValue(listResult);

    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: /Good relay/ }),
    );
    await user.click(screen.getAllByRole("button", { name: "Model settings" })[0]!);
    const contextWindow = screen.getByLabelText("Context window");
    await user.clear(contextWindow);
    await user.type(contextWindow, "256000");
    await user.click(
      screen.getByRole("checkbox", { name: "Allow Off in Composer" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const payload = mocks.providersUpsert.mock.calls[0]?.[0];
    const rows = payload?.models as Array<Record<string, unknown>>;
    const edited = rows.find((row) => row.id === "m1");
    expect(edited?.contextWindow).toBe(256000);
    expect(edited?.contextWindowSource).toBe("user");
    expect(edited?.supportsReasoningEffort).toBe(true);
    expect(edited?.supportsReasoningEffortSource).toBe("user");
    expect(edited?.supportsReasoningOff).toBe(true);
    expect(edited?.supportsVision).toBe(true);
    expect(payload?.contextWindow).toBe(256000);
  });

  it("keeps the catalog when the API returns an empty model list", async () => {
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [metadataProvider()],
    });
    mocks.providersListModels.mockResolvedValue({
      endpoint: "https://relay.example/v1/models",
      models: [],
    });
    mocks.providersUpsert.mockResolvedValue(listResult);
    const onToast = vi.fn();

    const user = userEvent.setup();
    render(<ProvidersPanel locale="en" onToast={onToast} />);

    await user.click(
      await screen.findByRole("button", { name: /Good relay/ }),
    );
    await user.click(screen.getByRole("button", { name: "Fetch models" }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("No models returned", 2800),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const payload = mocks.providersUpsert.mock.calls[0]?.[0];
    expect(payload?.models).toBeUndefined();
  });

  it("keeps the catalog when fetching models fails", async () => {
    mocks.providersList.mockResolvedValue({
      ...listResult,
      providers: [metadataProvider()],
    });
    mocks.providersListModels.mockRejectedValue(
      new Error("request timed out after 10s"),
    );
    mocks.providersUpsert.mockResolvedValue(listResult);
    const onToast = vi.fn();

    const user = userEvent.setup();
    render(<ProvidersPanel locale="en" onToast={onToast} />);

    await user.click(
      await screen.findByRole("button", { name: /Good relay/ }),
    );
    await user.click(screen.getByRole("button", { name: "Fetch models" }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        "Probe timed out. Check base URL and network, then retry.",
        4000,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const payload = mocks.providersUpsert.mock.calls[0]?.[0];
    expect(payload?.models).toBeUndefined();
  });
});

describe("ProvidersPanel pending anchor deep link", () => {
  it("opens the first provider form so a models anchor can be focused", async () => {
    const onPendingAnchorMounted = vi.fn();
    render(
      <ProvidersPanel
        locale="en"
        pendingAnchor="settings-anchor-prov-models"
        onPendingAnchorMounted={onPendingAnchorMounted}
      />,
    );

    expect(await screen.findByTestId("provider-form")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Edit provider" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Relay")).toBeInTheDocument();
    expect(
      document.getElementById("settings-anchor-prov-models"),
    ).not.toBeNull();
    await waitFor(() =>
      expect(onPendingAnchorMounted).toHaveBeenCalledTimes(1),
    );
  });

  it("opens the create form when no provider exists", async () => {
    mocks.providersList.mockResolvedValue({
      providers: [],
      defaultModel: null,
      configPath: "",
      agentHome: "",
    });

    render(
      <ProvidersPanel
        locale="en"
        pendingAnchor="settings-anchor-prov-models"
      />,
    );

    expect(await screen.findByTestId("provider-form")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Add provider" }),
    ).toBeInTheDocument();
    expect(
      document.getElementById("settings-anchor-prov-models"),
    ).not.toBeNull();
  });

  it.each([
    "settings-anchor-prov-extra-headers",
    "settings-anchor-provider-mode",
  ])("opens the form for %s", async (anchorId) => {
    const onPendingAnchorMounted = vi.fn();
    render(
      <ProvidersPanel
        locale="en"
        pendingAnchor={anchorId}
        onPendingAnchorMounted={onPendingAnchorMounted}
      />,
    );

    expect(await screen.findByTestId("provider-form")).toBeInTheDocument();
    expect(document.getElementById(anchorId)).not.toBeNull();
    await waitFor(() =>
      expect(onPendingAnchorMounted).toHaveBeenCalledTimes(1),
    );
  });

  it("keeps the empty right pane for anchors outside the form", async () => {
    render(
      <ProvidersPanel
        locale="en"
        pendingAnchor="settings-anchor-account-providers"
      />,
    );

    await screen.findByRole("button", { name: /Relay/ });
    expect(screen.queryByTestId("provider-form")).toBeNull();
    expect(
      screen.getByText("Select a provider or add a new one."),
    ).toBeInTheDocument();
  });

  it("keeps the empty right pane without a pending anchor", async () => {
    renderPanel();

    await screen.findByRole("button", { name: /Relay/ });
    expect(screen.queryByTestId("provider-form")).toBeNull();
    expect(
      screen.getByText("Select a provider or add a new one."),
    ).toBeInTheDocument();
  });

  it("applies the search-hit highlight to the focused anchor", async () => {
    render(
      <ProvidersPanel
        locale="en"
        pendingAnchor="settings-anchor-prov-models"
        rowHighlight={(anchorId) =>
          anchorId === "settings-anchor-prov-models" ? " is-search-hit" : ""
        }
      />,
    );

    const anchor = await waitFor(() => {
      const el = document.getElementById("settings-anchor-prov-models");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(anchor.className).toContain("is-search-hit");
    expect(
      document.getElementById("settings-anchor-prov-extra-headers")?.className,
    ).not.toContain("is-search-hit");
  });
});
