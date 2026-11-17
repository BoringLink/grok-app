/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/test/jsdomStubs";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerModelMenu } from "@/components/ComposerModelMenu";

afterEach(cleanup);

/** 断言 Composer 菜单直接 portal 到 document.body。 */
function bodyPop(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(":scope > .cmm__pop");
}

const baseLabels = {
  model: "Model",
  effort: "Effort",
  effortHigh: "High",
  effortMedium: "Medium",
  effortLow: "Low",
  effortFaster: "Faster",
  effortSmarter: "Smarter",
  modelSearchPlaceholder: "Search models",
  modelSearchEmpty: "No models",
  modelGroupOfficial: "Official",
};

describe("composer model effort menu", () => {
  it("keeps the stop slider while selecting raw model reasoning ids", async () => {
    const user = userEvent.setup();
    const onEffort = vi.fn();
    render(
      <ComposerModelMenu
        modelId="m-raw"
        effort="balanced"
        efforts={[
          { id: "minimal", label: "Minimal" },
          { id: "balanced", label: "Balanced" },
          { id: "ultra", label: "Ultra" },
        ]}
        labels={baseLabels}
        onEffort={onEffort}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    const pop = bodyPop();
    expect(pop).not.toBeNull();
    const slider = screen.getByRole("slider", { name: "Effort" });
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("Balanced");
    expect(pop!.querySelector(".cmm__stops-axis")?.textContent).toBe(
      "FasterSmarter",
    );

    await user.click(screen.getByRole("button", { name: "Ultra" }));
    expect(onEffort).toHaveBeenCalledWith("ultra");
  });

  it("keeps the saved stop when saving a change fails", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelMenu
        modelId="m-raw"
        effort="minimal"
        efforts={[{ id: "minimal" }, { id: "ultra" }]}
        labels={baseLabels}
        onEffort={vi.fn().mockResolvedValue(false)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    const slider = screen.getByRole("slider", { name: "Effort" });
    await user.click(screen.getByRole("button", { name: "ultra" }));
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    expect(slider.getAttribute("aria-valuetext")).toBe("minimal");
  });

  it("shows an Off slider stop only when the model advertises none", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelMenu
        modelId="m-off"
        effort="low"
        efforts={[
          { id: "low", label: "Low" },
          { id: "none", label: "none" },
        ]}
        labels={{ ...baseLabels, effortNone: "Off" }}
        onEffort={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("slider", { name: "Effort" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Off" })).toBeTruthy();
  });

  it("does not mark Off as the strongest reasoning stop", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelMenu
        modelId="m-off"
        effort="none"
        efforts={[
          { id: "low", label: "Low" },
          { id: "none", label: "none" },
        ]}
        labels={{ ...baseLabels, effortNone: "Off" }}
        onEffort={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen.getByRole("slider", { name: "Effort" }).getAttribute(
        "aria-valuetext",
      ),
    ).toBe("Off");
    expect(bodyPop()!.querySelector(".cmm__simple-title.is-ultra")).toBeNull();
    expect(
      document.querySelector(".cmm--model")?.classList.contains("cmm--extra"),
    ).toBe(false);
  });

  it("does not accent a custom trailing tier such as Instant", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelMenu
        modelId="m-instant"
        effort="instant"
        efforts={[
          { id: "low", label: "Low" },
          { id: "instant", label: "Instant" },
        ]}
        labels={baseLabels}
        onEffort={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen.getByRole("slider", { name: "Effort" }).getAttribute(
        "aria-valuetext",
      ),
    ).toBe("Instant");
    expect(bodyPop()!.querySelector(".cmm__stops-rail.is-ultra")).toBeNull();
    expect(bodyPop()!.querySelector(".cmm__simple-title.is-ultra")).toBeNull();
    expect(
      document.querySelector(".cmm--model")?.classList.contains("cmm--extra"),
    ).toBe(false);
  });

  it("does not render stale Off when the model does not advertise it", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelMenu
        modelId="m-plain"
        effort="none"
        efforts={[
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ]}
        labels={{
          ...baseLabels,
          effortNone: "Off",
          effortUnavailable: "No reasoning options",
        }}
        onEffort={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger.textContent).toContain("Effort");
    expect(trigger.textContent).not.toContain("Off");
    await user.click(trigger);
    expect(screen.queryByRole("button", { name: "Off" })).toBeNull();
    expect(
      screen.getByRole("slider", { name: "Effort" }).getAttribute(
        "aria-valuetext",
      ),
    ).toBe("Low");
  });

  it("shows the localized unavailable note when a model has no effort options", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelMenu
        modelId="m-nothink"
        effort="high"
        efforts={[]}
        labels={{
          ...baseLabels,
          effortUnavailable: "No reasoning options",
        }}
        onEffort={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger.textContent).toContain("No reasoning options");
    expect(trigger.textContent).not.toContain("High");

    await user.click(trigger);
    expect(bodyPop()!.textContent ?? "").toContain("No reasoning options");
    expect(screen.queryByRole("slider", { name: "Effort" })).toBeNull();
  });
});
