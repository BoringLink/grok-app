/**
 * Explicit chat transcript viewport controller — pure decision core.
 *
 * The transcript's position has exactly one decision maker (ADR 0006): this
 * module plans *where* the viewport must sit and *which* state transition the
 * position implies. It never touches the DOM and never writes `scrollTop`; the
 * hook that owns the element (`useChatViewportController`) applies the plan
 * through a single write point.
 *
 * Two states, from `CONTEXT.md`:
 *   pinned  — the viewport sits at the content end and stays there while the
 *             conversation grows.
 *   escaped — the user chose to read history; the element at the top of the
 *             viewport keeps its on-screen position under any height change.
 *
 * Only a user intent (wheel / touch / keyboard / scrollbar drag) can move
 * `pinned → escaped`. A gesture-less upward move is layout clamping: it must
 * not change the state, and the same batch must put the viewport back on the
 * end. Two consecutive gesture-less upward moves at an unchanged height are
 * the one exception — a scrollbar drag produces exactly that signature, so it
 * upgrades to a real escape.
 *
 * Geometry offsets come from the layout ledger so the planner never
 * re-derives whole-conversation math from the DOM.
 */

import type { LayoutLedger } from "@/lib/chatViewportLedger";
import {
  bottomScrollTop,
  isHardBottom,
  shouldEscapePinnedScroll,
  shouldSettleBottomRebound,
  STICK_ESCAPE_MIN_DELTA_PX,
  STICK_ESCAPE_WHEEL_DELTA,
} from "@/lib/stickToBottom";

/** Which state the viewport is in, per `CONTEXT.md`. */
export type ViewportPhase = "pinned" | "escaped";

/**
 * Largest on-screen anchor displacement tolerated at a paint boundary — the
 * Spec's C1/C3 bound (≤ 0.5px). One number backs three decisions that must
 * agree: the escaped restore corrects once the anchor moves more than this, the
 * transcript write skips a target this close to the current position (*never*
 * write for noise, always write for a violation), and the trace counts a
 * displacement past it as a sample-worthy frame.
 */
export const VIEWPORT_ANCHOR_TOLERANCE_PX = 0.5;

/** The three numbers a scroll container exposes. */
export type ViewportGeometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * The element at the top of the viewport, expressed against the ledger: which
 * row sits there and how far its top is from the viewport top (negative when
 * the viewport top is inside the row).
 */
export type ViewportAnchor = {
  rowIndex: number;
  offsetIntoViewport: number;
};

/** Row geometry the planner reads; a `LayoutLedger` satisfies it structurally. */
export type ViewportRows = Pick<
  LayoutLedger,
  "offsetOf" | "indexAtOffset" | "rowCount" | "totalHeight"
>;

/** A user gesture. Sign convention: negative moves toward history. */
export type ViewportIntent =
  | { kind: "wheel"; deltaY: number }
  | { kind: "touch"; deltaY: number }
  | { kind: "keyboard"; key: string }
  | { kind: "scrollbar"; deltaY: number };

/** What an intent means for the state machine. */
export type ViewportIntentEffect = "escape" | "towardEnd" | "none";

/** A position write the caller must apply; `none` means "leave it alone". */
export type ViewportDirective =
  | { kind: "end" }
  | { kind: "anchor"; top: number }
  | { kind: "none" };

/** Mutable state the caller carries between batches. */
export type ViewportState = {
  phase: ViewportPhase;
  /** Set whenever the phase is escaped; null while pinned. */
  anchor: ViewportAnchor | null;
  /** Consecutive gesture-free upward scroll events at an unchanged height. */
  upStreak: number;
  upStreakAt: number;
};

/** Keyboard moves that read history. */
const ESCAPE_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);
/** Keyboard moves that return toward the tail. */
const TOWARD_END_KEYS = new Set([
  "PageDown",
  "ArrowDown",
  "End",
  " ",
  "Spacebar",
]);

/** Fresh state: pinned at the tail with no anchor. */
export function createViewportState(): ViewportState {
  return { phase: "pinned", anchor: null, upStreak: 0, upStreakAt: 0 };
}

/** Target `scrollTop` that parks the viewport on the content end. */
export function contentEndScrollTop(geometry: ViewportGeometry): number {
  return bottomScrollTop(geometry.scrollHeight, geometry.clientHeight);
}

/** Highest `scrollTop` the engine will keep (content end). */
export function maxScrollTop(geometry: ViewportGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight);
}

/**
 * The row at the top of the viewport and its offset, resolved through the
 * ledger. Empty ledger → row 0 at the viewport top.
 */
export function anchorAtViewportTop(
  geometry: ViewportGeometry,
  rows: ViewportRows,
): ViewportAnchor {
  const count = rows.rowCount();
  if (count === 0) {
    // Empty ledger: hold the raw scrollTop. offsets[0] is 0, so recording
    // `-scrollTop` makes the round-trip a no-op instead of jumping to the top.
    return { rowIndex: 0, offsetIntoViewport: -geometry.scrollTop };
  }
  const rowIndex = Math.min(
    Math.max(0, rows.indexAtOffset(geometry.scrollTop)),
    count - 1,
  );
  return {
    rowIndex,
    offsetIntoViewport: rows.offsetOf(rowIndex) - geometry.scrollTop,
  };
}

/** `scrollTop` that keeps `anchor` at its recorded on-screen position. */
export function scrollTopForAnchor(
  anchor: ViewportAnchor,
  rows: ViewportRows,
  geometry: ViewportGeometry,
): number {
  const raw = rows.offsetOf(anchor.rowIndex) - anchor.offsetIntoViewport;
  return Math.min(Math.max(0, raw), maxScrollTop(geometry));
}

/**
 * Classify a user gesture. Reading history escapes; a move toward the tail is
 * only a re-pin signal at the hard bottom (the near-bottom band is deliberately
 * not re-pinning — that thrash is the bottom bounce).
 */
export function intentEffect(intent: ViewportIntent): ViewportIntentEffect {
  switch (intent.kind) {
    case "wheel":
      if (intent.deltaY <= -STICK_ESCAPE_WHEEL_DELTA) return "escape";
      if (intent.deltaY >= STICK_ESCAPE_WHEEL_DELTA) return "towardEnd";
      return "none";
    case "touch":
      // Finger moves down → content moves up → the user is reading history.
      if (intent.deltaY >= STICK_ESCAPE_MIN_DELTA_PX) return "escape";
      if (intent.deltaY <= -STICK_ESCAPE_MIN_DELTA_PX) return "towardEnd";
      return "none";
    case "keyboard":
      if (ESCAPE_KEYS.has(intent.key)) return "escape";
      if (TOWARD_END_KEYS.has(intent.key)) return "towardEnd";
      return "none";
    case "scrollbar":
      if (intent.deltaY < 0) return "escape";
      if (intent.deltaY > 0) return "towardEnd";
      return "none";
  }
}

function escapeState(
  geometry: ViewportGeometry,
  rows: ViewportRows,
  now: number,
): ViewportState {
  return {
    phase: "escaped",
    anchor: anchorAtViewportTop(geometry, rows),
    upStreak: 0,
    upStreakAt: now,
  };
}

/** The result of a user gesture: new state, a position, and the effect kind. */
export type ViewportIntentDecision = {
  state: ViewportState;
  directive: ViewportDirective;
  /** The caller arms its bottom-intent window on `towardEnd`, clears on `escape`. */
  effect: ViewportIntentEffect;
};

/**
 * Transition for a user gesture. Escape is immediate and does not move the
 * viewport (the user's own scroll already landed); a move toward the tail
 * re-pins only when it lands on the hard bottom.
 */
export function applyIntent(input: {
  state: ViewportState;
  intent: ViewportIntent;
  geometry: ViewportGeometry;
  rows: ViewportRows;
  now: number;
}): ViewportIntentDecision {
  const { state, intent, geometry, rows, now } = input;
  const effect = intentEffect(intent);
  if (effect === "escape") {
    return {
      state: escapeState(geometry, rows, now),
      directive: { kind: "none" },
      effect,
    };
  }
  if (
    effect === "towardEnd" &&
    isHardBottom(geometry.scrollTop, geometry.scrollHeight, geometry.clientHeight)
  ) {
    return { state: createViewportState(), directive: { kind: "end" }, effect };
  }
  return { state, directive: { kind: "none" }, effect };
}

export type ViewportScrollSample = {
  scrollTop: number;
  previousScrollTop: number;
  scrollHeight: number;
  previousScrollHeight?: number;
  clientHeight: number;
  /** A real gesture happened within the escape window. */
  gestureRecent: boolean;
  /** A recent gesture pointed toward the tail; elastic rebound may follow. */
  downIntentActive: boolean;
  /** A collapse/reflow is being absorbed; a matching upward move is layout. */
  recoveryWindow: boolean;
  thresholdPx?: number;
};

function resetStreak(state: ViewportState): ViewportState {
  return state.upStreak === 0 ? state : { ...state, upStreak: 0, upStreakAt: 0 };
}

/**
 * Transition for a scroll event — the single policy for a scroll after a
 * gesture has been classified. Ordering matters:
 *
 * 1. escaped — hold position; re-pin only on a gesture landing at the end.
 * 2. elastic rebound after a downward gesture — settle to the end.
 * 3. a gesture that reads history — escape.
 * 4. a gesture-free upward move — layout clamp; a run at a stable height is a
 *    scrollbar drag and escapes.
 * 5. otherwise while pinned — steer back to the content end.
 */
export function applyScrollSample(input: {
  state: ViewportState;
  sample: ViewportScrollSample;
  rows: ViewportRows;
  now: number;
  /** Upward moves within this window extend the same streak. */
  streakWindowMs: number;
}): { state: ViewportState; directive: ViewportDirective } {
  const { state, sample, rows, now, streakWindowMs } = input;
  const geometry: ViewportGeometry = {
    scrollTop: sample.scrollTop,
    scrollHeight: sample.scrollHeight,
    clientHeight: sample.clientHeight,
  };
  const movedUp = sample.previousScrollTop - sample.scrollTop >= 0.5;
  // Compare against the raw content end: an engine-clamped overscroll past
  // max is not "at the end" and must be pulled back.
  const atEnd =
    Math.abs(sample.scrollTop - contentEndScrollTop(geometry)) <= 0.5;

  if (state.phase === "escaped") {
    if (
      (movedUp === false) &&
      (sample.gestureRecent || sample.downIntentActive) &&
      atEnd
    ) {
      return { state: createViewportState(), directive: { kind: "end" } };
    }
    // Reading history: stay there, do not fight the user.
    return { state, directive: { kind: "none" } };
  }

  if (
    shouldSettleBottomRebound({
      downIntentActive: sample.downIntentActive,
      scrollTop: sample.scrollTop,
      previousScrollTop: sample.previousScrollTop,
      scrollHeight: sample.scrollHeight,
      clientHeight: sample.clientHeight,
      thresholdPx: sample.thresholdPx,
    })
  ) {
    // A downward gesture overshot the tail and the elastic upward move follows.
    return { state: resetStreak(state), directive: { kind: "end" } };
  }

  const escapeCandidate =
    movedUp &&
    shouldEscapePinnedScroll({
      pinned: true,
      scrollTop: sample.scrollTop,
      previousScrollTop: sample.previousScrollTop,
      scrollHeight: sample.scrollHeight,
      clientHeight: sample.clientHeight,
      previousScrollHeight: sample.previousScrollHeight,
    });

  if (escapeCandidate && sample.recoveryWindow) {
    // A collapse is being absorbed: an upward move here is layout, not a leave.
    // A real wheel/touch escape already flipped the phase before this event.
    return { state: resetStreak(state), directive: { kind: "end" } };
  }

  if (escapeCandidate && sample.gestureRecent) {
    return { state: escapeState(geometry, rows, now), directive: { kind: "none" } };
  }

  if (escapeCandidate) {
    // Gesture-free upward move at an effectively unchanged height. One is a
    // layout clamp (re-assert the end); two in a row are a scrollbar drag.
    const stableHeight =
      sample.previousScrollHeight == null ||
      Math.abs(sample.scrollHeight - sample.previousScrollHeight) < 0.5;
    const streak =
      stableHeight && now - state.upStreakAt < streakWindowMs
        ? state.upStreak + 1
        : stableHeight
          ? 1
          : 0;
    if (streak >= 2) {
      return {
        state: escapeState(geometry, rows, now),
        directive: { kind: "none" },
      };
    }
    return {
      state: { ...state, upStreak: streak, upStreakAt: now },
      directive: { kind: "end" },
    };
  }

  // Pinned, no leave: steer back to the content end.
  return {
    state: resetStreak(state),
    directive: atEnd ? { kind: "none" } : { kind: "end" },
  };
}

/**
 * Position for the end of a batch that changed height: pinned → the content
 * end; escaped → the recorded anchor's on-screen position.
 *
 * The anchor is the element at the viewport top, so this is exactly what
 * "reading stability" means (Spec: while escaped the anchor is the element at
 * the viewport top). A height change at
 * or above the anchor scrolls to keep that element still, so the content the
 * user is reading does not move; a change below the anchor leaves the element's
 * offset alone and the top of the viewport stays fixed while the content under
 * it moves up.
 */
export function planRestore(input: {
  state: ViewportState;
  geometry: ViewportGeometry;
  rows: ViewportRows;
}): ViewportDirective {
  const { state, geometry, rows } = input;
  if (state.phase === "pinned") {
    return { kind: "end" };
  }
  if (!state.anchor) {
    return { kind: "anchor", top: contentEndScrollTop(geometry) };
  }
  return { kind: "anchor", top: scrollTopForAnchor(state.anchor, rows, geometry) };
}

/**
 * A programmatic jump target: the content end, or a specific position. The
 * caller names the case it decided (the target is the conversation's last row,
 * or a measured position), rather than passing a bare boolean.
 */
export type JumpTarget =
  | { kind: "end" }
  | { kind: "position"; top: number };

/**
 * The outcome of a programmatic jump. `end` re-engages follow at the content
 * end; `land` escapes onto a specific position, which becomes the anchor.
 */
export type JumpDecision =
  | { kind: "end" }
  | { kind: "land"; top: number };

/**
 * Plan a programmatic jump (rail / find / deep link).
 *
 * A target of the content end (a jump to the last row) re-engages follow, and
 * so does any position that clamps to the content end: the reader is at the
 * tail either way, so follow does not hold an escaped anchor there. Every other
 * target lands on its position and escapes onto it.
 *
 * "The content end" is `contentEndScrollTop`, the same helper the `end`
 * directive uses, so the two can never disagree about where the end is.
 */
export function planJump(input: {
  target: JumpTarget;
  geometry: ViewportGeometry;
}): JumpDecision {
  if (input.target.kind === "end") return { kind: "end" };
  const top = Math.min(
    Math.max(0, input.target.top),
    contentEndScrollTop(input.geometry),
  );
  if (
    isHardBottom(top, input.geometry.scrollHeight, input.geometry.clientHeight)
  ) {
    return { kind: "end" };
  }
  return { kind: "land", top };
}
