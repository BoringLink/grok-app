/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { createLayoutLedger } from "@/lib/chatViewportLedger";
import type { ChatViewportControllerHandle } from "@/hooks/useChatViewportController";
import { useChatResidentList } from "./useChatResidentList";

afterEach(cleanup);

/** Controller stub backed by a real ledger; only the list's calls matter here. */
function makeController() {
  let ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
  const restoreLayout = vi.fn();
  const controller = {
    ledger: () => ledger,
    reportRowHeight(index: number, height: number) {
      if (index >= ledger.rowCount()) ledger.setCount(index + 1);
      ledger.setRowHeight(index, height, "measured");
    },
    resetLedger() {
      ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
    },
    restoreLayout,
    assign: vi.fn(),
    escape: vi.fn(),
    pinToEnd: vi.fn(),
  } as unknown as ChatViewportControllerHandle;
  return { controller, restoreLayout, ledger: () => ledger };
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
    const viewBottom = scrollTop + clientHeight;
    for (let i = 0; i < 200; i++) {
      const rowTop = i * rowHeight;
      const rowBottom = rowTop + rowHeight;
      const intersects = rowBottom > scrollTop && rowTop < viewBottom;
      if (intersects) {
        expect(result.current.bandStore.isRich(i)).toBe(true);
      }
    }
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
