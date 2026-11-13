/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ProvidersListResult } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  providersList: vi.fn(),
  providersUpsert: vi.fn(),
  secretsGetMasked: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  isTauri: () => true,
  providersList: mocks.providersList,
  secretsGetMasked: mocks.secretsGetMasked,
  providersActivate: vi.fn(),
  providersBalance: vi.fn(),
  providersCcSwitchImport: vi.fn(),
  providersCcSwitchScan: vi.fn(),
  providersListModels: vi.fn(),
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
  activeSource: "official",
  activeProviderId: null,
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
