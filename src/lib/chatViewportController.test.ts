import { describe, expect, it } from "vitest";
import { createLayoutLedger } from "@/lib/chatViewportLedger";
import {
  anchorAtViewportTop,
  applyIntent,
  applyScrollSample,
  contentEndScrollTop,
  createViewportState,
  intentEffect,
  planRestore,
  scrollTopForAnchor,
  type ViewportGeometry,
  type ViewportState,
} from "@/lib/chatViewportController";

const STREAK_WINDOW_MS = 400;

const rowsOf = (count = 10, height = 100) =>
  createLayoutLedger({ count, estimateHeight: height });

const geometry = (over: Partial<ViewportGeometry> = {}): ViewportGeometry => ({
  scrollTop: 250,
  scrollHeight: 1000,
  clientHeight: 400,
  ...over,
});

describe("chatViewportController geometry", () => {
  it("parks the viewport on the content end", () => {
    const g = geometry({ scrollHeight: 1000, clientHeight: 400 });

    const top = contentEndScrollTop(g);

    expect(top).toBe(600);
  });

  it("resolves the row at the viewport top and its offset through the ledger", () => {
    const rows = rowsOf();

    const anchor = anchorAtViewportTop(geometry({ scrollTop: 250 }), rows);

    // Row 2 spans [200, 300); the viewport top sits 50px into it.
    expect(anchor).toEqual({ rowIndex: 2, offsetIntoViewport: -50 });
  });

  it("round-trips an anchor back to its scrollTop", () => {
    const rows = rowsOf();
    const anchor = anchorAtViewportTop(geometry({ scrollTop: 250 }), rows);

    const top = scrollTopForAnchor(anchor, rows, geometry());

    expect(top).toBe(250);
  });

  it("clamps the anchor target to the scrollable range", () => {
    const rows = rowsOf();

    const top = scrollTopForAnchor(
      { rowIndex: 9, offsetIntoViewport: -500 },
      rows,
      geometry({ scrollHeight: 1000, clientHeight: 400 }),
    );

    expect(top).toBe(600);
  });
});

describe("chatViewportController intents", () => {
  it("classifies reading-history gestures as escape", () => {
    expect(intentEffect({ kind: "wheel", deltaY: -12 })).toBe("escape");
    expect(intentEffect({ kind: "touch", deltaY: 14 })).toBe("escape");
    expect(intentEffect({ kind: "keyboard", key: "PageUp" })).toBe("escape");
    expect(intentEffect({ kind: "keyboard", key: "Home" })).toBe("escape");
    expect(intentEffect({ kind: "scrollbar", deltaY: -1 })).toBe("escape");
  });

  it("classifies moves toward the tail", () => {
    expect(intentEffect({ kind: "wheel", deltaY: 20 })).toBe("towardEnd");
    expect(intentEffect({ kind: "touch", deltaY: -14 })).toBe("towardEnd");
    expect(intentEffect({ kind: "keyboard", key: "End" })).toBe("towardEnd");
    expect(intentEffect({ kind: "scrollbar", deltaY: 1 })).toBe("towardEnd");
  });

  it("ignores sub-threshold and unrelated gestures", () => {
    expect(intentEffect({ kind: "wheel", deltaY: -3 })).toBe("none");
    expect(intentEffect({ kind: "touch", deltaY: 4 })).toBe("none");
    expect(intentEffect({ kind: "keyboard", key: "a" })).toBe("none");
  });

  it("escapes on a reading-history intent without moving the viewport", () => {
    const rows = rowsOf();

    const { state, directive } = applyIntent({
      state: createViewportState(),
      intent: { kind: "keyboard", key: "PageUp" },
      geometry: geometry({ scrollTop: 250 }),
      rows,
      now: 0,
    });

    expect(state.phase).toBe("escaped");
    expect(state.anchor).toEqual({ rowIndex: 2, offsetIntoViewport: -50 });
    expect(directive).toEqual({ kind: "none" });
  });

  it("re-pins only when a toward-tail intent lands on the hard bottom", () => {
    const rows = rowsOf();
    const escaped: ViewportState = {
      phase: "escaped",
      anchor: { rowIndex: 2, offsetIntoViewport: -50 },
      upStreak: 0,
      upStreakAt: 0,
    };

    const nearBottom = applyIntent({
      state: escaped,
      intent: { kind: "wheel", deltaY: 20 },
      geometry: geometry({ scrollTop: 500 }),
      rows,
      now: 0,
    });
    const hardBottom = applyIntent({
      state: escaped,
      intent: { kind: "wheel", deltaY: 20 },
      geometry: geometry({ scrollTop: 600 }),
      rows,
      now: 0,
    });

    expect(nearBottom.state.phase).toBe("escaped");
    expect(nearBottom.directive).toEqual({ kind: "none" });
    expect(hardBottom.state.phase).toBe("pinned");
    expect(hardBottom.directive).toEqual({ kind: "end" });
  });
});

describe("chatViewportController scroll samples", () => {
  const pinned = (): ViewportState => createViewportState();
  const base = {
    scrollTop: 590,
    previousScrollTop: 600,
    scrollHeight: 1000,
    previousScrollHeight: 1000,
    clientHeight: 400,
    gestureRecent: false,
  };

  it("treats a single gesture-free upward move as a clamp and re-asserts the end", () => {
    const { state, directive } = applyScrollSample({
      state: pinned(),
      sample: base,
      rows: rowsOf(),
      now: 0,
      streakWindowMs: STREAK_WINDOW_MS,
    });

    expect(state.phase).toBe("pinned");
    expect(directive).toEqual({ kind: "end" });
  });

  it("escapes after two consecutive gesture-free upward moves at a stable height", () => {
    const first = applyScrollSample({
      state: pinned(),
      sample: base,
      rows: rowsOf(),
      now: 0,
      streakWindowMs: STREAK_WINDOW_MS,
    });
    const second = applyScrollSample({
      state: first.state,
      sample: { ...base, scrollTop: 580, previousScrollTop: 590 },
      rows: rowsOf(),
      now: 16,
      streakWindowMs: STREAK_WINDOW_MS,
    });

    expect(second.state.phase).toBe("escaped");
    expect(second.state.anchor).toEqual({ rowIndex: 5, offsetIntoViewport: -80 });
    expect(second.directive).toEqual({ kind: "none" });
  });

  it("does not accumulate a streak when the height moved", () => {
    const first = applyScrollSample({
      state: pinned(),
      sample: { ...base, previousScrollHeight: 960 },
      rows: rowsOf(),
      now: 0,
      streakWindowMs: STREAK_WINDOW_MS,
    });
    const second = applyScrollSample({
      state: first.state,
      sample: { ...base, scrollTop: 580, previousScrollTop: 590 },
      rows: rowsOf(),
      now: 16,
      streakWindowMs: STREAK_WINDOW_MS,
    });

    expect(first.state.phase).toBe("pinned");
    expect(second.state.phase).toBe("pinned");
    expect(second.directive).toEqual({ kind: "end" });
  });

  it("escapes immediately on a real gesture", () => {
    const { state } = applyScrollSample({
      state: pinned(),
      sample: { ...base, gestureRecent: true },
      rows: rowsOf(),
      now: 0,
      streakWindowMs: STREAK_WINDOW_MS,
    });

    expect(state.phase).toBe("escaped");
  });

  it("holds the end while the height shrank", () => {
    const { state, directive } = applyScrollSample({
      state: pinned(),
      sample: { ...base, scrollHeight: 900, previousScrollHeight: 1000 },
      rows: rowsOf(),
      now: 0,
      streakWindowMs: STREAK_WINDOW_MS,
    });

    expect(state.phase).toBe("pinned");
    expect(directive).toEqual({ kind: "end" });
  });

  it("re-pins an escaped viewport that lands on the hard bottom with a gesture", () => {
    const escaped: ViewportState = {
      phase: "escaped",
      anchor: { rowIndex: 2, offsetIntoViewport: -50 },
      upStreak: 0,
      upStreakAt: 0,
    };

    const { state, directive } = applyScrollSample({
      state: escaped,
      sample: {
        ...base,
        scrollTop: 600,
        previousScrollTop: 580,
        gestureRecent: true,
      },
      rows: rowsOf(),
      now: 0,
      streakWindowMs: STREAK_WINDOW_MS,
    });

    expect(state.phase).toBe("pinned");
    expect(directive).toEqual({ kind: "end" });
  });

  it("never fights an escaped viewport reading history", () => {
    const escaped: ViewportState = {
      phase: "escaped",
      anchor: { rowIndex: 2, offsetIntoViewport: -50 },
      upStreak: 0,
      upStreakAt: 0,
    };

    const { state, directive } = applyScrollSample({
      state: escaped,
      sample: { ...base, scrollTop: 580, previousScrollTop: 590 },
      rows: rowsOf(),
      now: 0,
      streakWindowMs: STREAK_WINDOW_MS,
    });

    expect(state).toBe(escaped);
    expect(directive).toEqual({ kind: "none" });
  });
});

describe("chatViewportController restore", () => {
  it("restores the content end while pinned", () => {
    const directive = planRestore({
      state: createViewportState(),
      geometry: geometry({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 }),
      rows: rowsOf(),
    });

    expect(directive).toEqual({ kind: "end" });
  });

  it("holds the anchor's on-screen position when a row above it changes height", () => {
    const rows = rowsOf();
    const state: ViewportState = {
      phase: "escaped",
      anchor: anchorAtViewportTop(geometry({ scrollTop: 250 }), rows),
      upStreak: 0,
      upStreakAt: 0,
    };
    // A row above the anchor grows 100px: the anchor must move down with it.
    rows.setRowHeight(0, 200, "measured");

    const directive = planRestore({
      state,
      geometry: geometry({ scrollTop: 250 }),
      rows,
    });

    expect(directive).toEqual({ kind: "anchor", top: 350 });
  });
});
