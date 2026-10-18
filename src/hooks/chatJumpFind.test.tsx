// @vitest-environment jsdom
/**
 * End-to-end: a rail / find jump lands through the real viewport controller and
 * the real resident list.
 *
 * The controller's unit tests cover the landing state; this wires the whole
 * chain — controller write → synchronous band re-computation (ticket 05) → the
 * jumped-to row renders real content, not a shell — and holds the landed
 * element across a later height change (C3 on a jump). Geometry is stubbed
 * (jsdom has no layout); the observers, the ledger and the React commit are
 * real.
 */

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useChatViewportController,
  type ChatViewportControllerHandle,
  type EscapedAnchorElement,
} from "./useChatViewportController";
import {
  useChatResidentList,
  type UseChatResidentListResult,
} from "./useChatResidentList";

/** The controller subscribes to a host event; jsdom has no Tauri. */
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

class ControlledResizeObserver {
  private static readonly instances = new Set<ControlledResizeObserver>();
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControlledResizeObserver.instances.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    ControlledResizeObserver.instances.delete(this);
  }
  static emit(target: Element, height: number, width = 800) {
    const entry = { target, contentRect: { height, width } } as ResizeObserverEntry;
    ControlledResizeObserver.instances.forEach((observer) => {
      if (observer.targets.has(target)) {
        observer.callback([entry], observer as unknown as ResizeObserver);
      }
    });
  }
  static reset() {
    ControlledResizeObserver.instances.clear();
  }
}

const ITEM_COUNT = 30;
const ROW_ESTIMATE = 200;
const VIEWPORT_HEIGHT = 400;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function Row({
  index,
  list,
}: {
  index: number;
  list: UseChatResidentListResult;
}) {
  useSyncExternalStore(list.bandStore.subscribeFor(index), () =>
    list.bandStore.isRich(index) ? "rich" : "shell",
  );
  const isRich = list.bandStore.isRich(index);
  return (
    <div
      ref={isRich ? list.measureRef(index) : undefined}
      data-virt-index={index}
      style={{ height: list.rowHeight(index) }}
    />
  );
}

type Handles = {
  controller: ChatViewportControllerHandle;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<EscapedAnchorElement | null>;
  isPinnedRef: RefObject<boolean>;
  escapedRef: RefObject<boolean>;
  list: UseChatResidentListResult;
};

function Harness({ onReady }: { onReady: (handles: Handles) => void }) {
  const {
    viewportRef,
    contentRef,
    isPinnedRef,
    escapedRef,
    controller,
    anchorRef,
  } = useChatViewportController({});
  const list = useChatResidentList({
    itemCount: ITEM_COUNT,
    getEstimateHeight: () => ROW_ESTIMATE,
    viewportRef,
    isPinnedRef,
    controller,
  });
  useEffect(() => {
    onReady({
      controller,
      viewportRef,
      contentRef,
      anchorRef,
      isPinnedRef,
      escapedRef,
      list,
    });
  }, [
    onReady,
    controller,
    viewportRef,
    contentRef,
    anchorRef,
    isPinnedRef,
    escapedRef,
    list,
  ]);
  return (
    <div ref={viewportRef}>
      <div ref={contentRef}>
        {Array.from({ length: ITEM_COUNT }, (_, index) => (
          <Row key={index} index={index} list={list} />
        ))}
      </div>
    </div>
  );
}

/** Give the rendered viewport / content / rows the geometry jsdom cannot. */
function stubGeometry(
  viewport: HTMLDivElement,
  content: HTMLDivElement,
  controller: ChatViewportControllerHandle,
): void {
  let scrollTop = 0;
  Object.defineProperties(viewport, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => controller.ledger().totalHeight(),
    },
    clientHeight: { configurable: true, get: () => VIEWPORT_HEIGHT },
    clientWidth: { configurable: true, get: () => 800 },
  });
  Object.defineProperty(viewport, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(0, VIEWPORT_HEIGHT),
  });
  Object.defineProperty(content, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(-viewport.scrollTop, controller.ledger().totalHeight()),
  });
  for (const row of content.querySelectorAll<HTMLElement>("[data-virt-index]")) {
    const index = Number(row.dataset.virtIndex);
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        rect(
          controller.ledger().offsetOf(index) - viewport.scrollTop,
          controller.ledger().heightOf(index),
        ),
    });
  }
}

describe("jump landing through the resident list (end to end)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ControlledResizeObserver.reset();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    cleanup();
    ControlledResizeObserver.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  const settle = async () => {
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
  };

  async function mountReady() {
    let handles: Handles | null = null;
    const onReady = (next: Handles) => {
      handles = next;
    };
    render(<Harness onReady={onReady} />);
    const ready = handles as unknown as Handles;
    stubGeometry(ready.viewportRef.current!, ready.contentRef.current!, ready.controller);
    await settle();
    return ready;
  }

  it("renders the jumped-to row rich in the write path, with no shell in the band", async () => {
    // Arrange — the transcript opens pinned at its tail.
    const ready = await mountReady();
    const { controller, viewportRef, list, isPinnedRef, escapedRef } = ready;
    const viewport = viewportRef.current!;
    expect(list.bandStore.isRich(5)).toBe(false);
    expect(list.bandStore.isRich(ITEM_COUNT - 1)).toBe(true);

    // Act — a find jump to a message far outside the band.
    act(() => controller.jumpTo("jump:find", 5 * ROW_ESTIMATE, false));

    // Assert — the band moved to the landing synchronously; no row that
    // crosses the viewport is a shell.
    const firstCrossing = Math.floor(viewport.scrollTop / ROW_ESTIMATE);
    const lastCrossing = Math.ceil(
      (viewport.scrollTop + VIEWPORT_HEIGHT) / ROW_ESTIMATE,
    );
    const crossing = Array.from(
      { length: lastCrossing - firstCrossing },
      (_, n) => firstCrossing + n,
    );
    expect(crossing.every((index) => list.bandStore.isRich(index))).toBe(true);
    // The state the trace reports: escaped, holding the landed message.
    expect(isPinnedRef.current).toBe(false);
    expect(escapedRef.current).toBe(true);
  });

  it("holds the landed message across a height change above it", async () => {
    // Arrange — land on row 5, at the viewport top.
    const ready = await mountReady();
    const { controller, viewportRef, anchorRef } = ready;
    const viewport = viewportRef.current!;
    act(() => controller.jumpTo("jump:find", 5 * ROW_ESTIMATE, false));
    await settle();
    const anchor = anchorRef.current;
    expect(anchor?.element?.dataset.virtIndex).toBe("5");
    const heldTop = anchor!.element!.getBoundingClientRect().top;
    const heldScrollTop = viewport.scrollTop;

    // Act — a row above the landing grows 300px in a layout batch.
    act(() => {
      controller.reportRowHeight(2, ROW_ESTIMATE + 300);
      controller.restoreLayout();
    });

    // Assert — the writer moved by exactly that growth; the anchor held.
    expect(viewport.scrollTop).toBe(heldScrollTop + 300);
    expect(anchor!.element!.getBoundingClientRect().top).toBeCloseTo(heldTop, 5);
  });

  it("re-engages follow on a jump to the conversation's last row", async () => {
    // Arrange — escaped on a historical row.
    const ready = await mountReady();
    const { controller, viewportRef, anchorRef, list } = ready;
    const viewport = viewportRef.current!;
    act(() => controller.jumpTo("jump:find", 5 * ROW_ESTIMATE, false));
    await settle();
    expect(anchorRef.current?.element).toBeTruthy();

    // Act — a jump whose target is the last row.
    act(() => controller.jumpTo("jump:find", 0, true));

    // Assert — pinned at the content end, and the last row is real content.
    expect(viewport.scrollTop).toBe(
      controller.ledger().totalHeight() - VIEWPORT_HEIGHT,
    );
    expect(list.bandStore.isRich(ITEM_COUNT - 1)).toBe(true);
    expect(anchorRef.current).toBeNull();
  });
});
