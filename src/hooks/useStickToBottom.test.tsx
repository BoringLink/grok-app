// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STICK_BOTTOM_REBOUND_SETTLE_MS } from "@/lib/stickToBottom";
import { useStickToBottom } from "./useStickToBottom";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("useStickToBottom bottom rebound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  });

  afterEach(() => {
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
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
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
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
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

  it("escapes on a sub-10px upward wheel so stream follow cannot yank back", () => {
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
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));
    scrollTop = 600;

    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -3 }));
    });

    expect(result.current.isPinnedRef.current).toBe(false);
    expect(scrollTop).toBe(600);
  });
});

describe("useStickToBottom paint-time clamp guard (#1257)", () => {
  beforeEach(() => {
    // Guard runs on rAF and performance.now — neither is faked by default.
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
      ],
    });
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function buildViewport(scrollHeight: number, clientHeight: number) {
    const state = { scrollTop: 9460 };
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => state.scrollTop,
        set: (value: number) => {
          state.scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
      clientWidth: { configurable: true, get: () => 800 },
    });
    return { viewport, state };
  }

  it("restores scrollTop before paint after a browser clamp with no JS writer", () => {
    // #1257 forensics: pinned at 9460, scrollHeight collapse clamps to 8182.
    const { viewport, state } = buildViewport(10307, 847);
    const { result, rerender } = renderHook(
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: viewport.firstElementChild });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));

    // Browser clamp: scrollTop drops with no JS writer and no scroll event.
    state.scrollTop = 8182;
    act(() => vi.advanceTimersByTime(300));

    expect(state.scrollTop).toBe(10307 - 847);
    expect(result.current.isPinnedRef.current).toBe(true);
  });

  it("waits out the input-quiet window after a fresh gesture", () => {
    const { viewport, state } = buildViewport(10307, 847);
    const { result, rerender } = renderHook(
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: viewport.firstElementChild });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));

    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 50 }));
    });
    state.scrollTop = 8182;
    act(() => vi.advanceTimersByTime(100));
    expect(state.scrollTop).toBe(8182);

    act(() => vi.advanceTimersByTime(300));
    expect(state.scrollTop).toBe(10307 - 847);
  });

  it("never writes once an upward wheel escaped the pin", () => {
    const { viewport, state } = buildViewport(10307, 847);
    const { result, rerender } = renderHook(
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: viewport.firstElementChild });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));

    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
    });
    state.scrollTop = 8182;
    act(() => vi.advanceTimersByTime(1000));

    expect(state.scrollTop).toBe(8182);
    expect(result.current.isPinnedRef.current).toBe(false);
  });
});

describe("useStickToBottom sustained streaming follow (#1257)", () => {
  let roCallbacks: ResizeObserverCallback[] = [];
  class CapturingResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      roCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  beforeEach(() => {
    // rAF drives the coalesced measure pass — fake it like production frames.
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    roCallbacks = [];
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("follows immediately when growth keeps arriving inside the coalesce window", () => {
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    viewport.appendChild(content);
    let scrollTop = 400;
    let viewportScrollHeight = 1000;
    let contentHeight = 1000;
    Object.defineProperties(viewport, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => viewportScrollHeight },
      clientHeight: { configurable: true, get: () => 600 },
      clientWidth: { configurable: true, get: () => 800 },
    });
    Object.defineProperty(content, "offsetHeight", {
      configurable: true,
      get: () => contentHeight,
    });

    const { result, rerender } = renderHook(
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));

    // +50px: above noise, under the 64px clamp-recover fast path → arms the
    // 64ms coalesce window instead of following synchronously.
    viewportScrollHeight = 1050;
    contentHeight = 1050;
    act(() => {
      for (const cb of roCallbacks) {
        cb(
          [{ target: content } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
      vi.advanceTimersByTime(30);
    });
    // Sub-noise-window growth clamps to the new max through the stream-drift
    // branch (every layer of the follow chain stays live while pinned).
    expect(scrollTop).toBe(450);

    // …and the next chunk lands inside it: sustained streaming → follow now,
    // never reset the timer forever (the "only lands after the turn ends" bug).
    viewportScrollHeight = 1100;
    contentHeight = 1100;
    act(() => {
      for (const cb of roCallbacks) {
        cb(
          [{ target: content } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
      vi.advanceTimersByTime(20);
    });
    expect(scrollTop).toBe(500);
    expect(result.current.isPinnedRef.current).toBe(true);
  });
});

describe("useStickToBottom nested scroll chaining", () => {
  type BoxState = {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  };

  function makeBox(state: BoxState): HTMLDivElement {
    const el = document.createElement("div");
    el.style.overflowY = "auto";
    Object.defineProperties(el, {
      scrollTop: {
        configurable: true,
        get: () => state.scrollTop,
        set: (value: number) => {
          state.scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, get: () => state.scrollHeight },
      clientHeight: { configurable: true, get: () => state.clientHeight },
      clientWidth: { configurable: true, get: () => 800 },
    });
    return el;
  }

  function mountTranscript() {
    const viewportState: BoxState = {
      scrollTop: 1600,
      scrollHeight: 2000,
      clientHeight: 400,
    };
    const viewport = makeBox(viewportState);
    const content = document.createElement("div");
    viewport.appendChild(content);
    document.body.appendChild(viewport);

    const { result, rerender } = renderHook(
      ({ keyName }) => useStickToBottom({ conversationKey: keyName }),
      { initialProps: { keyName: "before-attach" } },
    );
    Object.assign(result.current.viewportRef, { current: viewport });
    Object.assign(result.current.contentRef, { current: content });
    rerender({ keyName: "attached" });
    act(() => vi.advanceTimersByTime(40));
    viewportState.scrollTop = 1600;
    return { result, content, viewport, viewportState };
  }

  function wheel(
    target: Element,
    deltaY: number,
    init?: WheelEventInit,
  ): WheelEvent {
    const event = new WheelEvent("wheel", {
      deltaY,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lets a nested box with room scroll down while the transcript is pinned", () => {
    const { result, content, viewportState } = mountTranscript();
    const nestedState: BoxState = {
      scrollTop: 100,
      scrollHeight: 800,
      clientHeight: 200,
    };
    const nested = makeBox(nestedState);
    content.appendChild(nested);

    const event = wheel(nested, 40);

    expect(event.defaultPrevented).toBe(false);
    expect(viewportState.scrollTop).toBe(1600);
    expect(nestedState.scrollTop).toBe(100);
    expect(result.current.isPinnedRef.current).toBe(true);
  });

  it("carries an upward wheel from the nested top edge into the transcript", () => {
    const { result, content, viewportState } = mountTranscript();
    const nested = makeBox({
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
    });
    content.appendChild(nested);

    const event = wheel(nested, -40);

    expect(event.defaultPrevented).toBe(true);
    expect(viewportState.scrollTop).toBe(1560);
    expect(result.current.isPinnedRef.current).toBe(false);
  });

  it("carries a downward wheel from the nested bottom edge into the transcript", () => {
    const { content, viewportState } = mountTranscript();
    viewportState.scrollTop = 800;
    const nested = makeBox({
      scrollTop: 600,
      scrollHeight: 800,
      clientHeight: 200,
    });
    content.appendChild(nested);

    const event = wheel(nested, 40);

    expect(event.defaultPrevented).toBe(true);
    expect(viewportState.scrollTop).toBe(840);
  });

  it("hands the tick to the next nested box before the transcript", () => {
    const { content, viewportState } = mountTranscript();
    const outerState: BoxState = {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
    };
    const outer = makeBox(outerState);
    content.appendChild(outer);
    const inner = makeBox({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 200,
    });
    outer.appendChild(inner);

    const event = wheel(inner, -40);

    expect(event.defaultPrevented).toBe(true);
    expect(outerState.scrollTop).toBe(160);
    expect(viewportState.scrollTop).toBe(1600);
  });

  it("keeps scrolling the nested box when data-scrolling changes the target", () => {
    const { content, viewport, viewportState } = mountTranscript();
    const nestedState: BoxState = {
      scrollTop: 100,
      scrollHeight: 800,
      clientHeight: 200,
    };
    const nested = makeBox(nestedState);
    Object.defineProperty(nested, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 200, bottom: 200 }),
    });
    content.appendChild(nested);

    wheel(nested, -20);
    const second = wheel(viewport, -20, { clientX: 50, clientY: 50 });

    expect(second.defaultPrevented).toBe(true);
    expect(nestedState.scrollTop).toBe(80);
    expect(viewportState.scrollTop).toBe(1600);
  });

  it("chains from the edge after data-scrolling changes the target", () => {
    const { content, viewport, viewportState } = mountTranscript();
    const nested = makeBox({
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
    });
    Object.defineProperty(nested, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 200, bottom: 200 }),
    });
    content.appendChild(nested);

    wheel(nested, -40);
    const second = wheel(viewport, -40, { clientX: 50, clientY: 50 });

    expect(second.defaultPrevented).toBe(true);
    expect(viewportState.scrollTop).toBe(1520);
  });

  it("ignores horizontal-dominant gestures", () => {
    const { result, viewport } = mountTranscript();
    const event = wheel(viewport, -5, { deltaX: 40 });
    expect(event.defaultPrevented).toBe(false);
    expect(result.current.isPinnedRef.current).toBe(true);
  });

  it("leaves a non-cancelable wheel to the browser", () => {
    const { content, viewportState } = mountTranscript();
    const nested = makeBox({
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
    });
    content.appendChild(nested);
    const event = new WheelEvent("wheel", {
      deltaY: -40,
      bubbles: true,
      cancelable: false,
    });
    act(() => {
      nested.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(viewportState.scrollTop).toBe(1600);
  });

  it("drops the gesture memory after the idle window", () => {
    const { content, viewport, viewportState } = mountTranscript();
    const nested = makeBox({
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
    });
    Object.defineProperty(nested, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 200, bottom: 200 }),
    });
    content.appendChild(nested);

    wheel(nested, -40);
    act(() => vi.advanceTimersByTime(300));
    viewportState.scrollTop = 1500;
    const afterIdle = wheel(viewport, -40, { clientX: 50, clientY: 50 });

    expect(afterIdle.defaultPrevented).toBe(false);
    expect(viewportState.scrollTop).toBe(1500);
  });

  it("forgets the nested box once the pointer leaves it", () => {
    const { content, viewport, viewportState } = mountTranscript();
    const nested = makeBox({
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
    });
    Object.defineProperty(nested, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 200, bottom: 200 }),
    });
    content.appendChild(nested);

    wheel(nested, -40);
    viewportState.scrollTop = 1500;
    const outside = wheel(viewport, -40, { clientX: 500, clientY: 500 });

    expect(outside.defaultPrevented).toBe(false);
    expect(viewportState.scrollTop).toBe(1500);
  });
});
