// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatViewportWriteStats,
  lastPinFlipCause,
  resetChatViewportTrace,
  setChatViewportTraceEnabled,
} from "@/lib/chatViewportTrace";
import { STICK_BOTTOM_REBOUND_SETTLE_MS } from "@/lib/stickToBottom";
import { useChatViewportController, type UseChatViewportControllerResult } from "./useChatViewportController";

/**
 * The controller subscribes to the host occlusion event with a dynamic import
 * of the Tauri event API. jsdom has no Tauri, so the module is mocked: the
 * handler is captured and the test fires it, which is exactly the client half
 * of the macOS covered-window signal.
 */
const hostOcclusion = vi.hoisted(() => ({
  handlers: new Set<(event: { payload: unknown }) => void>(),
  listen: vi.fn(
    async (_name: string, handler: (event: { payload: unknown }) => void) => {
      hostOcclusion.handlers.add(handler);
      return () => hostOcclusion.handlers.delete(handler);
    },
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: hostOcclusion.listen }));

/** Deliver a host occlusion report, after the controller's import registers. */
async function deliverHostOcclusion(occluded: boolean): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    for (const handler of [...hostOcclusion.handlers]) {
      handler({ payload: { occluded } });
    }
  });
}

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
    const entry = {
      target,
      contentRect: { height, width },
    } as ResizeObserverEntry;
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

function flushLayoutFrame() {
  vi.advanceTimersByTime(16);
}

describe("useChatViewportController bottom rebound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ControlledResizeObserver.reset();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    cleanup();
    ControlledResizeObserver.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("snaps to the latest max after a downward overscroll rebounds upward", () => {
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    let scrollTop = 600;
    let scrollHeight = 1000;
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
        get: () => scrollHeight,
      },
      clientHeight: {
        configurable: true,
        get: () => 400,
      },
      clientWidth: {
        configurable: true,
        get: () => 800,
      },
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });

    // Re-run effects after refs point at the real WebView scroll container.
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));
    scrollTop = 600;

    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      // Queue/composer grows during the elastic settle: true max is now 640.
      scrollHeight = 1040;
      scrollTop = 620;
      viewport.dispatchEvent(new Event("scroll"));
      scrollTop = 600;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(STICK_BOTTOM_REBOUND_SETTLE_MS + 1);
    });

    expect(scrollTop).toBe(640);
    expect(result.current.isPinnedRef.current).toBe(true);
  });

  it("keeps a real upward wheel gesture escaped", () => {
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    let scrollTop = 600;
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));
    scrollTop = 600;

    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      scrollTop = 550;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(STICK_BOTTOM_REBOUND_SETTLE_MS + 20);
    });

    expect(scrollTop).toBe(550);
    expect(result.current.isPinnedRef.current).toBe(false);
  });

  it("follows continuous large growth with a leading and trailing snap", () => {
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    let scrollTop = 600;
    let scrollHeight = 1000;
    let contentHeight = 1000;
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });
    Object.defineProperty(content, "offsetHeight", {
      configurable: true,
      get: () => contentHeight,
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => {
      vi.advanceTimersByTime(40);
      viewport.dispatchEvent(new Event("scroll"));
      flushLayoutFrame();
    });

    act(() => {
      ControlledResizeObserver.emit(content, contentHeight);
      flushLayoutFrame();
      contentHeight = 1030;
      scrollHeight = 1030;
      ControlledResizeObserver.emit(content, contentHeight);
      flushLayoutFrame();
    });
    expect(scrollTop).toBe(630);

    act(() => {
      contentHeight = 1060;
      scrollHeight = 1060;
      ControlledResizeObserver.emit(content, contentHeight);
      flushLayoutFrame();
      contentHeight = 1090;
      scrollHeight = 1090;
      ControlledResizeObserver.emit(content, contentHeight);
      flushLayoutFrame();
      vi.advanceTimersByTime(64);
    });

    expect(scrollTop).toBe(690);
    expect(result.current.isPinnedRef.current).toBe(true);
  });

  it("keeps pin when growth exposes a small native rebound", () => {
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    let scrollTop = 600;
    let scrollHeight = 1000;
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => {
      vi.advanceTimersByTime(40);
      viewport.dispatchEvent(new Event("scroll"));
      vi.runOnlyPendingTimers();
    });

    act(() => {
      scrollHeight = 1207;
      scrollTop = 598;
      viewport.dispatchEvent(new Event("scroll"));
    });

    expect(scrollTop).toBe(807);
    expect(result.current.isPinnedRef.current).toBe(true);
  });
});

/**
 * Escape policy: a scroll move that no user gesture can explain is a layout
 * clamp (a folding thought / tool block collapses above the viewport and the
 * browser clamps scrollTop with the new content height). It must hold the pin
 * instead of releasing it, or the rest of the turn stops being followed.
 */
describe("useChatViewportController escape policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ControlledResizeObserver.reset();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    cleanup();
    ControlledResizeObserver.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mountPinned(initial: { scrollTop: number; scrollHeight: number }) {
    let scrollTop = initial.scrollTop;
    let scrollHeight = initial.scrollHeight;
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => {
      vi.advanceTimersByTime(40);
      viewport.dispatchEvent(new Event("scroll"));
    });
    scrollTop = initial.scrollTop;

    return {
      viewport,
      content,
      result: result as { current: UseChatViewportControllerResult },
      scrollTop: () => scrollTop,
      setScrollTop: (value: number) => {
        scrollTop = value;
      },
      setScrollHeight: (value: number) => {
        scrollHeight = value;
      },
    };
  }

  it("keeps the pin when a collapse above the viewport clamps scrollTop", () => {
    const harness = mountPinned({ scrollTop: 600, scrollHeight: 1000 });

    act(() => {
      // Folding block above: the browser clamps with the new max ...
      harness.setScrollHeight(700);
      harness.setScrollTop(300);
      // ... and the height returns (streaming continues elsewhere) before the
      // scroll event reaches the handler, so no shrink is observable.
      harness.setScrollHeight(1000);
      harness.viewport.dispatchEvent(new Event("scroll"));
    });

    expect(harness.scrollTop()).toBe(600);
    expect(harness.result.current.isPinnedRef.current).toBe(true);
    expect(harness.result.current.escapedRef.current).toBe(false);
  });

  it("escapes after repeated gesture-free upward scrolling at a stable height", () => {
    const harness = mountPinned({ scrollTop: 600, scrollHeight: 1000 });

    act(() => {
      harness.setScrollTop(590);
      harness.viewport.dispatchEvent(new Event("scroll"));
    });
    expect(harness.result.current.isPinnedRef.current).toBe(true);

    act(() => {
      harness.setScrollTop(580);
      harness.viewport.dispatchEvent(new Event("scroll"));
    });
    expect(harness.result.current.isPinnedRef.current).toBe(false);
    expect(harness.result.current.escapedRef.current).toBe(true);
  });

  it("re-asserts the bottom inside the mutation batch that shrank the content", async () => {
    const harness = mountPinned({ scrollTop: 600, scrollHeight: 1000 });

    // Collapse clamped the viewport; the height came back in the same task.
    harness.setScrollHeight(760);
    harness.setScrollTop(360);
    harness.setScrollHeight(1000);

    await act(async () => {
      harness.content.appendChild(document.createElement("div"));
    });

    expect(harness.scrollTop()).toBe(600);
  });

  it("coalesces a frame's mutation batches into a single transcript write", async () => {
    // Arrange — pinned, sitting off the end, with the trace counting writes.
    resetChatViewportTrace();
    setChatViewportTraceEnabled(true);
    const harness = mountPinned({ scrollTop: 600, scrollHeight: 1000 });
    harness.setScrollHeight(1200);
    harness.setScrollTop(200);
    const before = chatViewportWriteStats().writes;

    // Act — several DOM mutations land in one microtask (one batch).
    await act(async () => {
      harness.content.appendChild(document.createElement("div"));
      harness.content.appendChild(document.createElement("span"));
    });

    // Assert — the batch-end restore writes the content end exactly once.
    expect(chatViewportWriteStats().writes - before).toBe(1);
    expect(harness.scrollTop()).toBe(800);

    // Act — a second batch before the frame latch clears.
    harness.setScrollHeight(1500);
    harness.setScrollTop(300);
    await act(async () => {
      harness.content.appendChild(document.createElement("b"));
    });

    // Assert — coalesced into the first write; the latch holds until the frame.
    expect(chatViewportWriteStats().writes - before).toBe(1);

    setChatViewportTraceEnabled(null);
    resetChatViewportTrace();
  });

  it("records a button cause when the explicit control re-pins an escaped view", () => {
    // Arrange — escape first, so the re-pin is a real flip.
    resetChatViewportTrace();
    const harness = mountPinned({ scrollTop: 600, scrollHeight: 1000 });
    act(() => {
      harness.setScrollTop(590);
      harness.viewport.dispatchEvent(new Event("scroll"));
      harness.setScrollTop(580);
      harness.viewport.dispatchEvent(new Event("scroll"));
    });
    expect(harness.result.current.escapedRef.current).toBe(true);
    expect(lastPinFlipCause()).toBe("scrollbar");

    // Act — the "back to bottom" button path: scrollToBottom with its reason.
    act(() => {
      harness.result.current.scrollToBottom("instant", "button-scroll-to-bottom");
    });

    // Assert
    expect(harness.result.current.isPinnedRef.current).toBe(true);
    expect(harness.result.current.escapedRef.current).toBe(false);
    expect(lastPinFlipCause()).toBe("button");
  });
});

/**
 * The controller is the transcript's single writer. Other transcript modules
 * (the resident list, the rail / find jumps) call this handle instead of
 * assigning `scrollTop` themselves.
 */
describe("useChatViewportController handle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ControlledResizeObserver.reset();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    cleanup();
    ControlledResizeObserver.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  function mount(initial: { scrollTop: number; scrollHeight: number }) {
    let scrollTop = initial.scrollTop;
    let scrollHeight = initial.scrollHeight;
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));

    return {
      viewport,
      controller: result.current.controller,
      isPinnedRef: result.current.isPinnedRef,
      escapedRef: result.current.escapedRef,
      scrollTop: () => scrollTop,
      setScrollTop: (value: number) => {
        scrollTop = value;
      },
      setScrollHeight: (value: number) => {
        scrollHeight = value;
      },
    };
  }

  /** Viewport with a row above and a row at the viewport top, both measured. */
  function mountWithRows(input: { scrollTop: number; aboveHeight: number }) {
    let scrollTop = input.scrollTop;
    let aboveHeight = input.aboveHeight;
    let scrollHeight = 1000;
    const rowHeight = 300;
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    const above = document.createElement("div");
    const anchorRow = document.createElement("div");
    content.append(above, anchorRow);
    viewport.appendChild(content);
    document.body.appendChild(viewport);

    const rect = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(0, 400),
    });
    Object.defineProperty(content, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(-scrollTop, scrollHeight),
    });
    Object.defineProperty(above, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(-scrollTop, aboveHeight),
    });
    Object.defineProperty(anchorRow, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(aboveHeight - scrollTop, rowHeight),
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));
    // Undo the conversation-switch pin so the test controls the position.
    scrollTop = input.scrollTop;

    return {
      controller: result.current.controller,
      isPinnedRef: result.current.isPinnedRef,
      escapedRef: result.current.escapedRef,
      content,
      scrollTop: () => scrollTop,
      aboveHeight: () => aboveHeight,
      setAboveHeight: (value: number) => {
        aboveHeight = value;
      },
      setScrollHeight: (value: number) => {
        scrollHeight = value;
      },
    };
  }

  it("writes the transcript position through assign", () => {
    const harness = mount({ scrollTop: 600, scrollHeight: 1000 });

    act(() => {
      harness.controller.assign("test:jump", 240);
    });

    expect(harness.scrollTop()).toBe(240);
  });
  it("re-seeds a shell row through reestimateRow", () => {
    const harness = mount({ scrollTop: 0, scrollHeight: 1000 });

    act(() => harness.controller.reportRowHeight(0, 500));
    expect(harness.controller.ledger().heightOf(0)).toBe(500);
    expect(harness.controller.ledger().sourceOf(0)).toBe("measured");

    act(() => harness.controller.reestimateRow(0, 60, () => false));

    expect(harness.controller.ledger().heightOf(0)).toBe(60);
    expect(harness.controller.ledger().sourceOf(0)).toBe("estimate");
  });

  it("refuses to demote a row that is rendering real content", () => {
    const harness = mount({ scrollTop: 0, scrollHeight: 1000 });

    act(() => harness.controller.reportRowHeight(0, 500));

    // The band predicate says the row is inside the band (rich).
    act(() => harness.controller.reestimateRow(0, 60, () => true));

    expect(harness.controller.ledger().heightOf(0)).toBe(500);
    expect(harness.controller.ledger().sourceOf(0)).toBe("measured");
  });

  it("refuses a measurement taken before a shell row was re-estimated", () => {
    const harness = mount({ scrollTop: 0, scrollHeight: 1000 });

    act(() => harness.controller.reportRowHeight(0, 500, 0));
    const stale = harness.controller.ledger().generationOf(0);
    act(() => harness.controller.reestimateRow(0, 60, () => false));

    // The late entry for the old expanded shape arrives after the demotion.
    act(() => harness.controller.reportRowHeight(0, 500, stale));

    expect(harness.controller.ledger().heightOf(0)).toBe(60);
    expect(harness.controller.ledger().sourceOf(0)).toBe("estimate");
  });

  it("escape detaches from the bottom and clears the pin", () => {
    const harness = mount({ scrollTop: 600, scrollHeight: 1000 });

    act(() => {
      harness.controller.escape("test:locate");
    });

    expect(harness.isPinnedRef.current).toBe(false);
    expect(harness.escapedRef.current).toBe(true);
  });

  it("restores the content end through restoreLayout while pinned", () => {
    const harness = mount({ scrollTop: 600, scrollHeight: 1000 });
    // Layout shrank and the browser clamped, then grew back.
    harness.setScrollTop(400);
    harness.setScrollHeight(800);

    act(() => {
      harness.setScrollHeight(1000);
      harness.controller.restoreLayout();
    });

    expect(harness.scrollTop()).toBe(600);
    expect(harness.isPinnedRef.current).toBe(true);
  });

  /**
   * A rail / find jump is a programmatic escape: after it the viewport must
   * hold the landed position, not re-snap to the tail (user story 15).
   */
  it("holds the landed position after a programmatic escape", () => {
    const harness = mount({ scrollTop: 600, scrollHeight: 1000 });

    act(() => {
      harness.controller.escape("test:locate");
      harness.controller.assign("test:locate", 320);
      harness.setScrollHeight(1000);
      harness.controller.restoreLayout();
    });

    expect(harness.scrollTop()).toBe(320);
    expect(harness.isPinnedRef.current).toBe(false);
    expect(harness.escapedRef.current).toBe(true);
  });

  /**
   * The anchor is the element at the viewport top, measured directly, so a
   * height change the ledger and the observer cannot see (a collapse above the
   * mounted band) still holds its on-screen position.
   */
  it("holds the anchor element across a height change above it", () => {
    const harness = mountWithRows({ scrollTop: 200, aboveHeight: 200 });

    act(() => {
      harness.controller.escape("test:locate");
      harness.controller.restoreLayout(); // capture the anchor element
    });

    act(() => {
      // The row above the anchor grows 100px; the browser shifts the anchor down.
      harness.setAboveHeight(300);
      harness.controller.restoreLayout();
    });

    expect(harness.scrollTop()).toBe(300);
    expect(harness.isPinnedRef.current).toBe(false);
  });

  /**
   * AC1 — a nested scroller expanding or collapsing must leave the outer anchor
   * exactly where it is. The nested change reaches the controller as a content
   * mutation, which it restores inside the batch (before paint), not a frame
   * later via a ResizeObserver.
   */
  it("holds the escaped anchor across a nested scroller resize (mutation batch)", async () => {
    const harness = mountWithRows({ scrollTop: 200, aboveHeight: 200 });
    act(() => {
      harness.controller.escape("test:locate");
      harness.controller.restoreLayout(); // capture the anchor element
    });
    const anchorScreenTop = harness.aboveHeight() - harness.scrollTop();

    // Act: the thinking body above the reader expands 120px in one batch.
    await act(async () => {
      harness.setAboveHeight(320);
      harness.content.appendChild(document.createElement("div"));
    });

    // Assert: the anchor has not moved on screen.
    expect(harness.aboveHeight() - harness.scrollTop()).toBe(anchorScreenTop);
    expect(harness.isPinnedRef.current).toBe(false);
    expect(harness.escapedRef.current).toBe(true);
  });

  it("keeps the pinned viewport at the content end across a nested scroller resize", async () => {
    const harness = mountWithRows({ scrollTop: 200, aboveHeight: 200 });
    // Re-pin via the explicit control, then revert to the tail model.
    act(() => harness.controller.pinToEnd("test:pin"));

    // Act: a nested scroller grows below the pinned tail.
    await act(async () => {
      harness.setAboveHeight(260);
      harness.content.appendChild(document.createElement("div"));
    });

    // Assert: still following the tail (the harness scrollHeight is stable, so
    // the observable claim is the pin state, not a coordinate).
    expect(harness.isPinnedRef.current).toBe(true);
    expect(harness.escapedRef.current).toBe(false);
  });

  /**
   * C3 — reading stability. While escaped, the element at the viewport top is
   * the anchor and each of these height-changing batches must leave its
   * on-screen position unchanged (within the 0.5px bound).
   */
  describe("escaped reading stability (C3)", () => {
    const anchorScreenTop = (harness: {
      aboveHeight: () => number;
      scrollTop: () => number;
    }) => harness.aboveHeight() - harness.scrollTop();

    function mountEscaped(input: { scrollTop: number; aboveHeight: number }) {
      const harness = mountWithRows(input);
      act(() => {
        harness.controller.escape("test:locate");
        harness.controller.restoreLayout(); // capture the anchor element
      });
      return harness;
    }

    const rect = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    /**
     * Viewport whose top sits inside a nested scroll container (an activity /
     * thinking body): the scroller box and an element inside it, both measured.
     */
    function mountNestedScroller(input: {
      scrollTop: number;
      scrollerTop: number;
      scrollerHeight: number;
      innerTop: number;
    }) {
      let scrollTop = input.scrollTop;
      let scrollerTop = input.scrollerTop;
      const scrollerHeight = input.scrollerHeight;
      let innerTop = input.innerTop;
      const scrollHeight = 4000;
      const viewport = document.createElement("div");
      const content = document.createElement("div");
      const scroller = document.createElement("div");
      const inner = document.createElement("div");
      scroller.style.overflowY = "auto"; // a real nested scroller
      scroller.appendChild(inner);
      content.appendChild(scroller);
      viewport.appendChild(content);
      document.body.appendChild(viewport);

      Object.defineProperties(viewport, {
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = value;
          },
        },
        scrollHeight: { configurable: true, get: () => scrollHeight },
        clientHeight: { configurable: true, get: () => 400 },
        clientWidth: { configurable: true, get: () => 800 },
      });
      Object.defineProperty(viewport, "getBoundingClientRect", {
        configurable: true,
        value: () => rect(0, 400),
      });
      Object.defineProperty(content, "getBoundingClientRect", {
        configurable: true,
        value: () => rect(-scrollTop, scrollHeight),
      });
      Object.defineProperty(scroller, "getBoundingClientRect", {
        configurable: true,
        value: () => rect(scrollerTop - scrollTop, scrollerHeight),
      });
      Object.defineProperty(inner, "getBoundingClientRect", {
        configurable: true,
        value: () => rect(innerTop - scrollTop, 40),
      });

      const { result, rerender } = renderHook(
        ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
        { initialProps: { keyName: "before-attach" } },
      );
      Object.assign(result.current.viewportRef, { current: viewport });
      Object.assign(result.current.contentRef, { current: content });
      rerender({ keyName: "attached" });
      act(() => vi.advanceTimersByTime(40));
      scrollTop = input.scrollTop;

      return {
        controller: result.current.controller,
        escapedRef: result.current.escapedRef,
        scrollTop: () => scrollTop,
        inner: () => inner,
        setScrollerTop: (value: number) => {
          scrollerTop = value;
        },
        setInnerTop: (value: number) => {
          innerTop = value;
        },
      };
    }

    it("corrects an anchor move just past the tolerance in a mutation batch", async () => {
      // Arrange — the write path used to skip anything under 1px, so a 0.6px
      // slide was detected and then deliberately left uncorrected.
      const harness = mountEscaped({ scrollTop: 200, aboveHeight: 200 });

      // Act
      await act(async () => {
        harness.setAboveHeight(200.6);
        harness.content.appendChild(document.createElement("div"));
      });

      // Assert — corrected, back inside the 0.5px bound.
      expect(harness.scrollTop()).toBeCloseTo(200.6, 5);
      expect(anchorScreenTop(harness)).toBeCloseTo(0, 5);
    });

    it("writes nothing for a move inside the tolerance", async () => {
      // Arrange
      const harness = mountEscaped({ scrollTop: 200, aboveHeight: 200 });

      // Act — 0.4px is noise, below the bound.
      await act(async () => {
        harness.setAboveHeight(200.4);
        harness.content.appendChild(document.createElement("div"));
      });

      // Assert
      expect(harness.scrollTop()).toBe(200);
    });

    /**
     * The anchor is never planted inside a nested scroller. A change inside one
     * (a decode especially) is not reported by the content ResizeObserver or the
     * MutationObserver, so the anchor is the scroller box instead — a position
     * the transcript controls.
     */
    it("anchors on the nested scroller box, not an element inside it", () => {
      // Arrange — the viewport top sits inside the scroller.
      const harness = mountNestedScroller({
        scrollTop: 150,
        scrollerTop: 300,
        scrollerHeight: 300,
        innerTop: 320,
      });
      act(() => {
        harness.controller.escape("test:locate");
        harness.controller.restoreLayout();
      });
      const held = harness.scrollTop();

      // Act 1 — an interior change (the inner element slides down 80px inside
      // the scroller) moves the scroller's content, not its box.
      harness.setInnerTop(400);
      act(() => harness.controller.restoreLayout());

      // Assert 1 — the anchor is unmoved; nothing wrote the transcript.
      expect(harness.scrollTop()).toBe(held);

      // Act 2 — the scroller box itself moves 80px; the anchor follows it.
      harness.setScrollerTop(380);
      act(() => harness.controller.restoreLayout());

      // Assert 2 — proving the held anchor is the scroller box.
      expect(harness.scrollTop()).toBe(held + 80);
      expect(harness.escapedRef.current).toBe(true);
    });

    it("holds the anchor when a block above it folds in a mutation batch", async () => {
      // Arrange
      const harness = mountEscaped({ scrollTop: 300, aboveHeight: 300 });
      const before = anchorScreenTop(harness);

      // Act — a thinking block above collapses 120px with the height change
      // landing in the same task as the mutation.
      await act(async () => {
        harness.setAboveHeight(180);
        harness.setScrollHeight(880);
        harness.content.appendChild(document.createElement("div"));
      });

      // Assert
      expect(anchorScreenTop(harness)).toBe(before);
      expect(harness.escapedRef.current).toBe(true);
    });

    it("holds the anchor when a block above it re-grows in a mutation batch", async () => {
      // Arrange
      const harness = mountEscaped({ scrollTop: 200, aboveHeight: 200 });
      const before = anchorScreenTop(harness);

      // Act — a streamed block above grows 140px in the same task.
      await act(async () => {
        harness.setAboveHeight(340);
        harness.setScrollHeight(1140);
        harness.content.appendChild(document.createElement("div"));
      });

      // Assert
      expect(anchorScreenTop(harness)).toBe(before);
      expect(harness.escapedRef.current).toBe(true);
    });

    it("holds the anchor while output keeps arriving at the bottom", async () => {
      // Arrange
      const harness = mountEscaped({ scrollTop: 200, aboveHeight: 200 });
      const before = anchorScreenTop(harness);
      const beforeTop = harness.scrollTop();

      // Act — two stream frames grow the content below the anchor.
      await act(async () => {
        harness.setScrollHeight(1200);
        harness.content.appendChild(document.createElement("span"));
      });
      await act(async () => {
        harness.setScrollHeight(1500);
        harness.content.appendChild(document.createElement("b"));
      });

      // Assert — the reader is not dragged and the anchor does not move.
      expect(harness.scrollTop()).toBe(beforeTop);
      expect(anchorScreenTop(harness)).toBe(before);
      expect(harness.escapedRef.current).toBe(true);
    });

    it("holds the anchor when a media element above it finishes decode", () => {
      // Arrange
      const harness = mountEscaped({ scrollTop: 200, aboveHeight: 200 });
      const before = anchorScreenTop(harness);

      // Act — a decode takes its rendered height with no DOM mutation carrying
      // the new size: only the content ResizeObserver reports it.
      act(() => {
        harness.setAboveHeight(340);
        harness.setScrollHeight(1140);
        ControlledResizeObserver.emit(harness.content, 1140, 800);
      });

      // Assert — restored in the observer callback, before any frame advances.
      expect(anchorScreenTop(harness)).toBe(before);
      expect(harness.escapedRef.current).toBe(true);
    });

    it("does not move the escaped anchor when a media element below it finishes decode", () => {
      // Arrange
      const harness = mountEscaped({ scrollTop: 200, aboveHeight: 200 });
      const before = anchorScreenTop(harness);
      const beforeTop = harness.scrollTop();

      // Act — a decode below the anchor grows the content column only.
      act(() => {
        harness.setScrollHeight(1600);
        ControlledResizeObserver.emit(harness.content, 1600, 800);
      });

      // Assert — a change below the anchor leaves it at zero displacement.
      expect(harness.scrollTop()).toBe(beforeTop);
      expect(anchorScreenTop(harness)).toBe(before);
      expect(harness.escapedRef.current).toBe(true);
    });
  });

  /**
   * A rail / find jump lands through `jumpTo`: a non-tail target escapes onto
   * the landed element and holds it; a jump to the conversation's last row (or
   * one that clamps to the content end) re-engages follow.
   */
  describe("programmatic jump landing", () => {
    const anchorScreenTop = (harness: {
      aboveHeight: () => number;
      scrollTop: () => number;
    }) => harness.aboveHeight() - harness.scrollTop();

    it("escapes onto a non-tail landing and holds it across a height change above", () => {
      // Arrange — pinned at the top, a measured block above the anchor row.
      const harness = mountWithRows({ scrollTop: 200, aboveHeight: 200 });

      // Act — a find jump to a non-tail message.
      act(() =>
        harness.controller.jumpTo("jump:test", { kind: "position", top: 320 }),
      );

      // Assert — escaped, landed, with the landing as the anchor.
      expect(harness.isPinnedRef.current).toBe(false);
      expect(harness.escapedRef.current).toBe(true);
      expect(harness.scrollTop()).toBe(320);
      const held = anchorScreenTop(harness);

      // Act — a block above the landing re-grows in a layout batch.
      act(() => {
        harness.setAboveHeight(300);
        harness.controller.restoreLayout();
      });

      // Assert — the landed message stays where it landed (C3 on a jump).
      expect(anchorScreenTop(harness)).toBe(held);
      expect(harness.escapedRef.current).toBe(true);
    });

    it("re-engages follow on a jump whose target is the conversation's last row", () => {
      // Arrange — escaped, reading history.
      const harness = mount({ scrollTop: 600, scrollHeight: 1000 });
      act(() => harness.controller.escape("test:locate"));
      expect(harness.escapedRef.current).toBe(true);

      // Act — a jump to the last row (the tail), even while it streams.
      act(() => harness.controller.jumpTo("jump:test", { kind: "end" }));

      // Assert — pinned at the content end.
      expect(harness.isPinnedRef.current).toBe(true);
      expect(harness.escapedRef.current).toBe(false);
      expect(harness.scrollTop()).toBe(600);
    });

    it("re-engages follow when a jump clamps to the content end", () => {
      // Arrange — pinned at the top; the jump target is past the content end.
      const harness = mount({ scrollTop: 0, scrollHeight: 1000 });

      // Act
      act(() =>
        harness.controller.jumpTo("jump:test", { kind: "position", top: 5000 }),
      );

      // Assert — the engine clamped the write to the end, so follow re-engages.
      expect(harness.scrollTop()).toBe(600);
      expect(harness.isPinnedRef.current).toBe(true);
      expect(harness.escapedRef.current).toBe(false);
    });
  });
});

/**
 * Occlusion (C5) and window resize. The engine stops painting while a window is
 * hidden or collapsed, so the position is only judged on the first frame the
 * viewport is available again — which the controller reaches synchronously in
 * the availability handler (and once more in the first rAF for a minimized
 * window, whose scroller is still collapsed at the synchronous read).
 */
describe("useChatViewportController occlusion and window resize", () => {
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    hostOcclusion.handlers.clear();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    ControlledResizeObserver.reset();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    cleanup();
    ControlledResizeObserver.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  const rect = (top: number, height: number, width = 800): DOMRect =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: width,
      width,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  function mountBasic(initial: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }) {
    let scrollTop = initial.scrollTop;
    let scrollHeight = initial.scrollHeight;
    let clientHeight = initial.clientHeight;
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    document.body.appendChild(viewport);
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
      clientWidth: { configurable: true, get: () => 800 },
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => {
      vi.advanceTimersByTime(40);
      viewport.dispatchEvent(new Event("scroll"));
    });
    scrollTop = initial.scrollTop;

    return {
      viewport,
      content,
      result: result as { current: UseChatViewportControllerResult },
      scrollTop: () => scrollTop,
      setScrollTop: (value: number) => {
        scrollTop = value;
      },
      setScrollHeight: (value: number) => {
        scrollHeight = value;
      },
      setClientHeight: (value: number) => {
        clientHeight = value;
      },
    };
  }

  /** Viewport with a measured block above the row at the viewport top. */
  function mountAnchor(initial: {
    scrollTop: number;
    aboveHeight: number;
    scrollHeight: number;
  }) {
    let scrollTop = initial.scrollTop;
    let aboveHeight = initial.aboveHeight;
    let scrollHeight = initial.scrollHeight;
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    const above = document.createElement("div");
    const anchorRow = document.createElement("div");
    content.append(above, anchorRow);
    viewport.appendChild(content);
    document.body.appendChild(viewport);

    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(0, 400),
    });
    Object.defineProperty(content, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(-scrollTop, scrollHeight),
    });
    Object.defineProperty(above, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(-scrollTop, aboveHeight),
    });
    Object.defineProperty(anchorRow, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(aboveHeight - scrollTop, 300),
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));
    scrollTop = initial.scrollTop;

    return {
      viewport,
      result: result as { current: UseChatViewportControllerResult },
      scrollTop: () => scrollTop,
      setScrollHeight: (value: number) => {
        scrollHeight = value;
      },
      setAboveHeight: (value: number) => {
        aboveHeight = value;
      },
    };
  }

  it("restores the content end synchronously when a hidden window returns", () => {
    // Arrange — pinned at the tail, then the window is hidden.
    const harness = mountBasic({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });

    // Act — hidden; content kept arriving, scrollTop stayed stale.
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    harness.setScrollTop(200);
    harness.setScrollHeight(1500);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Assert — restored on the first frame, with no timer advanced.
    expect(harness.scrollTop()).toBe(1100);
    expect(harness.result.current.isPinnedRef.current).toBe(true);
  });

  it("restores the invariant on the first frame after the window regains focus", () => {
    // Arrange — the window is covered (blurred): no visibilitychange fires, and
    // content grew while the frame was not being painted.
    const harness = mountBasic({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.setScrollTop(200);
    harness.setScrollHeight(1500);

    // Act
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    // Assert — the focus regain is the only boundary this case gets.
    expect(harness.scrollTop()).toBe(1100);
  });

  it("holds the escaped anchor on the first frame after occlusion, never yanking to the end", () => {
    // Arrange — escaped, reading history.
    const harness = mountAnchor({ scrollTop: 200, aboveHeight: 200, scrollHeight: 1000 });
    act(() => {
      harness.result.current.controller.escape("test:locate");
      harness.result.current.controller.restoreLayout();
    });
    expect(harness.scrollTop()).toBe(200);

    // Act — occluded; content grew below, the anchor above did not move.
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    harness.setScrollHeight(1600);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Assert — the anchor holds its screen position; escape survives (C5 + C3).
    expect(harness.scrollTop()).toBe(200);
    expect(harness.result.current.escapedRef.current).toBe(true);
    expect(harness.result.current.isPinnedRef.current).toBe(false);
  });

  it("holds the escaped anchor across a viewport resize, before paint", () => {
    // Arrange — escaped with a measured block above the anchor.
    const harness = mountAnchor({ scrollTop: 200, aboveHeight: 200, scrollHeight: 1000 });
    act(() => {
      harness.result.current.controller.escape("test:locate");
      harness.result.current.controller.restoreLayout();
    });

    // Act — a width change reflows the block above the anchor by +100px.
    harness.setAboveHeight(300);
    act(() => {
      ControlledResizeObserver.emit(harness.viewport, 400, 700);
    });

    // Assert — the anchor is held synchronously, with no frame advanced (C3).
    expect(harness.scrollTop()).toBe(300);
    expect(harness.result.current.escapedRef.current).toBe(true);
  });

  it("re-follows the content end after a viewport resize while pinned", () => {
    // Arrange
    const harness = mountBasic({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });

    // Act — the window is resized shorter; the browser clamps and the
    // controller must re-assert the (new) content end on this frame.
    harness.setClientHeight(300);
    act(() => {
      ControlledResizeObserver.emit(harness.viewport, 300, 800);
    });

    // Assert — no frame advanced: the RO callback restores before paint.
    expect(harness.scrollTop()).toBe(700);
    expect(harness.result.current.isPinnedRef.current).toBe(true);
  });

  it("keeps restoring batches after the frame latch when rAF is paused", async () => {
    // Arrange — a pinned viewport, then rAF stops (occluded/backgrounded).
    const harness = mountBasic({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});

    // First mutation batch restores and arms the latch.
    harness.setScrollHeight(1200);
    harness.setScrollTop(200);
    await act(async () => {
      harness.content.appendChild(document.createElement("div"));
    });
    expect(harness.scrollTop()).toBe(800);

    // Second batch is coalesced by the latch (no frame has arrived).
    harness.setScrollHeight(1400);
    harness.setScrollTop(300);
    await act(async () => {
      harness.content.appendChild(document.createElement("span"));
    });
    expect(harness.scrollTop()).toBe(300);

    // Act — the stall fallback clears the latch even though rAF never fires.
    act(() => vi.advanceTimersByTime(200));
    await act(async () => {
      harness.setScrollTop(400);
      harness.content.appendChild(document.createElement("b"));
    });

    // Assert — the transcript is restored again instead of staying stale.
    expect(harness.scrollTop()).toBe(1000);
  });

  it("restores the content end on the first frame after the host reports covered", async () => {
    // Arrange — pinned, then the window is completely covered by another app
    // (Page Visibility stays visible; only the host reports it).
    const harness = mountBasic({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });

    await deliverHostOcclusion(true);
    harness.setScrollTop(200);
    harness.setScrollHeight(1500);
    // Act — the window is uncovered.
    await deliverHostOcclusion(false);

    // Assert — the covered exit is a restore boundary (no visibilitychange).
    expect(harness.scrollTop()).toBe(1100);
    expect(harness.result.current.isPinnedRef.current).toBe(true);
  });

  it("holds the escaped anchor when the host reports the window was covered", async () => {
    // Arrange — escaped, reading history.
    const harness = mountAnchor({ scrollTop: 200, aboveHeight: 200, scrollHeight: 1000 });
    act(() => {
      harness.result.current.controller.escape("test:locate");
      harness.result.current.controller.restoreLayout();
    });

    await deliverHostOcclusion(true);
    // A block above the anchor reflows while the window is covered.
    harness.setAboveHeight(300);
    harness.setScrollHeight(1600);
    // Act — the window is uncovered.
    await deliverHostOcclusion(false);

    // Assert — the covered exit holds the anchor (+100px), not the content end.
    expect(harness.scrollTop()).toBe(300);
    expect(harness.result.current.escapedRef.current).toBe(true);
  });

  it("ignores a malformed host occlusion payload", async () => {
    // Arrange — an untrusted cross-process payload must not change the state.
    const harness = mountBasic({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.setScrollTop(200);
    harness.setScrollHeight(1500);

    // Act
    await deliverHostOcclusion("nonsense" as unknown as boolean);

    // Assert — no restore, the state is kept.
    expect(harness.scrollTop()).toBe(200);
  });
});


describe("useChatViewportController scrolling flag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ControlledResizeObserver.reset();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    cleanup();
    ControlledResizeObserver.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mountHarness(initial: { scrollTop: number; scrollHeight: number }) {
    let scrollTop = initial.scrollTop;
    let scrollHeight = initial.scrollHeight;
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });

    const { result, rerender, unmount } = renderHook(
      ({ keyName }) => useChatViewportController({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => {
      vi.advanceTimersByTime(40);
      viewport.dispatchEvent(new Event("scroll"));
    });

    return {
      viewport,
      result: result as { current: UseChatViewportControllerResult },
      unmount,
      setScrollTop: (value: number) => {
        scrollTop = value;
      },
      setScrollHeight: (value: number) => {
        scrollHeight = value;
      },
    };
  }

  it("flags the scroller on a wheel gesture and clears it once scrolling stops", () => {
    // Arrange
    const harness = mountHarness({ scrollTop: 600, scrollHeight: 1000 });

    // Act — a wheel gesture flags immediately.
    act(() => {
      harness.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });

    // Assert
    expect(harness.viewport.dataset.scrolling).toBe("1");

    // Act — still inside the idle window, then past it.
    act(() => {
      vi.advanceTimersByTime(219);
    });
    expect(harness.viewport.dataset.scrolling).toBe("1");
    act(() => {
      vi.advanceTimersByTime(2);
    });

    // Assert — cleared without any further activity.
    expect(harness.viewport.dataset.scrolling).toBeUndefined();
  });

  it("flags the scroller on a keyboard scroll", () => {
    // Arrange
    const harness = mountHarness({ scrollTop: 600, scrollHeight: 1000 });

    // Act
    act(() => {
      harness.viewport.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp" }),
      );
    });

    // Assert
    expect(harness.viewport.dataset.scrolling).toBe("1");
    act(() => {
      vi.advanceTimersByTime(220 + 1);
    });
    expect(harness.viewport.dataset.scrolling).toBeUndefined();
  });

  it("does not flag the scroller on the controller's own follow write", () => {
    // Arrange
    const harness = mountHarness({ scrollTop: 600, scrollHeight: 1000 });

    // Act — the pin follow writes the content end; its synthetic scroll event
    // must not be read as the user scrolling.
    act(() => {
      harness.result.current.scrollToBottom("instant");
      harness.setScrollTop(600);
      harness.viewport.dispatchEvent(new Event("scroll"));
    });

    // Assert
    expect(harness.viewport.dataset.scrolling).toBeUndefined();
  });

  it("clears the flag and its timer when unmounted mid-scroll", () => {
    // Arrange
    const harness = mountHarness({ scrollTop: 600, scrollHeight: 1000 });
    act(() => {
      harness.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    expect(harness.viewport.dataset.scrolling).toBe("1");

    // Act
    act(() => {
      harness.unmount();
    });

    // Assert — dropped synchronously, not left to the pending timer.
    expect(harness.viewport.dataset.scrolling).toBeUndefined();
  });
});
