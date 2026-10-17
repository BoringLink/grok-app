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

/** Append one event. No-op unless {@link chatViewportTraceEnabled}. */
export function traceViewport(
  kind: string,
  data: Record<string, unknown>,
): void {
  if (!chatViewportTraceEnabled()) return;
  events.push({ t: Math.round(now() * 100) / 100, kind, ...data });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
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
}): void {
  traceViewport("pin", {
    reason: input.reason,
    pinned: input.pinned,
    escaped: input.escaped,
    distFromBottom: Math.round(
      input.scrollHeight - input.clientHeight - input.scrollTop,
    ),
  });
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

/** Publish the collected trace and return it. */
export function dumpChatViewportTrace(reason: string): {
  reason: string;
  dumps: number;
  events: ViewportTraceEvent[];
} {
  const payload = { reason, dumps: dumps + 1, events: events.slice() };
  if (!chatViewportTraceEnabled()) return payload;
  dumps += 1;
  if (typeof window !== "undefined") {
    (window as unknown as { __CHAT_VIEWPORT_TRACE__: unknown }).__CHAT_VIEWPORT_TRACE__ =
      payload;
  }
  const pinnedWrites = payload.events.filter((e) => e.kind === "scrollTop");
  const backward = payload.events.filter((e) => e.kind === "backward");
  console.warn(
    `[chatTrace] ${reason} — ${payload.events.length} events, ${pinnedWrites.length} scrollTop writes, ${backward.length} backward moves. ` +
      `Copy with: copy(JSON.stringify(__CHAT_VIEWPORT_TRACE__))`,
    { lastWrite: pinnedWrites[pinnedWrites.length - 1] ?? null, lastBackward: backward[backward.length - 1] ?? null },
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
 * Send a compact trace payload (a heartbeat, not the event ring) to the Host
 * log. Silent when not under Tauri.
 */
export async function publishTraceToHost(payload: unknown): Promise<void> {
  if (!chatViewportTraceEnabled()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("chat_viewport_trace", { line: JSON.stringify(payload) });
  } catch {
    /* Browser preview or a build without the command: the console copy stands. */
  }
}

/** Drop collected events (tests). */
export function resetChatViewportTrace(): void {
  events = [];
  dumps = 0;
}

/** Mirror the current stick state for trace payloads. */
export function setChatViewportTracePinned(next: boolean): void {
  pinned = next;
}
