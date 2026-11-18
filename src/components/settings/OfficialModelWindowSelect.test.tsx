/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import "@/test/jsdomStubs";
import * as api from "@/lib/api";
import type { AvailableModelsResult } from "@/lib/api";
import type { ModelOption } from "@/lib/grokCatalog";
import { OfficialModelWindowSelect } from "./OfficialModelWindowSelect";

vi.mock("@/lib/api", () => ({
  isTauri: () => true,
  modelsSetOfficialContextWindow: vi.fn(),
}));

const t = (key: string) => key;

const model: ModelOption = {
  id: "grok-4.7",
  label: "Grok 4.7",
  contextWindow: 256000,
  contextWindows: [256000, 500000],
  contextWindowSource: "catalog",
};

const refreshed: AvailableModelsResult = {
  defaultModelId: "grok-4.7",
  models: [
    {
      id: "grok-4.7",
      label: "Grok 4.7",
      source: "official",
      contextWindow: 500000,
      contextWindows: [256000, 500000],
      contextWindowSource: "user",
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(overrides: Partial<ModelOption> = {}) {
  const onChanged = vi.fn();
  render(
    <OfficialModelWindowSelect
      model={{ ...model, ...overrides }}
      locale="en"
      t={t}
      onChanged={onChanged}
    />,
  );
  return { onChanged };
}

async function pick(user: ReturnType<typeof userEvent.setup>, index: number) {
  await user.click(
    screen.getByRole("button", { name: /Grok 4\.7 settings\.availableModelsWindow/ }),
  );
  const options = screen.getAllByRole("option");
  await user.click(options[index]!.querySelector("button")!);
}

describe("OfficialModelWindowSelect", () => {
  it("offers Default plus every advertised window in catalog order", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      screen.getByRole("button", {
        name: /Grok 4\.7 settings\.availableModelsWindow/,
      }),
    );

    const labels = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["settings.availableModelsWindowDefault", "256K", "500K"]);
    expect(screen.getByText("settings.availableModelsWindowCatalog")).toBeInTheDocument();
  });

  it("saves a picked window and reports the refreshed catalog", async () => {
    const user = userEvent.setup();
    const { onChanged } = setup();
    vi.mocked(api.modelsSetOfficialContextWindow).mockResolvedValue(refreshed);

    await pick(user, 2);

    await waitFor(() =>
      expect(api.modelsSetOfficialContextWindow).toHaveBeenCalledWith(
        "grok-4.7",
        500000,
      ),
    );
    expect(onChanged).toHaveBeenCalledWith(refreshed);
  });

  it("clears a user window back to the catalog default", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <OfficialModelWindowSelect
        model={{ ...model, contextWindow: 500000, contextWindowSource: "user" }}
        locale="en"
        t={t}
        onChanged={onChanged}
      />,
    );
    vi.mocked(api.modelsSetOfficialContextWindow).mockResolvedValue({
      defaultModelId: "grok-4.7",
      models: [{ ...refreshed.models[0]!, contextWindow: 256000, contextWindowSource: "catalog" }],
    });

    expect(screen.getByText("settings.availableModelsWindowUser")).toBeInTheDocument();
    await pick(user, 0);

    await waitFor(() =>
      expect(api.modelsSetOfficialContextWindow).toHaveBeenCalledWith(
        "grok-4.7",
        null,
      ),
    );
  });

  it("shows the failure message and keeps the current value", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <OfficialModelWindowSelect
        model={model}
        locale="en"
        t={t}
        onChanged={onChanged}
      />,
    );
    vi.mocked(api.modelsSetOfficialContextWindow).mockRejectedValue(
      new Error("host refused"),
    );

    await pick(user, 2);

    expect(
      await screen.findByText("settings.availableModelsWindowFailed"),
    ).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
