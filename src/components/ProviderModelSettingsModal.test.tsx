/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import "@/test/jsdomStubs";
import {
  ProviderModelSettingsModal,
  type ProviderModelSettingsValue,
} from "./ProviderModelSettingsModal";
import { asFormModel } from "@/lib/providerForm";

const baseModel = asFormModel({ id: "m1", name: "M1" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(
  overrides: Partial<Parameters<typeof ProviderModelSettingsModal>[0]> = {},
) {
  const onSave = vi.fn<(next: ProviderModelSettingsValue) => void>();
  const onClose = vi.fn();
  const view = render(
    <ProviderModelSettingsModal
      open
      locale="en"
      model={baseModel}
      onClose={onClose}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { ...view, onSave, onClose };
}

describe("ProviderModelSettingsModal", () => {
  it("shows context, Off support and effort levels without image/video caps", () => {
    renderModal();

    expect(screen.getByLabelText("Context window")).toHaveValue("1000000");
    expect(
      screen.getByRole("checkbox", { name: "Allow Off in Composer" }),
    ).not.toBeChecked();
    expect(screen.getAllByLabelText("Effort id")).toHaveLength(5);
    expect(screen.queryByText("Input modalities")).toBeNull();
    expect(screen.queryByText("Images")).toBeNull();
    expect(screen.queryByText("Video")).toBeNull();
  });

  it("prechecks Off when the model catalog already advertises none", () => {
    const model = asFormModel({
      id: "m1",
      name: "M1",
      efforts: [
        { id: "low", name: "Low" },
        { id: "none", name: "Off" },
      ],
      effortsSource: "remote",
    });
    renderModal({ model });

    expect(
      screen.getByRole("checkbox", { name: "Allow Off in Composer" }),
    ).toBeChecked();
  });

  it("does not save when a non-empty context window is not a positive integer", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    const input = screen.getByLabelText("Context window");
    await user.clear(input);
    await user.type(input, "12.5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      screen.getByText(
        "Enter a positive whole number of tokens, or leave empty to use the API value or the 1M default.",
      ),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves edited context, original effort ids and Off support as user values", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    const input = screen.getByLabelText("Context window");
    await user.clear(input);
    await user.type(input, "128000");
    const ids = screen.getAllByLabelText("Effort id");
    const first = ids[0]!;
    await user.clear(first);
    await user.type(first, "minimum");
    await user.click(
      screen.getByRole("checkbox", { name: "Allow Off in Composer" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0];
    expect(saved.contextWindow).toBe(128000);
    expect(saved.contextWindowSource).toBe("user");
    expect(saved.supportsReasoningEffort).toBe(true);
    expect(saved.supportsReasoningEffortSource).toBe("user");
    expect(saved.supportsReasoningOff).toBe(true);
    expect(saved.efforts.map((effort) => effort.id)).toEqual([
      "minimum",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(saved.effortsSource).toBe("user");
    expect(saved.efforts.find((effort) => effort.isDefault)?.id).toBe(
      "medium",
    );
  });

  it("persists an explicit Off disable without removing advertised effort ids", async () => {
    const user = userEvent.setup();
    const model = asFormModel({
      id: "m1",
      name: "M1",
      efforts: [
        { id: "high", name: "High", isDefault: true },
        { id: "none", name: "Off" },
      ],
      effortsSource: "remote",
    });
    const { onSave } = renderModal({ model });

    const toggle = screen.getByRole("checkbox", {
      name: "Allow Off in Composer",
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = onSave.mock.calls[0]![0];
    expect(saved.supportsReasoningOff).toBe(false);
    expect(saved.efforts.map((effort) => effort.id)).toEqual(["high", "none"]);
  });

  it("treats a configured effort ladder as reasoning support", async () => {
    const user = userEvent.setup();
    const model = asFormModel({
      id: "m1",
      name: "M1",
      supportsReasoningEffort: false,
      supportsReasoningEffortSource: "remote",
    });
    const { onSave } = renderModal({ model });

    await user.clear(screen.getAllByLabelText("Effort id")[0]!);
    await user.type(screen.getAllByLabelText("Effort id")[0]!, "minimum");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = onSave.mock.calls[0]![0];
    expect(saved.supportsReasoningEffort).toBe(true);
    expect(saved.supportsReasoningOff).toBeUndefined();
  });

  it("resets an empty context window to the latest API value", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal({
      remote: { id: "m1", contextWindow: 64000 },
    });

    await user.clear(screen.getByLabelText("Context window"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = onSave.mock.calls[0]![0];
    expect(saved.contextWindow).toBe(64000);
    expect(saved.contextWindowSource).toBe("remote");
  });

  it("resets an empty context window to the 1M fallback without API metadata", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.clear(screen.getByLabelText("Context window"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = onSave.mock.calls[0]![0];
    expect(saved.contextWindow).toBe(1_000_000);
    expect(saved.contextWindowSource).toBe("fallback");
  });

  it("resets the reasoning ladder to API metadata or the approved default", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal({
      remote: {
        id: "m1",
        reasoningEfforts: [
          { id: "minimum", name: "Minimum" },
          { id: "maximum", name: "Maximum", isDefault: true },
        ],
      },
    });

    await user.click(screen.getByRole("button", { name: "Use API / default" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = onSave.mock.calls[0]![0];
    expect(saved.efforts.map((effort) => effort.id)).toEqual([
      "minimum",
      "maximum",
    ]);
    expect(saved.effortsSource).toBe("remote");
    expect(saved.efforts.find((effort) => effort.isDefault)?.id).toBe("maximum");

    cleanup();
    const fallback = renderModal();
    await user.click(
      screen.getByRole("button", { name: "Use API / default" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    const fallbackSaved = fallback.onSave.mock.calls[0]![0];
    expect(fallbackSaved.efforts.map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(fallbackSaved.effortsSource).toBe("fallback");
    expect(
      fallbackSaved.efforts.find((effort) => effort.isDefault)?.id,
    ).toBe("medium");
  });

  it("reopens with the values it saved", async () => {
    const user = userEvent.setup();
    const { onSave, rerender } = renderModal();

    const input = screen.getByLabelText("Context window");
    await user.clear(input);
    await user.type(input, "256000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const saved = onSave.mock.calls[0]![0];

    rerender(
      <ProviderModelSettingsModal
        open
        locale="en"
        model={{
          ...baseModel,
          contextWindow: saved.contextWindow,
          contextWindowSource: saved.contextWindowSource,
          efforts: saved.efforts.map((effort) => ({
            id: effort.id,
            name: effort.name ?? effort.id,
            isDefault: !!effort.isDefault,
          })),
          effortsSource: saved.effortsSource,
          supportsReasoningEffort: saved.supportsReasoningEffort,
          supportsReasoningEffortSource: saved.supportsReasoningEffortSource,
          supportsReasoningOff: saved.supportsReasoningOff,
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Context window")).toHaveValue("256000");
    expect(screen.getAllByLabelText("Effort id")[0]).toHaveValue("low");
  });
});
