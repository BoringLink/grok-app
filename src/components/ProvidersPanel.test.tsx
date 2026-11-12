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
  providersUpsert: vi.fn(),
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
});
