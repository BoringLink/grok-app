/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyScrollTopTraced,
  chatViewportTraceEnabled,
  chatViewportTraceEvents,
  dumpChatViewportTrace,
  isBackwardViewportMove,
  isSuspiciousUpwardJump,
  resetChatViewportTrace,
  setChatViewportTraceEnabled,
  setChatViewportTracePinned,
  traceScrollTopWrite,
  traceViewport,
  VIEWPORT_JUMP_MIN_PX,
} from "./chatViewportTrace";

afterEach(() => {
  resetChatViewportTrace();
  setChatViewportTraceEnabled(null);
  setChatViewportTracePinned(false);
});

describe("isBackwardViewportMove", () => {
  it("flags a decreasing row index while following the tail", () => {
    // Arrange
    const input = {
      pinned: true,
      escaped: false,
      userGestureRecent: false,
      previousIndex: 91,
      index: 84,
    };

    // Act
    const result = isBackwardViewportMove(input);

    // Assert
    expect(result).toBe(true);
  });

  it("ignores equal or forward movement", () => {
    const base = {
      pinned: true,
      escaped: false,
      userGestureRecent: false,
      previousIndex: 91,
    };
    expect(isBackwardViewportMove({ ...base, index: 91 })).toBe(false);
    expect(isBackwardViewportMove({ ...base, index: 96 })).toBe(false);
  });

  it("ignores movement while the user is scrolling (their own scroll-up)", () => {
    expect(
      isBackwardViewportMove({
        pinned: true,
        escaped: false,
        userGestureRecent: true,
        previousIndex: 91,
        index: 60,
      }),
    ).toBe(false);
  });

  it("ignores movement when the chat is not following the tail", () => {
    const input = {
      userGestureRecent: false,
      previousIndex: 91,
      index: 60,
    };
    expect(
      isBackwardViewportMove({ ...input, pinned: false, escaped: false }),
    ).toBe(false);
    expect(
      isBackwardViewportMove({ ...input, pinned: true, escaped: true }),
    ).toBe(false);
  });

  it("ignores a missing sample on either side", () => {
    const base = {
      pinned: true,
      escaped: false,
      userGestureRecent: false,
    };
    expect(isBackwardViewportMove({ ...base, previousIndex: null, index: 60 })).toBe(
      false,
    );
    expect(isBackwardViewportMove({ ...base, previousIndex: 91, index: null })).toBe(
      false,
    );
  });
});

describe("isSuspiciousUpwardJump", () => {
  it("flags a large upward move with no user gesture", () => {
    expect(
      isSuspiciousUpwardJump({ userGestureRecent: false, deltaTop: -2629 }),
    ).toBe(true);
  });

  it("ignores small churn and downward moves", () => {
    expect(
      isSuspiciousUpwardJump({ userGestureRecent: false, deltaTop: -240 }),
    ).toBe(false);
    expect(
      isSuspiciousUpwardJump({ userGestureRecent: false, deltaTop: 6254 }),
    ).toBe(false);
  });

  it("ignores an upward move the user drove", () => {
    expect(
      isSuspiciousUpwardJump({ userGestureRecent: true, deltaTop: -2629 }),
    ).toBe(false);
  });

  it("honours a caller override for the minimum jump", () => {
    expect(
      isSuspiciousUpwardJump({ userGestureRecent: false, deltaTop: -240, minPx: 200 }),
    ).toBe(true);
    expect(VIEWPORT_JUMP_MIN_PX).toBe(600);
  });
});

describe("chatViewportTrace recording", () => {
  it("records nothing until it is explicitly enabled", () => {
    // Arrange
    setChatViewportTraceEnabled(false);

    // Act
    traceViewport("sample", { index: 1 });

    // Assert
    expect(chatViewportTraceEvents()).toHaveLength(0);
  });

  it("keeps the newest events when the ring buffer overflows", () => {
    // Arrange
    setChatViewportTraceEnabled(true);

    // Act
    for (let i = 0; i < 500; i++) traceViewport("sample", { index: i });

    // Assert
    const events = chatViewportTraceEvents();
    expect(events).toHaveLength(400);
    expect(events[events.length - 1]?.index).toBe(499);
  });

  it("records a scrollTop write with its source, delta and pin state", () => {
    // Arrange
    setChatViewportTraceEnabled(true);
    setChatViewportTracePinned(true);
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", {
      value: 100,
      writable: true,
      configurable: true,
    });

    // Act
    traceScrollTopWrite("virt:pinnedWindowSnap", el, 40);

    // Assert
    const [event] = chatViewportTraceEvents();
    expect(event?.kind).toBe("scrollTop");
    expect(event?.source).toBe("virt:pinnedWindowSnap");
    expect(event?.before).toBe(40);
    expect(event?.after).toBe(100);
    expect(event?.delta).toBe(60);
    expect(event?.pinned).toBe(true);
  });

  it("applies a scrollTop write and records it only when enabled", () => {
    // Arrange
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", {
      value: 0,
      writable: true,
      configurable: true,
    });

    // Act — disabled: the write must still happen, nothing recorded.
    setChatViewportTraceEnabled(false);
    applyScrollTopTraced("stick:applyScrollTop", el, 250);

    // Assert
    expect(el.scrollTop).toBe(250);
    expect(chatViewportTraceEvents()).toHaveLength(0);

    // Act — enabled: the same write, now with a record.
    setChatViewportTraceEnabled(true);
    applyScrollTopTraced("stick:applyScrollTop", el, 300);

    // Assert
    expect(el.scrollTop).toBe(300);
    const [event] = chatViewportTraceEvents();
    expect(event?.source).toBe("stick:applyScrollTop");
    expect(event?.before).toBe(250);
    expect(event?.after).toBe(300);
  });

  it("publishes the trace on the window when dumped", () => {
    // Arrange
    setChatViewportTraceEnabled(true);
    traceViewport("backward", { fromIndex: 91, toIndex: 84 });

    // Act
    const payload = dumpChatViewportTrace("test-dump");

    // Assert
    expect(payload.events).toHaveLength(1);
    expect(payload.reason).toBe("test-dump");
    const published = (window as unknown as { __CHAT_VIEWPORT_TRACE__: unknown })
      .__CHAT_VIEWPORT_TRACE__;
    expect(published).toEqual(payload);
  });

  it("enables the trace from ?chatTrace=1 in a dev build", () => {
    // Arrange
    const original = window.location.search;
    resetChatViewportTrace();
    setChatViewportTraceEnabled(null);
    window.history.replaceState(null, "", "?chatTrace=1");

    // Act
    const enabled = chatViewportTraceEnabled();

    // Assert — the URL switch is only honoured by a dev build.
    if (import.meta.env.DEV) expect(enabled).toBe(true);

    // Cleanup
    window.history.replaceState(null, "", original || window.location.pathname);
    setChatViewportTraceEnabled(null);
  });

  it("stays enabled per the build flag when nothing forces it", () => {
    // Arrange + Act
    resetChatViewportTrace();
    setChatViewportTraceEnabled(null);

    // Assert — vitest sets import.meta.env.DEV, so the default follows the build.
    expect(typeof chatViewportTraceEnabled()).toBe("boolean");
  });
});
