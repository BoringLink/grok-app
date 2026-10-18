// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STICK_BOTTOM_REBOUND_SETTLE_MS } from "@/lib/stickToBottom";
import { useChatViewportController, type UseChatViewportControllerResult } from "./useChatViewportController";

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

  static emit(target: Element, height: number) {
    const entry = {
      target,
      contentRect: { height, width: 800 },
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
});

/**
 * The controller is the transcript's single writer. Other transcript modules
 * (the virtual list, the rail / find jumps) call this handle instead of
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
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 800 },
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(0, 400),
    });
    Object.defineProperty(content, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(-scrollTop, 1000),
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
      scrollTop: () => scrollTop,
      setAboveHeight: (value: number) => {
        aboveHeight = value;
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
});

