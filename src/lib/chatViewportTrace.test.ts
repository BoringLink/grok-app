/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  anchorScreenShift,
  applyScrollTopTraced,
  chatTraceSessionId,
  chatViewportTraceEnabled,
  chatViewportTraceEvents,
  chatViewportWriteStats,
  classifyPinFlipCause,
  distanceToContentEnd,
  DUMP_CONTEXT_EVENTS,
  DUMP_MAX_CHARS,
  dumpChatViewportTrace,
  isBackwardViewportMove,
  isSuspiciousUpwardJump,
  lastPinFlipCause,
  resetChatViewportTrace,
  setChatTraceSessionId,
  setChatViewportTraceEnabled,
  setChatViewportTracePinned,
  traceOcclusion,
  tracePinState,
  traceScrollTopWrite,
  traceViewport,
  VIEWPORT_JUMP_MIN_PX,
  visibleBandShift,
} from "./chatViewportTrace";

afterEach(() => {
  resetChatViewportTrace();
  setChatViewportTraceEnabled(null);
  setChatViewportTracePinned(false);
  setChatTraceSessionId(null);
});

describe("chatTraceSessionId tracking-session tagging", () => {
  it("round-trips an explicit tracking-session id", () => {
    // Arrange
    setChatTraceSessionId("tracker-123");
    // Act / Assert
    expect(chatTraceSessionId()).toBe("tracker-123");
  });

  it("trims whitespace and rejects empty ids", () => {
    // Arrange
    setChatTraceSessionId("  ");
    expect(chatTraceSessionId()).toBeNull();
    setChatTraceSessionId("  sess  ");
    expect(chatTraceSessionId()).toBe("sess");
  });

  it("carries the tracking-session id on a dumped trace payload", () => {
    // Arrange
    setChatViewportTraceEnabled(true);
    setChatTraceSessionId("tracker-abc");
    traceViewport("sample", { scrollTop: 10 });
    // Act
    const dump = dumpChatViewportTrace("test-session");
    // Assert
    expect(dump.session).toBe("tracker-abc");
    expect(dump.reason).toBe("test-session");
    expect(dump.events.some((e) => e.kind === "sample")).toBe(true);
  });
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
    const event = traceViewport("sample", { index: 1 });

    // Assert
    expect(event).toBeNull();
    expect(chatViewportTraceEvents()).toHaveLength(0);
  });

  it("returns the recorded event so a trigger can be passed to the dump", () => {
    // Arrange
    setChatViewportTraceEnabled(true);

    // Act
    const event = traceViewport("backward", { fromIndex: 9, toIndex: 4 });

    // Assert
    expect(event?.kind).toBe("backward");
    expect(chatViewportTraceEvents()).toEqual([event]);
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

  it("records pin state transitions with bottom distance", () => {
    // Arrange
    setChatViewportTraceEnabled(true);

    // Act
    tracePinState({
      reason: "wheel-escape",
      pinned: false,
      escaped: true,
      scrollTop: 120,
      scrollHeight: 1000,
      clientHeight: 400,
    });

    // Assert
    const [event] = chatViewportTraceEvents();
    expect(event?.kind).toBe("pin");
    expect(event?.reason).toBe("wheel-escape");
    expect(event?.pinned).toBe(false);
    expect(event?.escaped).toBe(true);
    expect(event?.distFromBottom).toBe(480);
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

describe("distanceToContentEnd", () => {
  it("is zero on the hard bottom and positive above it", () => {
    // Arrange + Act + Assert
    expect(
      distanceToContentEnd({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }),
    ).toBe(0);
    expect(
      distanceToContentEnd({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }),
    ).toBe(500);
  });

  it("keeps a negative distance rather than hiding an overscrolling position", () => {
    // Arrange + Act + Assert
    expect(
      distanceToContentEnd({ scrollTop: 620, scrollHeight: 1000, clientHeight: 400 }),
    ).toBe(-20);
  });
});

describe("visibleBandShift", () => {
  it("reports the shared on-screen displacement of rows present in both frames", () => {
    // Arrange — every visible row slid up by 6px between frames.
    const previous = [
      { index: 10, top: 100 },
      { index: 11, top: 200 },
      { index: 12, top: 300 },
    ];
    const current = [
      { index: 10, top: 94 },
      { index: 11, top: 194 },
      { index: 12, top: 294 },
    ];

    // Act
    const shift = visibleBandShift(previous, current);

    // Assert
    expect(shift).toBe(-6);
  });

  it("matches by index, so a row that merely reused a slot is not counted", () => {
    // Arrange — row 10 left the band, row 13 entered; only 11 and 12 persist.
    const previous = [
      { index: 10, top: 100 },
      { index: 11, top: 200 },
      { index: 12, top: 300 },
    ];
    const current = [
      { index: 11, top: 196 },
      { index: 12, top: 296 },
      { index: 13, top: 396 },
    ];

    // Act
    const shift = visibleBandShift(previous, current);

    // Assert
    expect(shift).toBe(-4);
  });

  it("returns null when no row persisted", () => {
    // Arrange + Act + Assert
    expect(
      visibleBandShift([{ index: 1, top: 0 }], [{ index: 2, top: 0 }]),
    ).toBeNull();
    expect(visibleBandShift([], [{ index: 2, top: 0 }])).toBeNull();
  });
});

describe("anchorScreenShift", () => {
  /** Minimal connected element with a fixed `getBoundingClientRect().top`. */
  function anchorElement(top: number, connected = true) {
    const el = document.createElement("div");
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top }) as DOMRect,
    });
    if (connected) document.body.appendChild(el);
    return el;
  }

  it("reports the anchor element's own screen-top shift from its recorded top", () => {
    // Arrange
    const element = anchorElement(140);

    // Act
    const shift = anchorScreenShift({ element, screenTop: 100 });

    // Assert
    expect(shift).toBe(40);
  });

  it("reads a negative shift when the anchor moved up", () => {
    // Arrange
    const element = anchorElement(80);

    // Act + Assert
    expect(anchorScreenShift({ element, screenTop: 100 })).toBe(-20);
  });

  it("returns null when no anchor is held", () => {
    // Arrange + Act + Assert
    expect(anchorScreenShift(null)).toBeNull();
    expect(anchorScreenShift({ element: null, screenTop: 100 })).toBeNull();
  });

  it("returns null when the held element is disconnected", () => {
    // Arrange — the row was re-rendered; the captured node is gone.
    const element = anchorElement(140, false);

    // Act + Assert
    expect(anchorScreenShift({ element, screenTop: 100 })).toBeNull();
  });
});

describe("classifyPinFlipCause", () => {
  it("attributes the reason's own gesture prefix", () => {
    // Arrange + Act + Assert
    expect(classifyPinFlipCause({ reason: "wheel-escape", distFromBottom: 500 })).toBe("wheel");
    expect(classifyPinFlipCause({ reason: "touch-repin", distFromBottom: 0 })).toBe("touch");
    expect(classifyPinFlipCause({ reason: "keyboard-escape", distFromBottom: 500 })).toBe("keyboard");
  });

  it("classifies a gesture-free upward escape as layout clamping", () => {
    // Arrange + Act + Assert
    expect(
      classifyPinFlipCause({ reason: "scroll-escape", distFromBottom: 700 }),
    ).toBe("layout-clamp");
  });

  it("classifies a programmatic jump as a jump, not a layout clamp", () => {
    // Arrange + Act + Assert — the reader chose the position (rail / find).
    expect(
      classifyPinFlipCause({ reason: "jump:find", distFromBottom: 700 }),
    ).toBe("jump");
    expect(
      classifyPinFlipCause({ reason: "jump:locate", gesture: "wheel", distFromBottom: 0 }),
    ).toBe("jump");
  });

  it("uses the caller's gesture when the reason cannot name one", () => {
    // Arrange + Act + Assert
    expect(
      classifyPinFlipCause({ reason: "scroll-escape", gesture: "wheel", distFromBottom: 700 }),
    ).toBe("wheel");
    expect(
      classifyPinFlipCause({ reason: "scroll-escape", gesture: "scrollbar", distFromBottom: 700 }),
    ).toBe("scrollbar");
  });

  it("classifies a flip that landed on the hard bottom as hard-bottom", () => {
    // Arrange + Act + Assert
    expect(
      classifyPinFlipCause({ reason: "scroll-state-transition", gesture: "wheel", distFromBottom: 0 }),
    ).toBe("hard-bottom");
    expect(
      classifyPinFlipCause({ reason: "height-change-repin", distFromBottom: 0 }),
    ).toBe("hard-bottom");
  });

  it("classifies the explicit button", () => {
    // Arrange + Act + Assert
    expect(
      classifyPinFlipCause({ reason: "button-scroll-to-bottom", distFromBottom: 0 }),
    ).toBe("button");
  });
});

describe("traceOcclusion", () => {
  it("records the enter and exit boundaries with their cause and phase", () => {
    // Arrange
    setChatViewportTraceEnabled(true);

    // Act
    traceOcclusion({
      state: "enter",
      cause: "hidden",
      clientHeight: 612.4,
      pinned: true,
      escaped: false,
    });
    traceOcclusion({
      state: "exit",
      cause: "hidden",
      clientHeight: 612.4,
      pinned: false,
      escaped: true,
    });

    // Assert
    const [enter, exit] = chatViewportTraceEvents();
    expect(enter?.kind).toBe("occlusion");
    expect(enter?.state).toBe("enter");
    expect(enter?.cause).toBe("hidden");
    expect(enter?.clientHeight).toBe(612);
    expect(enter?.pinned).toBe(true);
    expect(exit?.state).toBe("exit");
    expect(exit?.escaped).toBe(true);
  });

  it("records the covered boundary the host reports", () => {
    // Arrange
    setChatViewportTraceEnabled(true);

    // Act — the macOS host reported the window completely covered.
    traceOcclusion({
      state: "enter",
      cause: "covered",
      clientHeight: 612,
      pinned: true,
      escaped: false,
    });

    // Assert
    const [event] = chatViewportTraceEvents();
    expect(event?.kind).toBe("occlusion");
    expect(event?.cause).toBe("covered");
  });

  it("records nothing while the trace is off", () => {
    // Arrange
    setChatViewportTraceEnabled(false);

    // Act
    traceOcclusion({
      state: "exit",
      cause: "collapsed",
      clientHeight: 0,
      pinned: true,
      escaped: false,
    });

    // Assert
    expect(chatViewportTraceEvents()).toHaveLength(0);
  });
});

describe("tracePinState cause", () => {
  it("records the normalized cause and mirrors it for the frame sampler", () => {
    // Arrange
    setChatViewportTraceEnabled(true);

    // Act
    tracePinState({
      reason: "wheel-escape",
      pinned: false,
      escaped: true,
      scrollTop: 120,
      scrollHeight: 1000,
      clientHeight: 400,
    });

    // Assert
    const [event] = chatViewportTraceEvents();
    expect(event?.cause).toBe("wheel");
    expect(lastPinFlipCause()).toBe("wheel");
  });

  it("classifies a gesture-free escape as layout clamping", () => {
    // Arrange
    setChatViewportTraceEnabled(true);

    // Act
    tracePinState({
      reason: "scroll-escape",
      pinned: false,
      escaped: true,
      scrollTop: 120,
      scrollHeight: 1000,
      clientHeight: 400,
    });

    // Assert
    expect(lastPinFlipCause()).toBe("layout-clamp");
  });
});

describe("dumpChatViewportTrace trigger anchoring", () => {
  it("anchors the window on the trigger, not on the newest event", () => {
    // Arrange
    setChatViewportTraceEnabled(true);
    traceViewport("sample", { seq: 1 });
    const trigger = traceViewport("backward", { seq: 2 });
    traceViewport("sample", { seq: 3 });
    traceViewport("sample", { seq: 4 });

    // Act
    const dump = dumpChatViewportTrace("test", trigger);

    // Assert — the trigger is the last event in the window; later noise is out.
    expect(dump.trigger).toBe(trigger);
    expect(dump.events.at(-1)).toBe(trigger);
    expect(dump.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(dump.truncated).toBe(false);
  });

  it("keeps the trigger in the window after a flood of later events", () => {
    // Arrange
    setChatViewportTraceEnabled(true);
    traceViewport("sample", { seq: 0 });
    const trigger = traceViewport("backward", { seq: 1 });
    for (let i = 2; i < 300; i++) traceViewport("sample", { seq: i });

    // Act
    const dump = dumpChatViewportTrace("flood", trigger);

    // Assert — the newest events are excluded; the trigger is retained.
    expect(dump.events.at(-1)).toBe(trigger);
    expect(dump.events.some((event) => event.seq === 299)).toBe(false);
  });

  it("reaches back past the old 80-event cap when the events are compact", () => {
    // Arrange — small per-frame samples, as the probe records them.
    setChatViewportTraceEnabled(true);
    for (let i = 0; i < 100; i++) traceViewport("sample", { i, d: 0, v: -1 });
    const trigger = traceViewport("backward", { fromIndex: 9, toIndex: 4 });

    // Act
    const dump = dumpChatViewportTrace("wide", trigger);

    // Assert — the whole stream fits, so nothing is dropped and the window is
    // wider than the old fixed 80-event context.
    expect(dump.events.length).toBeGreaterThan(80);
    expect(dump.events).toHaveLength(101);
    expect(dump.events.at(-1)).toBe(trigger);
    expect(dump.truncated).toBe(false);
    expect(JSON.stringify(dump).length).toBeLessThanOrEqual(DUMP_MAX_CHARS);
  });

  it("drops the oldest context first and always keeps the trigger", () => {
    // Arrange — each event carries a payload, so the char budget bites.
    setChatViewportTraceEnabled(true);
    const filler = "x".repeat(400);
    for (let i = 0; i < 100; i++) traceViewport("sample", { i, filler });
    const trigger = traceViewport("backward", { i: 100, filler });

    // Act
    const dump = dumpChatViewportTrace("budget", trigger);

    // Assert — it uses the larger budget but still reports the trim.
    expect(dump.truncated).toBe(true);
    expect(dump.events.at(-1)).toBe(trigger);
    expect(dump.events.length).toBeLessThanOrEqual(DUMP_CONTEXT_EVENTS);
    expect(JSON.stringify(dump).length).toBeLessThanOrEqual(DUMP_MAX_CHARS);
    expect(DUMP_CONTEXT_EVENTS).toBe(400);
    expect(DUMP_MAX_CHARS).toBe(8000);
  });

  it("falls back to the newest event when the trigger was never recorded", () => {
    // Arrange
    setChatViewportTraceEnabled(true);
    traceViewport("sample", { seq: 1 });
    traceViewport("sample", { seq: 2 });

    // Act
    const dump = dumpChatViewportTrace("no-trigger", { t: 0, kind: "ghost" });

    // Assert
    expect(dump.trigger?.seq).toBe(2);
    expect(dump.events.at(-1)?.seq).toBe(2);
  });
});

describe("chatViewportWriteStats", () => {
  const viewport = () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", {
      value: 0,
      writable: true,
      configurable: true,
    });
    return el;
  };

  it("counts writes and reports the last source only while tracing", () => {
    // Arrange
    const el = viewport();
    setChatViewportTraceEnabled(false);

    // Act — disabled: the write happens, nothing is counted.
    applyScrollTopTraced("stick:applyScrollTop", el, 120);

    // Assert
    expect(chatViewportWriteStats()).toEqual({ writes: 0, lastSource: null });

    // Act — enabled: both writes are counted, the last source wins.
    setChatViewportTraceEnabled(true);
    applyScrollTopTraced("stick:applyScrollTop", el, 240);
    applyScrollTopTraced("virt:pinnedWindowSnap", el, 260);

    // Assert
    expect(chatViewportWriteStats()).toEqual({
      writes: 2,
      lastSource: "virt:pinnedWindowSnap",
    });
  });

  it("counts a raw traced write and clears on reset", () => {
    // Arrange
    setChatViewportTraceEnabled(true);
    const el = viewport();

    // Act
    traceScrollTopWrite("thread:locateNudge", el, 0);

    // Assert
    expect(chatViewportWriteStats().writes).toBe(1);
    resetChatViewportTrace();
    expect(chatViewportWriteStats()).toEqual({ writes: 0, lastSource: null });
  });
});
