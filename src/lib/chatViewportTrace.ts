/* eslint-disable no-console -- dev-only viewport trace; the printed report is
 * the feature, not a leftover debug print. Mirrors scrollPerfDebug's contract. */
/**
 * DEV-only diagnostic trace for the chat viewport ("the chat jumps back to an
 * earlier message").
 *
 * Why this exists: the stuck-to-bottom geometry in
 * `useChatMessageVirtualizer` + `useStickToBottom` re-asserts the bottom on
 * every window commit, so the backward jump cannot be explained by the window
 * math alone. To find the cause we need, from the running app, three things
 * that no unit test can supply:
 *
 * 1. every `scrollTop` write with its source (and stack) — who moved the view;
 * 2. the pin/escape state at that moment — was the view even following;
 * 3. the message index sitting at the top of the viewport before/after, so a
 *    "the viewport now shows older content" event is detected, not guessed.
 *
 * Off by default. Enable with `localStorage["grok.chatTrace"] = "1"` (or
 * `?chatTrace=1`) in a dev build, reproduce, then read
 * `window.__CHAT_VIEWPORT_TRACE__`.
 */

export type ViewportTraceEvent = {
  /** `performance.now()` at record time (ms). */
  t: number;
  kind: string;
  [key: string]: unknown;
};

const MAX_EVENTS = 400;

let enabledCache: boolean | null = null;
let events: ViewportTraceEvent[] = [];
let dumps = 0;
/**
 * Stick state mirrored for trace payloads. Kept as a module global on purpose:
 * the write sites live in hooks that must not re-render when a diagnostic flag
 * changes.
 */
let pinned = false;
/**
 * Cause of the most recent pin/escape flip, mirrored for the frame sampler:
 * a flip the sampler detects from `pinned` alone is attributed to the cause
 * the authoritative flip (in `useStickToBottom`) recorded.
 */
let recentPinFlipCause: PinFlipCause | null = null;
/**
 * Optional tracking-session id. When set, every line the Host appends to
 * `logs/app.log.<day>` is prefixed `[session=<id>]` so an external session can
 * `tail -F` that log and filter a reproduction by its id. Read from
 * `localStorage["grok.chatTraceSession"]` or `?chatTraceSession=` at runtime —
 * no rebuild is needed to switch which session is being tracked.
 */
let sessionCache: string | null | undefined; // undefined = not resolved yet

/** The tracking-session id this build/runtime should tag its trace lines with. */
export function chatTraceSessionId(): string | null {
  if (sessionCache !== undefined) return sessionCache;
  let id: string | null = null;
  try {
    const fromQuery =
      typeof location !== "undefined"
        ? new URLSearchParams(location.search).get("chatTraceSession")
        : null;
    const fromStorage =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("grok.chatTraceSession")
        : null;
    const raw = fromQuery ?? fromStorage;
    id = raw && raw.trim().length > 0 ? raw.trim() : null;
  } catch {
    id = null;
  }
  sessionCache = id;
  return id;
}

/** Test seam / programmatic override for the tracking-session id. */
export function setChatTraceSessionId(next: string | null): void {
  sessionCache = next == null ? null : next.trim().length > 0 ? next.trim() : null;
}

/** True when the trace is explicitly enabled in a dev build. */
export function chatViewportTraceEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  let enabled = false;
  if (import.meta.env.DEV) {
    try {
      enabled =
        // `VITE_CHAT_TRACE=1` at dev-server start: no devtools needed, and the
        // launch command carries the intent for an isolated instance.
        String(import.meta.env.VITE_CHAT_TRACE ?? "") === "1" ||
        (typeof localStorage !== "undefined" &&
          localStorage.getItem("grok.chatTrace") === "1") ||
        (typeof location !== "undefined" &&
          new URLSearchParams(location.search).get("chatTrace") === "1");
    } catch {
      enabled = false;
    }
  }
  enabledCache = enabled;
  return enabled;
}

/** Test seam: force enable/disable without a build flag. */
export function setChatViewportTraceEnabled(next: boolean | null): void {
  enabledCache = next;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Append one event. No-op unless {@link chatViewportTraceEnabled}.
 *
 * Returns the recorded event so a caller that just recorded a *trigger* (a
 * backward move, an upward jump) can hand it to {@link dumpChatViewportTrace}
 * and have the dump anchored on it instead of on whatever the newest event
 * happens to be. Returns null when tracing is off.
 */
export function traceViewport(
  kind: string,
  data: Record<string, unknown>,
): ViewportTraceEvent | null {
  if (!chatViewportTraceEnabled()) return null;
  const event: ViewportTraceEvent = {
    t: Math.round(now() * 100) / 100,
    kind,
    ...data,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  return event;
}

/**
 * Record a `scrollTop` assignment. `before` must be read before the write.
 *
 * The stack is the point: three modules write this scroller
 * (`useChatMessageVirtualizer`, `useStickToBottom`, and any future caller), and
 * a stray write is invisible in the geometry afterwards.
 */
export function traceScrollTopWrite(
  source: string,
  el: HTMLElement,
  before: number,
): void {
  if (!chatViewportTraceEnabled()) return;
  const after = el.scrollTop;
  const stack =
    typeof Error !== "undefined" && typeof Error().stack === "string"
      ? (Error().stack as string)
          .split("\n")
          .slice(1, 6)
          .map((line) => line.trim().replace(/^at /, ""))
          .join(" <- ")
      : "";
  traceViewport("scrollTop", {
    source,
    before: Math.round(before * 100) / 100,
    after: Math.round(after * 100) / 100,
    delta: Math.round((after - before) * 100) / 100,
    pinned,
    stack,
  });
}

/**
 * Assign `el.scrollTop` and record the write when tracing is enabled.
 *
 * The disabled path must stay a single boolean check plus the assignment: the
 * call sites sit in ResizeObserver and scroll hot paths, where an extra
 * `scrollTop` read is a forced layout flush.
 */
export function applyScrollTopTraced(
  source: string,
  el: HTMLElement,
  top: number,
): void {
  if (!chatViewportTraceEnabled()) {
    el.scrollTop = top;
    return;
  }
  // Record the delta after the write: `traceScrollTopWrite` reads both sides.
  const before = el.scrollTop;
  el.scrollTop = top;
  traceScrollTopWrite(source, el, before);
}

/** Pin/escape transitions, so a trace can tell "following" from "parked". */
export function tracePinState(input: {
  reason: string;
  pinned: boolean;
  escaped: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Gesture the flip is attributed to when the reason cannot name one. */
  gesture?: PinFlipGesture;
}): void {
  const distFromBottom = distanceToContentEnd(input);
  const cause = classifyPinFlipCause({
    reason: input.reason,
    gesture: input.gesture,
    distFromBottom,
  });
  recentPinFlipCause = cause;
  traceViewport("pin", {
    reason: input.reason,
    cause,
    pinned: input.pinned,
    escaped: input.escaped,
    distFromBottom: Math.round(distFromBottom),
  });
  // Natural scroll-to-bottom: the user landed back on the tail and the stick
  // hook re-engaged follow (wheel/touch/scroll / bottom-rebound / height-change
  // all funnel through this point). Surface it to a tracking session so the
  // follower sees exactly when follow re-arns while a repro is running.
  if (input.pinned && !input.escaped && chatTraceSessionId()) {
    void publishTraceToHost({
      reason: "landed-bottom",
      cause: input.reason,
      scrollTop: Math.round(input.scrollTop),
      scrollHeight: Math.round(input.scrollHeight),
      clientHeight: Math.round(input.clientHeight),
      distFromBottom: Math.round(distFromBottom),
    });
  }
}

/**
 * Would this sample count as "the viewport moved to an OLDER message"?
 *
 * Deliberately narrow so the trace is not flooded: the view must be following
 * (pinned, not escaped), the index must decrease, and no user gesture may be
 * recent — a real scroll-up is the user's business, not a bug.
 */
export function isBackwardViewportMove(input: {
  pinned: boolean;
  escaped: boolean;
  userGestureRecent: boolean;
  previousIndex: number | null;
  index: number | null;
}): boolean {
  if (!input.pinned || input.escaped) return false;
  if (input.userGestureRecent) return false;
  if (input.previousIndex == null || input.index == null) return false;
  return input.index < input.previousIndex;
}

/**
 * Events kept *before* the trigger in a dump. The trigger is the cause chain's
 * end, so the events that led up to it are the ones worth keeping; later noise
 * is not.
 */
export const DUMP_CONTEXT_EVENTS = 80;
/**
 * Serialized-size budget for one dump, under the host's
 * `MAX_TRACE_LINE_CHARS = 8192`. The host truncates an over-long line keeping
 * its head, so a dump that overflows would lose the trigger (the last event) —
 * staying under the cap is what guarantees the trigger is not dropped.
 */
export const DUMP_MAX_CHARS = 6000;

export type ChatViewportDump = {
  reason: string;
  dumps: number;
  session: string | null;
  /** The event the dump is anchored on, or null when no event was recorded. */
  trigger: ViewportTraceEvent | null;
  /** True when earlier context was dropped to stay inside the size budget. */
  truncated: boolean;
  events: ViewportTraceEvent[];
};

/**
 * Publish the collected trace and return it.
 *
 * The window is anchored on `trigger` (the latest event when none is given):
 * it contains the trigger plus up to {@link DUMP_CONTEXT_EVENTS} events
 * immediately before it, trimmed further to fit {@link DUMP_MAX_CHARS}. This
 * replaces keeping the newest events wholesale, where an over-long line was
 * truncated by the host back to its oldest events and the trigger was lost.
 * The trigger itself is always included, even when it alone exceeds the budget.
 */
export function dumpChatViewportTrace(
  reason: string,
  trigger: ViewportTraceEvent | null = null,
): ChatViewportDump {
  const anchorIndex =
    trigger != null ? events.lastIndexOf(trigger) : events.length - 1;
  const hasEvents = events.length > 0;
  const resolvedAnchor = !hasEvents
    ? -1
    : anchorIndex >= 0
      ? anchorIndex
      : events.length - 1;
  const base = { reason, dumps: dumps + 1, session: chatTraceSessionId() };
  const baseChars = JSON.stringify({
    ...base,
    trigger: null,
    truncated: false,
    events: [],
  }).length;

  const triggerEvent = hasEvents ? events[resolvedAnchor] : null;
  // The payload serializes the trigger both as `trigger` and as the last
  // `events` entry, so its size is reserved before the context budget is spent.
  const triggerChars = triggerEvent == null ? 4 : JSON.stringify(triggerEvent).length + 1;

  const buffer: ViewportTraceEvent[] = [];
  let budget = DUMP_MAX_CHARS - baseChars - triggerChars;
  let truncated = false;
  for (let i = resolvedAnchor; i >= 0; i -= 1) {
    const event = events[i];
    const cost = JSON.stringify(event).length + 1;
    if (
      buffer.length > 0 &&
      (buffer.length >= DUMP_CONTEXT_EVENTS || budget - cost < 0)
    ) {
      truncated = true;
      break;
    }
    budget -= cost;
    buffer.unshift(event);
  }

  const payload: ChatViewportDump = {
    ...base,
    trigger: triggerEvent,
    truncated,
    events: buffer,
  };
  if (!chatViewportTraceEnabled()) return payload;
  dumps += 1;
  if (typeof window === "undefined") return payload;
  (window as unknown as { __CHAT_VIEWPORT_TRACE__: unknown })
    .__CHAT_VIEWPORT_TRACE__ = payload;
  const pinnedWrites = payload.events.filter((e) => e.kind === "scrollTop");
  const backward = payload.events.filter((e) => e.kind === "backward");
  console.warn(
    `[chatTrace] ${reason} — ${payload.events.length} events (trigger=${payload.trigger?.kind ?? "none"}, truncated=${payload.truncated}), ${pinnedWrites.length} scrollTop writes, ${backward.length} backward moves. ` +
      `Copy with: copy(JSON.stringify(__CHAT_VIEWPORT_TRACE__))`,
    {
      trigger: payload.trigger,
      lastWrite: pinnedWrites[pinnedWrites.length - 1] ?? null,
      lastBackward: backward[backward.length - 1] ?? null,
    },
  );
  return payload;
}

/** Read-only view of collected events (tests / devtools). */
export function chatViewportTraceEvents(): readonly ViewportTraceEvent[] {
  return events;
}

/**
 * Would this sample count as a suspicious UPWARD viewport jump?
 *
 * The stricter {@link isBackwardViewportMove} only fires while the chat is still
 * following the tail. A captured run showed the jump landing together with the
 * pin being released (a -2629px move reported with `pinned: false`), so an
 * upward move of that size with no user gesture is worth capturing even when the
 * pin is already off — that case is otherwise indistinguishable from a real
 * scroll-up.
 */
export const VIEWPORT_JUMP_MIN_PX = 600;

export function isSuspiciousUpwardJump(input: {
  userGestureRecent: boolean;
  /** Change in scrollTop for this sample (negative = moved up). */
  deltaTop: number;
  minPx?: number;
}): boolean {
  if (input.userGestureRecent) return false;
  const min = input.minPx ?? VIEWPORT_JUMP_MIN_PX;
  return input.deltaTop <= -min;
}

/**
 * Why a pinned/escaped flip happened, normalized so a trace can be read
 * without knowing the stick hook's internal reason strings (Spec "诊断",
 * C4). `layout-clamp` is the engine moving `scrollTop` after a height change;
 * it is the one cause that must never be read as a user leaving.
 */
export type PinFlipCause =
  | "wheel"
  | "touch"
  | "keyboard"
  | "scrollbar"
  | "layout-clamp"
  | "hard-bottom"
  | "button";

/** Gesture a flip is attributed to; "none" when no gesture explains it. */
export type PinFlipGesture =
  | "wheel"
  | "touch"
  | "keyboard"
  | "scrollbar"
  | "none";

/** Within this distance of the content end a flip counts as a hard-bottom flip. */
export const HARD_BOTTOM_PX = 1;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Distance from the current `scrollTop` to the content end; 0 at the hard
 * bottom. Negative is possible transiently (overscroll) and is left as-is, so
 * a trace does not hide a broken position.
 */
export function distanceToContentEnd(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  return input.scrollHeight - input.clientHeight - input.scrollTop;
}

/** One row's on-screen position, identified stably by its transcript index. */
export type VisibleRowPosition = {
  index: number;
  /** `getBoundingClientRect().top` at sample time, in viewport px. */
  top: number;
};

/**
 * On-screen vertical displacement (px) of the rows that stayed in the visible
 * band between two frames — the C2 "visible content did not move" metric, on
 * the paint boundary.
 *
 * Rows are matched by index so a row that left and re-entered the band is not
 * mistaken for a row that moved. Returns null when nothing persisted, which is
 * the honest answer for the first sample and for a move that replaced every
 * visible row: over those frames C2 has no common content to judge.
 */
export function visibleBandShift(
  previous: readonly VisibleRowPosition[],
  current: readonly VisibleRowPosition[],
): number | null {
  const before = new Map(previous.map((row) => [row.index, row.top]));
  let sum = 0;
  let count = 0;
  for (const row of current) {
    const priorTop = before.get(row.index);
    if (priorTop === undefined) continue;
    sum += row.top - priorTop;
    count += 1;
  }
  return count === 0 ? null : round2(sum / count);
}

/**
 * Normalize a pin/escape flip into one of {@link PinFlipCause}.
 *
 * The reason's prefix wins where it already names a gesture (`wheel-*`,
 * `touch-*`, `key-*`); the callers that cannot name a gesture from the reason
 * alone pass `gesture`. A flip that landed on the hard bottom is a hard-bottom
 * flip even when a gesture is recent, because that is what actually re-engaged
 * follow; anything else without a gesture is layout clamping.
 */
export function classifyPinFlipCause(input: {
  reason: string;
  gesture?: PinFlipGesture;
  /** px from the content end at the moment of the flip. */
  distFromBottom: number;
  hardBottomPx?: number;
}): PinFlipCause {
  const reason = input.reason.toLowerCase();
  if (reason.includes("button")) return "button";
  if (reason.startsWith("wheel")) return "wheel";
  if (reason.startsWith("touch")) return "touch";
  if (reason.startsWith("key")) return "keyboard";
  const hard = input.distFromBottom <= (input.hardBottomPx ?? HARD_BOTTOM_PX);
  // Gesture-free re-engagements the hook emits after a layout change.
  if (reason === "height-change-repin" || reason === "bottom-rebound") {
    return hard ? "hard-bottom" : "layout-clamp";
  }
  if (hard) return "hard-bottom";
  const gesture = input.gesture ?? "none";
  return gesture === "none" ? "layout-clamp" : gesture;
}

/** The cause of the most recent pin/escape flip, or null before the first one. */
export function lastPinFlipCause(): PinFlipCause | null {
  return recentPinFlipCause;
}

/**
 * Send a compact trace payload (a heartbeat, not the event ring) to the Host
 * log. Silent when not under Tauri.
 */
export async function publishTraceToHost(payload: unknown): Promise<void> {
  if (!chatViewportTraceEnabled()) return;
  const session = chatTraceSessionId();
  const line = session
    ? `[session=${session}] ${JSON.stringify(payload)}`
    : JSON.stringify(payload);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("chat_viewport_trace", { line });
  } catch (error) {
    // Keep the failure in the in-memory ring so a browser-only reproduction
    // still proves that the probe attempted to publish to the Host.
    traceViewport("host-publish-failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    console.warn("[chatTrace] Host publish failed", error instanceof Error ? error.name : "unknown");
  }
}

/** Drop collected events (tests). */
export function resetChatViewportTrace(): void {
  events = [];
  dumps = 0;
  recentPinFlipCause = null;
}

/** Mirror the current stick state for trace payloads. */
export function setChatViewportTracePinned(next: boolean): void {
  pinned = next;
}
