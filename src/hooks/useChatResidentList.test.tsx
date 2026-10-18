/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { createLayoutLedger } from "@/lib/chatViewportLedger";
import type { ChatViewportControllerHandle } from "@/hooks/useChatViewportController";
import type { RowActivityFoldSnapshot } from "@/hooks/chatResidentListShared";
import { useChatResidentList } from "./useChatResidentList";

afterEach(cleanup);

/** Controller stub backed by a real ledger; only the list's calls matter here. */
function makeController() {
  let ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
  const restoreLayout = vi.fn();
  const positionListeners = new Set<() => void>();
  const controller = {
    ledger: () => ledger,
    reportRowHeight(index: number, height: number, generation?: number) {
      if (index >= ledger.rowCount()) ledger.setCount(index + 1);
      ledger.setRowHeight(index, height, "measured", generation);
    },
    reestimateRow(
      index: number,
      height: number,
      isRich: (index: number) => boolean,
    ) {
      if (isRich(index)) return;
      ledger.reestimateRow(index, height);
    },
    resetLedger() {
      ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
    },
    restoreLayout,
    subscribePosition(listener: () => void) {
      positionListeners.add(listener);
      return () => positionListeners.delete(listener);
    },
    assign: vi.fn(),
    escape: vi.fn(),
    pinToEnd: vi.fn(),
  } as unknown as ChatViewportControllerHandle;
  const notifyPosition = () => {
    for (const listener of positionListeners) listener();
  };
  return { controller, restoreLayout, notifyPosition, ledger: () => ledger };
}

/**
 * Model fold source for the tests: each `set` bumps a per-row input identity so
 * the list sees the fold inputs changed, exactly as a new message object does.
 */
function makeFoldSource() {
  const rows = new Map<
    number,
    { hasActivity: boolean; expanded: boolean; inputs: [number] }
  >();
  return {
    set(
      index: number,
      fold: { hasActivity: boolean; expanded: boolean },
    ): void {
      const prev = rows.get(index);
      rows.set(index, { ...fold, inputs: [(prev?.inputs[0] ?? 0) + 1] });
    },
    get(index: number): RowActivityFoldSnapshot | null {
      const row = rows.get(index);
      if (!row) return null;
      return {
        hasActivity: row.hasActivity,
        expanded: row.expanded,
        inputs: row.inputs,
      };
    },
  };
}

function makeViewport(scrollTop: number, clientHeight: number) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    value: scrollTop,
    writable: true,
    configurable: true,
  });
  document.body.appendChild(el);
  return el;
}

describe("useChatResidentList", () => {
  it("keeps every row resident and bands the viewport", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller, ledger } = makeController();
    const isPinnedRef = { current: false };
    const viewportRef = { current: viewport };

    // Act
    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 200,
        getEstimateHeight: () => 100,
        viewportRef,
        isPinnedRef,
        controller,
      }),
    );

    // Assert: all rows resident, shell heights seeded from the estimate.
    expect(result.current.rowCount).toBe(200);
    expect(ledger().rowCount()).toBe(200);
    expect(result.current.rowHeight(50)).toBe(100);
    expect(result.current.bandStore.isRich(0)).toBe(true);
    expect(result.current.bandStore.isRich(199)).toBe(false);
  });

  it("lands the band on the tail when the conversation opens pinned", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller } = makeController();
    const isPinnedRef = { current: true };

    // Act
    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 200,
        getEstimateHeight: () => 100,
        viewportRef: { current: viewport },
        isPinnedRef,
        controller,
      }),
    );

    // Assert: a stale scrollTop 0 still bands the end of the conversation.
    expect(result.current.bandStore.isRich(199)).toBe(true);
    expect(result.current.bandStore.isRich(0)).toBe(false);
  });

  it("reports a measured height to the controller and restores the invariant", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller, restoreLayout, ledger } = makeController();
    const isPinnedRef = { current: false };

    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 50,
        getEstimateHeight: () => 100,
        viewportRef: { current: viewport },
        isPinnedRef,
        controller,
      }),
    );

    // Act: a rich row measures to a real height.
    const row = document.createElement("div");
    row.getBoundingClientRect = () => ({ height: 250 }) as DOMRect;
    act(() => {
      result.current.measureRef(5)(row);
    });

    // Assert
    expect(ledger().heightOf(5)).toBe(250);
    expect(ledger().sourceOf(5)).toBe("measured");
    expect(restoreLayout).toHaveBeenCalled();
  });

  it("never leaves a row that intersects the viewport outside the band", () => {
    // Arrange: mid-list, follow released.
    const rowHeight = 100;
    const scrollTop = 3000;
    const clientHeight = 600;
    const viewport = makeViewport(scrollTop, clientHeight);
    const { controller } = makeController();
    const isPinnedRef = { current: false };

    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 200,
        getEstimateHeight: () => rowHeight,
        viewportRef: { current: viewport },
        isPinnedRef,
        controller,
      }),
    );

    // Act / Assert: every row crossing [scrollTop, scrollTop + clientHeight) is
    // real content — a shell there is exactly the forbidden visible placeholder.
    const firstCrossing = Math.floor(scrollTop / rowHeight);
    const lastCrossing = Math.ceil((scrollTop + clientHeight) / rowHeight);
    const crossingRows = Array.from(
      { length: lastCrossing - firstCrossing },
      (_, n) => firstCrossing + n,
    );
    expect(crossingRows.every((i) => result.current.bandStore.isRich(i))).toBe(
      true,
    );
  });

  it("re-bands synchronously on a programmatic jump, before any frame", () => {
    // Arrange: 100px rows, a 600px viewport held at the top.
    const viewport = makeViewport(0, 600);
    const { controller, notifyPosition } = makeController();
    const isPinnedRef = { current: false };

    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 200,
        getEstimateHeight: () => 100,
        viewportRef: { current: viewport },
        isPinnedRef,
        controller,
      }),
    );
    expect(result.current.bandStore.isRich(80)).toBe(false);

    // Act: a programmatic jump (find / Home / rail) writes the position and the
    // controller notifies; no rAF runs.
    viewport.scrollTop = 8000;
    act(() => notifyPosition());

    // Assert: rows now crossing [8000, 8600) are real content immediately.
    expect(result.current.bandStore.isRich(80)).toBe(true);
    expect(result.current.bandStore.isRich(0)).toBe(false);
  });

  it("keeps every row crossing the viewport real through a far jump and a shell fold", () => {
    // Arrange: 100px rows, a 600px viewport, follow released, row 150 tracked.
    const viewport = makeViewport(0, 600);
    const { controller, ledger, notifyPosition } = makeController();
    const isPinnedRef = { current: false };
    const folds = makeFoldSource();
    folds.set(150, { hasActivity: true, expanded: true });

    const { result, rerender } = renderHook(
      ({ rev }) =>
        useChatResidentList({
          itemCount: 300,
          getEstimateHeight: () => 100,
          viewportRef: { current: viewport },
          isPinnedRef,
          controller,
          getActivityFold: folds.get,
          activityRevision: rev,
        }),
      { initialProps: { rev: 1 } },
    );

    // Row 150 was measured expanded while it was rich (500px, not the estimate).
    const row = document.createElement("div");
    row.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    act(() => result.current.measureRef(150)(row));
    expect(ledger().heightOf(150)).toBe(500);

    const crossingRows = (scrollTop: number, clientHeight: number): number[] => {
      const first = ledger().indexAtOffset(scrollTop);
      const last = ledger().indexAtOffset(scrollTop + clientHeight);
      return Array.from({ length: last - first + 1 }, (_, n) => first + n);
    };
    const allRich = (rows: readonly number[]): boolean =>
      rows.every((i) => result.current.bandStore.isRich(i));

    // Act 1: a far jump lands near the tail; the write path re-bands first.
    viewport.scrollTop = 20_000;
    act(() => notifyPosition());

    // Assert 1: a shell was not painted inside the band by the jump.
    expect(allRich(crossingRows(20_000, 600))).toBe(true);

    // Act 2: the tracked shell folds while it is far above the viewport.
    act(() => folds.set(150, { hasActivity: true, expanded: false }));
    act(() => rerender({ rev: 2 }));

    // Assert 2: the fold re-seeded the shell and left the band real.
    expect(ledger().heightOf(150)).toBe(100);
    expect(allRich(crossingRows(20_000, 600))).toBe(true);
  });

  it("tracks a collapse and a re-growth in the shell height and the total", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller, ledger } = makeController();
    const isPinnedRef = { current: false };

    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 20,
        getEstimateHeight: () => 100,
        viewportRef: { current: viewport },
        isPinnedRef,
        controller,
      }),
    );
    const baseTotal = ledger().totalHeight();
    expect(baseTotal).toBe(2000);

    const row = document.createElement("div");
    let height = 400;
    row.getBoundingClientRect = () => ({ height }) as DOMRect;

    // Act / Assert: measure, collapse, re-grow — the total (and the scrollbar
    // drawn from the shell heights) follows exactly for a measured row.
    act(() => result.current.measureRef(3)(row));
    expect(result.current.rowHeight(3)).toBe(400);
    expect(ledger().totalHeight()).toBe(baseTotal + 300);

    height = 60;
    act(() => result.current.measureRef(3)(row));
    expect(result.current.rowHeight(3)).toBe(60);
    expect(ledger().totalHeight()).toBe(baseTotal - 40);

    height = 400;
    act(() => result.current.measureRef(3)(row));
    expect(result.current.rowHeight(3)).toBe(400);
    expect(ledger().totalHeight()).toBe(baseTotal + 300);
  });

  it("re-seeds a shell's height from the estimate when its activity folds", () => {
    // Arrange: a long list held at the top; row 50 is far outside the band.
    const viewport = makeViewport(0, 400);
    const { controller, ledger } = makeController();
    const isPinnedRef = { current: false };
    const folds = makeFoldSource();
    folds.set(50, { hasActivity: true, expanded: true });
    const { result, rerender } = renderHook(
      ({ rev }) =>
        useChatResidentList({
          itemCount: 100,
          getEstimateHeight: () => 100,
          viewportRef: { current: viewport },
          isPinnedRef,
          controller,
          getActivityFold: folds.get,
          activityRevision: rev,
        }),
      { initialProps: { rev: 1 } },
    );
    // Row 50 was measured at its expanded height while it was in the band.
    const row = document.createElement("div");
    row.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    act(() => result.current.measureRef(50)(row));
    expect(ledger().heightOf(50)).toBe(500);
    expect(ledger().sourceOf(50)).toBe("measured");
    const expandedTotal = ledger().totalHeight();

    // Act: the block folds while the row is a shell (the model says so).
    act(() => folds.set(50, { hasActivity: true, expanded: false }));
    act(() => rerender({ rev: 2 }));

    // Assert: the ledger follows the collapse immediately.
    expect(ledger().heightOf(50)).toBe(100);
    expect(ledger().sourceOf(50)).toBe("estimate");
    expect(ledger().totalHeight()).toBe(expandedTotal - 400);
  });

  it("restores the remembered height when a shell's fold re-opens", () => {
    // Arrange: row 50 measured expanded, then folded while out of band.
    const viewport = makeViewport(0, 400);
    const { controller, ledger } = makeController();
    const isPinnedRef = { current: false };
    const folds = makeFoldSource();
    folds.set(50, { hasActivity: true, expanded: true });
    const { result, rerender } = renderHook(
      ({ rev }) =>
        useChatResidentList({
          itemCount: 100,
          getEstimateHeight: () => 100,
          viewportRef: { current: viewport },
          isPinnedRef,
          controller,
          getActivityFold: folds.get,
          activityRevision: rev,
        }),
      { initialProps: { rev: 1 } },
    );
    const row = document.createElement("div");
    row.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    act(() => result.current.measureRef(50)(row));
    act(() => folds.set(50, { hasActivity: true, expanded: false }));
    act(() => rerender({ rev: 2 }));
    expect(ledger().heightOf(50)).toBe(100);

    // Act: a new activity round re-opens the fold in the still-shell row.
    act(() => folds.set(50, { hasActivity: true, expanded: true }));
    act(() => rerender({ rev: 3 }));

    // Assert: the shell grows back to the remembered expanded height.
    expect(ledger().heightOf(50)).toBe(500);
    expect(ledger().totalHeight()).toBe(99 * 100 + 500);
  });

  it("leaves a still-expanded shell and a rich row to their own measurement", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller, ledger } = makeController();
    const isPinnedRef = { current: false };
    const folds = makeFoldSource();
    folds.set(50, { hasActivity: true, expanded: true });
    folds.set(3, { hasActivity: true, expanded: false });
    const { result, rerender } = renderHook(
      ({ rev }) =>
        useChatResidentList({
          itemCount: 100,
          getEstimateHeight: () => 100,
          viewportRef: { current: viewport },
          isPinnedRef,
          controller,
          getActivityFold: folds.get,
          activityRevision: rev,
        }),
      { initialProps: { rev: 1 } },
    );
    const shellRow = document.createElement("div");
    shellRow.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    const richRow = document.createElement("div");
    richRow.getBoundingClientRect = () => ({ height: 300 }) as DOMRect;
    act(() => {
      result.current.measureRef(50)(shellRow);
      result.current.measureRef(3)(richRow);
    });

    // Act: the revision moves but neither the shell nor the rich row folded.
    act(() => rerender({ rev: 2 }));

    // Assert: the rich row keeps its measurement; the shell keeps its height
    // because the model still reports it expanded.
    expect(ledger().heightOf(3)).toBe(300);
    expect(ledger().sourceOf(3)).toBe("measured");
    expect(ledger().heightOf(50)).toBe(500);

    // Act: the rich row folds and re-measures itself (no model re-seed needed).
    richRow.getBoundingClientRect = () => ({ height: 80 }) as DOMRect;
    act(() => folds.set(3, { hasActivity: true, expanded: false }));
    act(() => {
      result.current.measureRef(3)(richRow);
      rerender({ rev: 3 });
    });

    // Assert: the model-driven pass did not touch the measured row.
    expect(ledger().heightOf(3)).toBe(80);
    expect(ledger().sourceOf(3)).toBe("measured");
  });

  it("returns an empty band for an empty conversation", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller } = makeController();

    // Act
    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 0,
        getEstimateHeight: () => 100,
        viewportRef: { current: viewport },
        isPinnedRef: { current: false },
        controller,
      }),
    );

    // Assert
    expect(result.current.rowCount).toBe(0);
    expect(result.current.bandStore.isRich(0)).toBe(false);
  });

  it("drops remembered heights when the row identity changes", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller, ledger } = makeController();
    const isPinnedRef = { current: false };

    const { result, rerender } = renderHook(
      ({ resetKey }) =>
        useChatResidentList({
          itemCount: 50,
          getEstimateHeight: () => 100,
          viewportRef: { current: viewport },
          isPinnedRef,
          controller,
          resetKey,
        }),
      { initialProps: { resetKey: "chat-a:all" } },
    );

    const row = document.createElement("div");
    row.getBoundingClientRect = () => ({ height: 250 }) as DOMRect;
    act(() => {
      result.current.measureRef(5)(row);
    });
    expect(ledger().sourceOf(5)).toBe("measured");

    // Act: a transcript filter switch renumbers the rows.
    rerender({ resetKey: "chat-a:conversation" });

    // Assert: the stale measurement cannot pose as real for a different row.
    expect(ledger().sourceOf(5)).toBe("estimate");
    expect(ledger().heightOf(5)).toBe(100);
  });

  it("renders the whole list rich when the shell band is disabled", () => {
    // Arrange
    const viewport = makeViewport(0, 400);
    const { controller } = makeController();

    // Act
    const { result } = renderHook(() =>
      useChatResidentList({
        itemCount: 200,
        getEstimateHeight: () => 100,
        viewportRef: { current: viewport },
        isPinnedRef: { current: false },
        controller,
        enabled: false,
      }),
    );

    // Assert
    expect(result.current.bandStore.isRich(0)).toBe(true);
    expect(result.current.bandStore.isRich(199)).toBe(true);
  });
});
