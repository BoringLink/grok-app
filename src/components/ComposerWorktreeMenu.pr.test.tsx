/**
 * @vitest-environment jsdom
 *
 * Branch-chip PR section: the compact one-row-per-PR list, the per-row watch
 * control, the "no PR" state and the portal/material contract (dialogs.md:
 * never a transparent or clipped menu). Drives the shipped component through a
 * real click.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/test/jsdomStubs";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerWorktreeMenu } from "@/components/ComposerWorktreeMenu";
import { composerPrSection } from "@/components/ComposerBranchPrSection";
import { FLOATING_MENU_Z_INDEX } from "@/lib/floatingMenu";
import { parseWorktreePorcelain } from "@/lib/gitWorktree";

afterEach(cleanup);

const OTHER = [
  {
    projectPath: "/Users/me/typebooks",
    branch: "feat/other",
    number: 77,
    title: "Fix CI on the other branch",
    state: "OPEN",
    checksLine: "3 pass",
  },
];

const PORCELAIN = `worktree /Users/me/typebooks
HEAD abcdef0123456789
branch refs/heads/feat/pr-monitor-wake
`;

const LABELS = {
  worktrees: "Git worktrees",
  worktreesEmpty: "No linked worktrees",
  worktreesUnavailable: "Worktrees unavailable",
  worktreeCurrent: "current",
  worktreeMain: "main",
  worktreeDetached: "detached",
  worktreeTip: "Switch git worktree / branch",
  worktreeNew: "New worktree",
  worktreeNewChat: "New worktree & chat",
  worktreeGc: "Clean stale worktrees",
  pr: "Pull request",
  prEmpty: "No pull request for this branch",
  prWatch: "Watch this PR",
  prUnwatch: "Stop watching",
  prWatchTip: "Follow this PR in this chat",
  prUnwatchTip: "Stop following this PR",
  prOpenHub: "Open in PR hub",
  prChipTip: "Watching PR #{number}: {title}",
  prPendingWakes: "{count} follow-up(s) waiting",
  prWatchingLabel: "Watching",
  prLastUpdate: "Last update: {summary}",
  prUnavailable: "Pull requests unavailable (gh not ready)",
};

const LONG_TITLE =
  "feat(tasks): follow live subagent runs in the Tasks panel with a long tail";

function renderMenu(
  extra: Partial<Parameters<typeof ComposerWorktreeMenu>[0]> = {},
) {
  const onTogglePrWatch = vi.fn();
  const onOpenPrHub = vi.fn();
  const onUnwatchPr = vi.fn();
  render(
    <ComposerWorktreeMenu
      variant="context"
      activePath="/Users/me/typebooks"
      worktrees={parseWorktreePorcelain(PORCELAIN)}
      worktreesAvailable
      labels={LABELS}
      onSwitch={vi.fn()}
      onCreate={vi.fn()}
      onCreateAndChat={vi.fn()}
      onGc={vi.fn()}
      onTogglePrWatch={onTogglePrWatch}
      onOpenPrHub={onOpenPrHub}
      onUnwatchPr={onUnwatchPr}
      {...extra}
    />,
  );
  return { onTogglePrWatch, onOpenPrHub, onUnwatchPr };
}

async function open() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: /Switch git worktree/ }),
  );
  return user;
}

/** Body-level pop (the menu is portaled, never nested in the chip). */
function pop(): HTMLElement {
  return document.body.querySelector<HTMLElement>(":scope > .cwm__pop")!;
}

/** PR rows in the section, in render order. */
function prRows(): HTMLElement[] {
  return Array.from(
    pop().querySelectorAll<HTMLElement>(".cwm__list--pr > .cwm__row"),
  );
}

describe("ComposerWorktreeMenu PR section", () => {
  it("reserves one row per PR and hides the section when there is nothing", () => {
    const bound = { number: 42, title: "Fix CI" };
    // No PR anywhere → no section, so the menu does not reserve empty height.
    expect(
      composerPrSection({ pr: null, prWatching: false, prOtherWatches: OTHER }),
    ).toEqual({ visible: false, rows: 0 });
    expect(
      composerPrSection({
        pr: null,
        prWatching: false,
        prOtherWatches: OTHER,
        canStopOther: true,
      }),
    ).toEqual({ visible: true, rows: 1 });
    expect(
      composerPrSection({
        pr: bound,
        prWatching: true,
        prOtherWatches: OTHER,
        canStopOther: true,
      }),
    ).toEqual({ visible: true, rows: 2 });
    // A mounted watch with no PR row still shows (it has to be stoppable).
    expect(
      composerPrSection({ pr: null, prWatching: true }),
    ).toEqual({ visible: true, rows: 0 });
  });

  it("keeps the watch control inside the PR's own row", async () => {
    const { onTogglePrWatch } = renderMenu({
      pr: {
        number: 1316,
        title: LONG_TITLE,
        state: "OPEN",
        checksLine: "4 pass",
      },
      prWatching: true,
      prUpdates: ["New comment from RongleCat: Please rebase on main."],
      prPendingWakes: 2,
    });

    const user = await open();

    // Portal contract: material class on a body-level pop, never transparent.
    const el = pop();
    expect(el).not.toBeNull();
    expect(el.className).toContain("cmm__pop--portal");
    expect(el.className).toContain("cwm__pop");
    expect(el.style.position).toBe("fixed");
    expect(el.style.zIndex).toBe(String(FLOATING_MENU_Z_INDEX));

    const row = screen.getByRole("menuitem", { name: /#1316/ });
    expect(row.textContent).toContain("OPEN · 4 pass");
    // Menu rows are wider than the chip, so the long title is kept here.
    expect(row.textContent).toContain("feat(tasks): follow live subagent runs");

    // One row for one PR: no full-width toggle row under the PR.
    const section = el.querySelector<HTMLElement>(".cwm__pr")!;
    expect(section.querySelector(".cwm__action")).toBeNull();
    expect(prRows().length).toBe(1);

    const toggle = within(row.parentElement as HTMLElement).getByRole(
      "button",
      { name: "Stop watching" },
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    expect(screen.getByText("Watching")).toBeTruthy();
    expect(
      screen.getByText("Last update: New comment from RongleCat: Please rebase on main."),
    ).toBeTruthy();
    expect(screen.getByText("2 follow-up(s) waiting")).toBeTruthy();

    await user.click(toggle);
    expect(onTogglePrWatch).toHaveBeenCalledTimes(1);
    // The menu stays open so several mounts can be managed in one pass.
    expect(pop()).not.toBeNull();
  });

  it("offers to start watching and opens the PR hub", async () => {
    const { onTogglePrWatch, onOpenPrHub } = renderMenu({
      pr: { number: 42, title: "Fix CI", state: "OPEN", checksLine: "3 pass" },
      prWatching: false,
    });

    const user = await open();
    const toggle = screen.getByRole("button", { name: "Watch this PR" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // Not watching → no watching tag and no change line.
    expect(screen.queryByText("Watching")).toBeNull();

    await user.click(toggle);
    expect(onTogglePrWatch).toHaveBeenCalledTimes(1);

    // The PR row itself still opens the hub (and closes the menu).
    await user.click(screen.getByRole("menuitem", { name: /#42/ }));
    await waitFor(() => expect(onOpenPrHub).toHaveBeenCalledWith(42));
    expect(document.body.querySelector(":scope > .cwm__pop")).toBeNull();
  });

  it("lists this chat's other watches, each with its own control", async () => {
    const { onUnwatchPr } = renderMenu({
      pr: null,
      prWatching: false,
      prOtherWatches: [
        ...OTHER,
        {
          projectPath: "/Users/me/typebooks",
          branch: "wip/third",
          number: 78,
          title: "Third branch work",
          state: "OPEN",
          checksLine: "",
          busy: true,
        },
      ],
    });

    const user = await open();

    const rows = prRows();
    expect(rows.length).toBe(2);

    const first = within(rows[0]);
    const firstRow = first.getByRole("menuitem");
    expect(firstRow.textContent).toContain("#77");
    // The row names the branch it belongs to, so several mounts stay tellable apart.
    expect(firstRow.textContent).toContain("OPEN · 3 pass · feat/other");
    await user.click(first.getByRole("button", { name: "Stop watching" }));
    expect(onUnwatchPr).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feat/other", number: 77 }),
    );

    const second = within(rows[1]);
    expect(second.getByRole("menuitem").textContent).toContain("#78");
    // A stop call in flight disables that row only.
    expect(
      second.getByRole("button", { name: "Stop watching" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      first.getByRole("button", { name: "Stop watching" }).hasAttribute("disabled"),
    ).toBe(false);

    // Other mounts are watched, so the section says so and shows no "no PR" note.
    expect(screen.getByText("Watching")).toBeTruthy();
    expect(screen.queryByText("No pull request for this branch")).toBeNull();
  });

  it("renders no PR section at all when the branch has no PR and nothing is watched", async () => {
    renderMenu({ pr: null, prWatching: false });
    await open();

    expect(screen.queryByText("Pull request")).toBeNull();
    expect(screen.queryByText("No pull request for this branch")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /#/ })).toBeNull();
    // The branch menu itself still works.
    expect(screen.getByText("Git worktrees")).toBeTruthy();
  });

  it("surfaces a poll failure instead of looking healthy", async () => {
    renderMenu({
      pr: { number: 1316, title: "Fix CI", state: "OPEN" },
      prWatching: true,
      prWatchError: "gh: authentication failed",
    });
    await open();
    expect(
      screen.getByText("Pull requests unavailable (gh not ready)"),
    ).toBeTruthy();
  });
});
