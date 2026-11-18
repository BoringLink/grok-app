/**
 * @vitest-environment jsdom
 *
 * Phone composer must offer the same raw reasoning variants as desktop:
 * catalog order, exact ids, Off only when advertised, and a localized empty
 * note when the model rejects reasoning effort.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/test/jsdomStubs";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneComposerToolsSheet } from "@/components/PhoneComposerToolsSheet";
import type { ContextUsageDisplay } from "@/lib/contextUsage";

afterEach(cleanup);

const contextDisplay: ContextUsageDisplay = {
  tokens: null,
  source: "unknown",
  label: "—",
  lastCompact: null,
  breakdown: null,
  knownUsage: null,
  windowSize: null,
  percent: null,
  cacheHitRate: null,
  cachedReadTokens: null,
};

const labels = {
  title: "Tools",
  close: "Close",
  attach: "Attach",
  project: "Project",
  model: "Model",
  effort: "Effort",
  access: "Access",
  context: "Context",
  noProject: "No project",
  addProject: "Add project",
  mode: "Mode",
  permission: "Permission",
  modeAgent: "Agent",
  modePlan: "Plan",
  modeAsk: "Ask",
  modelGroupOfficial: "Official",
  policyAsk: "Ask",
  policyAcceptEdits: "Accept edits",
  policySession: "Allow for session",
  policyAuto: "Auto",
  policyDontAsk: "Don't ask",
  policyYolo: "Always approve",
  effortHigh: "High",
  effortMedium: "Medium",
  effortLow: "Low",
  effortNone: "Off",
  effortUnavailable: "No reasoning options",
  contextCurrent: "Current",
  contextUnknown: "Unknown",
  contextCompact: "Compact",
  sourceKnown: "Known",
  sourceEstimated: "Estimated",
  sourceUnknown: "Unknown",
  back: "Back",
};

function renderSheet(opts: {
  effort: string;
  efforts: Array<{ id: string; label?: string }>;
  effortOptionsPending?: boolean;
  onEffort?: (id: string) => void;
}) {
  render(
    <PhoneComposerToolsSheet
      open
      onClose={vi.fn()}
      labels={labels}
      activeProject={null}
      projects={[]}
      modelId="m-raw"
      effort={opts.effort}
      efforts={opts.efforts}
      effortOptionsPending={opts.effortOptionsPending}
      mode="agent"
      policy="ask"
      contextDisplay={contextDisplay}
      onAttach={vi.fn()}
      onSelectProject={vi.fn()}
      onAddProject={vi.fn()}
      onEffort={opts.onEffort ?? vi.fn()}
      onMode={vi.fn()}
      onPolicy={vi.fn()}
      onCompact={vi.fn()}
    />,
  );
}

async function openEffortPanel() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Model/ }));
  await user.click(screen.getByRole("button", { name: /^Effort/ }));
  return user;
}

describe("PhoneComposerToolsSheet reasoning options", () => {
  it("lists raw ids in catalog order and applies the exact id", async () => {
    const onEffort = vi.fn();
    renderSheet({
      effort: "balanced",
      efforts: [
        { id: "minimal", label: "Minimal" },
        { id: "balanced", label: "Balanced" },
        { id: "ultra", label: "Ultra" },
      ],
      onEffort,
    });

    const user = await openEffortPanel();
    const rowLabels = Array.from(
      document.querySelectorAll(".phone-sheet__row .phone-sheet__row-label"),
    ).map((el) => el.textContent?.trim());
    expect(rowLabels).toEqual(["Minimal", "Balanced", "Ultra"]);
    expect(
      screen
        .getByRole("button", { name: "Balanced" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Ultra" }));
    expect(onEffort).toHaveBeenCalledWith("ultra");
  });

  it("shows Off only when the model advertises none", async () => {
    renderSheet({
      effort: "low",
      efforts: [
        { id: "low", label: "Low" },
        { id: "none", label: "none" },
      ],
    });

    await openEffortPanel();
    expect(screen.getByRole("button", { name: "Off" })).toBeTruthy();
  });

  it("does not label a stale stored Off value as supported", async () => {
    renderSheet({
      effort: "none",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });

    const modelRow = screen.getByRole("button", { name: /^Model/ });
    expect(modelRow.textContent).toContain("Effort");
    expect(modelRow.textContent).not.toContain("Off");
    await openEffortPanel();
    expect(screen.queryByRole("button", { name: "Off" })).toBeNull();
  });

  it("shows the unavailable note for a model without reasoning options", async () => {
    renderSheet({ effort: "high", efforts: [] });

    const modelRow = screen.getByRole("button", { name: /^Model/ });
    expect(modelRow.textContent).toContain("No reasoning options");
    expect(modelRow.textContent).not.toContain("High");
    await openEffortPanel();
    expect(screen.getByRole("status").textContent).toContain(
      "No reasoning options",
    );
  });

  it("does not label a loading model catalog as unavailable", async () => {
    renderSheet({ effort: "high", efforts: [], effortOptionsPending: true });

    const modelRow = screen.getByRole("button", { name: /^Model/ });
    expect(modelRow.textContent).toContain("Effort");
    expect(modelRow.textContent).not.toContain("No reasoning options");
    await openEffortPanel();
    expect(screen.getByRole("status").textContent).toBe("Effort");
  });
});
