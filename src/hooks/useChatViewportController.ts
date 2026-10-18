/**
 * The chat transcript viewport controller (ADR 0006).
 *
 * Single decision maker and single write point for the transcript position:
 *   - pinned  — sit on the content end and stay there while content grows;
 *   - escaped — hold the element at the viewport top at a fixed on-screen
 *               position across every height change.
 *
 * The state machine lives in `lib/chatViewportController` (pure, tested): it
 * decides, this hook applies. The hook owns the element, classifies gestures
 * into intents, restores the invariant at the end of a height-changing batch
 * (before paint) and is the only module that assigns `scrollTop`.
 *
 * Pin model:
 * - Only a user gesture (wheel / touch / keyboard / scrollbar drag) escapes;
 *   we do NOT re-pin merely because they are still within the near-bottom
 *   threshold (that thrash is what causes bounce).
 * - Re-pin only after they scroll down again and land on the absolute bottom,
 *   or after force-stick / conversation switch.
 * - Programmatic follows are instant and ignored by the scroll handler so
 *   resize + stream growth cannot fight the user mid-gesture.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
  type UIEvent,
} from "react";
import {
  STICK_ESCAPE_MIN_DELTA_PX,
  STICK_BOTTOM_REBOUND_INTENT_MS,
  STICK_COLLAPSE_RECOVERY_MS,
  STICK_HEIGHT_NOISE_PX,
  STICK_OPEN_FOLLOW_MS,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  bottomScrollTop,
  isConversationOpenFollowActive,
  isHardBottom,
  isHeightDeltaNoise,
  isNearBottom,
  pinnedFollowDelayForLayout,
  shouldClampPinnedStreamDrift,
  shouldIgnoreProgrammaticStickLeave,
  shouldPreventPinnedBottomWheel,
} from "@/lib/stickToBottom";
import {
  CHAT_VIEWPORT_OCCLUSION_EVENT,
  assessViewportOcclusion,
  parseHostOcclusionPayload,
  shouldRestoreAfterOcclusion,
  type ViewportOcclusion,
} from "@/lib/chatViewportOcclusion";
import { pausedRafFallbackMs } from "@/lib/frameCadence";
import {
  cancelFrameSchedule,
  emptyFrameSchedule,
  scheduleOnFrameWithin,
  type FrameSchedule,
} from "@/lib/frameSchedule";
import {
  createLayoutLedger,
  LEDGER_FALLBACK_ESTIMATE_PX,
  type LayoutLedger,
} from "@/lib/chatViewportLedger";
import {
  anchorAtViewportTop,
  applyIntent,
  applyScrollSample,
  contentEndScrollTop,
  createViewportState,
  planJump,
  planRestore,
  VIEWPORT_ANCHOR_TOLERANCE_PX,
  type JumpTarget,
  type ViewportDirective,
  type ViewportGeometry,
  type ViewportIntent,
  type ViewportState,
} from "@/lib/chatViewportController";
import {
  anchorScreenShift,
  applyScrollTopTraced,
  chatViewportTraceEnabled,
  traceOcclusion,
  tracePinState,
  traceScrollTopWrite,
  traceViewport,
  type PinFlipGesture,
} from "@/lib/chatViewportTrace";


export type UseChatViewportControllerOptions = {
  /** Re-pin when the conversation identity changes (session / first message). */
  conversationKey?: string | number | null;
  /** Force re-pin (e.g. user just sent a message). */
  forceStickKey?: string | number | null;
  /** px from bottom still considered "near" for re-engage. Default 100. */
  thresholdPx?: number;
  enabled?: boolean;
};

/**
 * The escaped reader's held anchor: the element taken at the viewport top and
 * the screen top recorded for it. Exposed to the trace probe so the C3 read-out
 * measures the same element the restore corrects.
 */
export type EscapedAnchorElement = {
  element: HTMLElement | null;
  screenTop: number;
};

/**
 * The controller handle handed to other transcript writers (the resident list
 * and the rail / find jumps). Every method funnels into `assign`, the single
 * transcript position write; no caller touches `scrollTop` itself.
 */
export type ChatViewportControllerHandle = {
  /**
   * Apply a position. `behavior: "smooth"` is only used by the explicit
   * "back to bottom" control. Every write is recorded for the trace.
   */
  assign(source: string, top: number, behavior?: ScrollBehavior): void;
  /**
   * The single geometry ledger (ADR 0006). The resident list seeds estimates
   * and reads shell heights from it; measured heights go through
   * `reportRowHeight` so the controller stays the writer of the ledger.
   */
  ledger(): LayoutLedger;
  /** A row's measured height changed — restore the invariant before paint. */
  reportRowHeight(index: number, height: number, generation?: number): void;
  /**
   * Shell-row-only: re-seed a row from the model estimate after a fold it did
   * not render (it was outside the band). The resident list calls this in the
   * write path so the scrollbar follows a shell's fold immediately; see
   * {@link LayoutLedger.reestimateRow}.
   *
   * `isRich` is the caller's band predicate and is enforced here: a row that is
   * rendering real content is left untouched, so the tier bypass this method
   * performs can never demote a visible row (nor its queued measurement, which
   * the ledger's per-row generation rejects).
   */
  reestimateRow(
    index: number,
    height: number,
    isRich: (index: number) => boolean,
  ): void;
  /** Drop every remembered height (conversation / row-identity change). */
  resetLedger(): void;
  /** A layout batch changed the transcript height — restore before paint. */
  restoreLayout(source?: string): void;
  /**
   * Notified synchronously after every transcript position write, so a reader
   * (the resident list) can re-band in the write path instead of waiting for a
   * frame — a programmatic jump must not paint a shell inside the band.
   */
  subscribePosition(listener: () => void): () => void;
  /**
   * Programmatic escape (rail / find jump). Drops the held anchor and enters
   * the escaped phase: the caller's landing write becomes the anchor, which
   * `jumpTo` captures so the landed position is held, not re-derived.
   */
  escape(reason: string): void;
  /**
   * Land a programmatic jump (rail / find / deep link).
   *
   * A target of the content end (a jump to the conversation's last row, or a
   * position that clamps to the bottom) re-engages follow. Any other target
   * escapes onto the landed position, which becomes the anchor so a later
   * height change above leaves the landed message where it is.
   */
  jumpTo(source: string, target: JumpTarget): void;
  /** Pin to the content end (send, force-stick, back-to-bottom). */
  pinToEnd(source: string, behavior?: ScrollBehavior): void;
};

export type UseChatViewportControllerResult = {
  viewportRef: RefObject<HTMLDivElement | null>;
  /** Optional: attach to the content column for more accurate resize observe. */
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  scrollToBottom: (behavior?: ScrollBehavior, reason?: string) => void;
  /** True while auto-follow is active (ref, not reactive). */
  isPinnedRef: RefObject<boolean>;
  /** True after an explicit user scroll-up until the tail is re-engaged. */
  escapedRef: RefObject<boolean>;
  /** Reactive: show "back to bottom" control when user has scrolled up. */
  showBack: boolean;
  /** Fine-grained subscription for BackBottom button to avoid parent component re-renders. */
  subscribeShowBack: (cb: (val: boolean) => void) => () => void;
  /**
   * The escaped reader's held anchor (element + recorded screen top), or null
   * while pinned. The trace probe reads it so its C3 metric measures the same
   * element the restore holds (dev-only).
   */
  anchorRef: RefObject<EscapedAnchorElement | null>;
  /** Handle other transcript writers use instead of assigning scrollTop. */
  controller: ChatViewportControllerHandle;
};

/**
 * A scroll event within this window of a real gesture is the user's own move.
 * Collapse clamps never have one, so they cannot release the pin.
 */
const GESTURE_ESCAPE_WINDOW_MS = 400;

/**
 * How long `data-scrolling="1"` stays on the viewport after the last scroll
 * activity. Setting it is immediate; clearing is debounced, because each
 * attribute flip re-runs selector matching over the whole transcript DOM and a
 * slow drag settles for a few frames between wheel ticks. 220ms spans the gaps
 * inside one wheel/trackpad gesture (and its momentum) while restoring hover
 * and the wallpaper backdrop promptly once the gesture is over.
 */
const SCROLLING_FLAG_IDLE_MS = 220;

function stickNowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Whether an element is a scroll container the user can scroll on its own
 * (the transcript's nested scrollers), read from the computed style so a
 * content-overflow element (`overflow: hidden`) is not mistaken for one.
 */
function isScrollContainer(el: HTMLElement): boolean {
  if (typeof getComputedStyle !== "function") return false;
  const style = getComputedStyle(el);
  const scrollable = (value: string) => value === "auto" || value === "scroll";
  return scrollable(style.overflowY) || scrollable(style.overflowX);
}

export function useChatViewportController(
  options: UseChatViewportControllerOptions = {},
): UseChatViewportControllerResult {
  const {
    conversationKey = null,
    forceStickKey = null,
    thresholdPx = STICK_TO_BOTTOM_THRESHOLD_PX,
    enabled = true,
  } = options;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /**
   * Geometry source for the controller's anchor math. The resident list reports
   * measured row heights; the ledger grows with them, so the controller never
   * re-derives whole-conversation offsets from the DOM.
   */
  const ledgerRef = useRef<LayoutLedger>(
    createLayoutLedger({
      count: 0,
      estimateHeight: LEDGER_FALLBACK_ESTIMATE_PX,
    }),
  );
  /** Pinned / escaped phase plus the escaped-mode ledger anchor. */
  const viewportStateRef = useRef<ViewportState>(createViewportState());
  /**
   * The element at the viewport top while escaped, with its recorded
   * viewport-relative screen top. Measuring the element catches height changes
   * the ledger and the MutationObserver cannot see (a collapse above the
   * mounted band); the ledger is the fallback when it cannot be resolved.
   */
  const escapedAnchorRef = useRef<EscapedAnchorElement | null>(null);
  /** Coalesces batch-end restores to at most one per frame. */
  const restoreScheduledRef = useRef(false);
  /**
   * Clears {@link restoreScheduledRef} on the next frame, with a timer fallback
   * so the latch cannot stick when rAF is paused (an occluded or backgrounded
   * window) — that would stop every later restore.
   */
  const restoreLatchRef = useRef<FrameSchedule>(emptyFrameSchedule());
  /**
   * Host-reported window occlusion (macOS `NSWindowDidChangeOcclusionState`).
   * Page Visibility cannot see "completely covered by another app", which the
   * Spec's Problem Statement records as a source of a wrong position.
   */
  const hostOccludedRef = useRef(false);
  /** Auto-follow stream / growth. */
  const isPinnedRef = useRef(true);
  /**
   * User intentionally left the bottom. Stays true until they scroll down
   * (or force-stick). Prevents re-pin while still inside the near threshold.
   */
  const escapedRef = useRef(false);
  /** Recent real wheel/touch intent toward the tail; survives elastic rebound. */
  const bottomIntentUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  /** scrollTop we just wrote — used to ignore synthetic scroll events. */
  const ignoreScrollTopRef = useRef<number | undefined>(undefined);
  /**
   * Collapse can produce multiple synthetic upward scroll events: browser
   * clamp first, the resident list's band correction second. Keep pin through both.
   */
  const collapseRecoveryUntilRef = useRef(0);
  /** Debounced clear of the `data-scrolling` scroll-state flag. */
  const scrollingFlagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  /**
   * Last real user gesture (wheel / touch / keyboard) on the viewport. A
   * scroll that no gesture can explain is layout, so it must not release the
   * pin: only a gesture, or a run of upward events at a *stable* height,
   * counts as the user walking into history. Negative sentinel: before the
   * first gesture, `now - last` must never look like a fresh gesture.
   */
  const lastGestureAtRef = useRef(Number.NEGATIVE_INFINITY);
  /**
   * Which gesture stamped `lastGestureAtRef`. A scroll event carries no gesture
   * of its own, so a flip caused by one can only be attributed by looking at
   * the gesture that preceded it (see `classifyPinFlipCause`).
   */
  const lastGestureTypeRef = useRef<PinFlipGesture>("none");
  const thresholdRef = useRef(thresholdPx);
  thresholdRef.current = thresholdPx;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  /**
   * Keep following journal hydrate / image decode after a chat switch.
   * Wheel escape still wins (see isConversationOpenFollowActive).
   */
  const openFollowUntilRef = useRef(0);
  /** Explicit back-to-bottom animation; stale scroll settling must not clear pin. */
  const programmaticFollowUntilRef = useRef(0);
  const conversationKeyRef = useRef(conversationKey);
  if (conversationKeyRef.current !== conversationKey) {
    conversationKeyRef.current = conversationKey;
    escapedRef.current = false;
    isPinnedRef.current = true;
    viewportStateRef.current = createViewportState();
    ledgerRef.current = createLayoutLedger({
      count: 0,
      estimateHeight: LEDGER_FALLBACK_ESTIMATE_PX,
    });
    bottomIntentUntilRef.current = 0;
    lastScrollTopRef.current = 0;
    lastScrollHeightRef.current = 0;
    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    openFollowUntilRef.current = now + STICK_OPEN_FOLLOW_MS;
  }
  const showBackRef = useRef(false);
  const showBackListenersRef = useRef<Set<(val: boolean) => void>>(new Set());

  const subscribeShowBack = useCallback((cb: (val: boolean) => void) => {
    showBackListenersRef.current.add(cb);
    cb(showBackRef.current);
    return () => {
      showBackListenersRef.current.delete(cb);
    };
  }, []);

  const syncShowBack = useCallback(() => {
    const el = viewportRef.current;
    let next = false;
    if (el) {
      const overflow = el.scrollHeight > el.clientHeight + 40;
      next = !isPinnedRef.current && overflow;
    }
    if (next !== showBackRef.current) {
      showBackRef.current = next;
      for (const listener of showBackListenersRef.current) {
        listener(next);
      }
    }
  }, []);

  /**
   * Mark the transcript as scrolling. This is a UI signal, not a position
   * write: `data-scrolling="1"` lets the CSS suppress row hover / pointer
   * events and the wallpaper backdrop while the scroller is in motion, and
   * lets the node rail take its estimate path instead of a rect walk. Set
   * immediately, cleared by the debounced idle timer below.
   */
  const noteTranscriptScrolling = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (el.dataset.scrolling !== "1") el.dataset.scrolling = "1";
    if (scrollingFlagTimerRef.current != null) {
      clearTimeout(scrollingFlagTimerRef.current);
    }
    scrollingFlagTimerRef.current = setTimeout(() => {
      scrollingFlagTimerRef.current = null;
      const v = viewportRef.current;
      if (v && v.dataset.scrolling === "1") delete v.dataset.scrolling;
    }, SCROLLING_FLAG_IDLE_MS);
  }, []);

  /** Drop the flag and its pending timer (idle is handled by the timer). */
  const clearTranscriptScrolling = useCallback(() => {
    if (scrollingFlagTimerRef.current != null) {
      clearTimeout(scrollingFlagTimerRef.current);
      scrollingFlagTimerRef.current = null;
    }
    const el = viewportRef.current;
    if (el && el.dataset.scrolling === "1") delete el.dataset.scrolling;
  }, []);

  const readGeometry = useCallback((): ViewportGeometry | null => {
    const el = viewportRef.current;
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }, []);

  /**
   * The single occlusion assessment. Every guard — follow, scroll, layout and
   * the mutation restore — reads the same signals from here, so none of them
   * can drift from the restore boundary (all three signal sources: Page
   * Visibility, the host occlusion report, and the measured height).
   */
  const readViewportOcclusion = useCallback(
    (target: HTMLElement | null): ViewportOcclusion =>
      assessViewportOcclusion({
        hidden: typeof document !== "undefined" && document.hidden,
        covered: hostOccludedRef.current,
        clientHeight: target ? target.clientHeight : 0,
      }),
    [],
  );

  /**
   * Synchronous post-write listeners. The resident list re-bands here, in the
   * write path, so a programmatic jump is banded before the frame paints.
   */
  const positionListenersRef = useRef<Set<() => void>>(new Set());
  const notifyPositionWritten = useCallback(() => {
    for (const listener of positionListenersRef.current) listener();
  }, []);

  /**
   * The single transcript position write. Every decided move — instant or
   * animated — funnels here and is recorded through the trace module, so a
   * trace can attribute any move to its source (ADR 0006).
   */
  const assign = useCallback(
    (source: string, top: number, behavior: ScrollBehavior = "instant") => {
      const el = viewportRef.current;
      if (!el) return;
      if (behavior === "smooth" && typeof el.scrollTo === "function") {
        // Smooth is only the explicit "back to bottom" control. Mark the
        // target so the intermediate scroll events are not read as a gesture.
        const before = el.scrollTop;
        ignoreScrollTopRef.current = top;
        el.scrollTo({ top, behavior: "smooth" });
        traceScrollTopWrite(source, el, before);
        notifyPositionWritten();
        return;
      }
      // Force instant assignment even if CSS scroll-behavior is smooth.
      const prev = el.style.scrollBehavior;
      el.style.scrollBehavior = "auto";
      applyScrollTopTraced(source, el, top);
      ignoreScrollTopRef.current = el.scrollTop;
      lastScrollTopRef.current = el.scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
      if (prev) el.style.scrollBehavior = prev;
      else el.style.removeProperty("scroll-behavior");
      notifyPositionWritten();
    },
    [notifyPositionWritten],
  );

  const applyScrollTop = useCallback(
    (top: number, source = "stick:applyScrollTop") => {
      const el = viewportRef.current;
      if (!el) return;
      // Never write for noise, always write for a violation: a target within the
      // C1/C3 bound of the current position is not worth a write, and anything
      // past it is.
      if (Math.abs(el.scrollTop - top) <= VIEWPORT_ANCHOR_TOLERANCE_PX) {
        ignoreScrollTopRef.current = el.scrollTop;
        return;
      }
      assign(source, top);
    },
    [assign],
  );

  /** Apply a directive produced by the pure planner. */
  const applyDirective = useCallback(
    (directive: ViewportDirective, source: string) => {
      if (directive.kind === "none") return;
      const g = readGeometry();
      if (!g) return;
      applyScrollTop(
        directive.kind === "end" ? contentEndScrollTop(g) : directive.top,
        source,
      );
    },
    [applyScrollTop, readGeometry],
  );

  /**
   * The deepest element straddling the viewport top. Its on-screen position is
   * what "the user is reading here" means while escaped.
   *
   * The descent never enters a nested scroll container (the activity steps
   * table, the thinking / fragment bodies): a change *inside* one of those —
   * most importantly a decode, which carries no DOM mutation — moves an
   * element within the scroller without resizing the scroller's box, so neither
   * the content `ResizeObserver` nor the `MutationObserver` would report it and
   * the anchor could not be held. Stopping at the scroller keeps the anchor on a
   * box whose position the transcript controls.
   */
  const resolveTopAnchorElement = useCallback(
    (viewport: HTMLElement): HTMLElement | null => {
      const viewportTop = viewport.getBoundingClientRect().top;
      let current: HTMLElement | null = viewport;
      let anchor: HTMLElement | null = null;
      // Descend to the deepest child that still crosses the viewport top.
      while (current) {
        const next = Array.from(current.children).find((child) => {
          const rect = child.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > viewportTop;
        }) as HTMLElement | undefined;
        if (!next) break;
        anchor = next;
        if (isScrollContainer(next)) break;
        current = next;
      }
      return anchor;
    },
    [],
  );

  /**
   * Record the escaped anchor: the element at the viewport top (measured) plus
   * the ledger row as the fallback when that element cannot be resolved later.
   */
  const captureEscapeAnchor = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const g = readGeometry();
    if (!g) return;
    const element = resolveTopAnchorElement(el);
    escapedAnchorRef.current = {
      element,
      screenTop: element ? element.getBoundingClientRect().top : 0,
    };
    viewportStateRef.current = {
      phase: "escaped",
      anchor: anchorAtViewportTop(g, ledgerRef.current),
      upStreak: 0,
      upStreakAt: stickNowMs(),
    };
  }, [readGeometry, resolveTopAnchorElement]);

  /** Commit a state decided by the pure planner and trace the transition. */
  const commitState = useCallback(
    (
      state: ViewportState,
      reason: string,
      gesture?: PinFlipGesture,
      /** Caller's already-read geometry, so a flip does not read it twice. */
      geometry?: ViewportGeometry,
    ) => {
      const pinned = state.phase === "pinned";
      const changed =
        pinned !== isPinnedRef.current || !pinned !== escapedRef.current;
      viewportStateRef.current = state;
      isPinnedRef.current = pinned;
      escapedRef.current = !pinned;
      if (pinned) escapedAnchorRef.current = null;
      if (changed) {
        const g = geometry ?? readGeometry();
        if (g) {
          tracePinState({
            reason,
            pinned,
            escaped: !pinned,
            scrollTop: g.scrollTop,
            scrollHeight: g.scrollHeight,
            clientHeight: g.clientHeight,
            gesture,
          });
        }
        syncShowBack();
      }
    },
    [readGeometry, syncShowBack],
  );

  /**
   * Enter the escaped phase programmatically (rail / find / deep link). The
   * held anchor is dropped: the caller writes the landing position next, and
   * `jumpTo` captures that landing as the new anchor so a later height change
   * above restores it instead of displacing the landed message.
   */
  const beginEscape = useCallback(
    (reason: string, geometry?: ViewportGeometry) => {
      escapedAnchorRef.current = null;
      commitState(
        {
          phase: "escaped",
          anchor: null,
          upStreak: 0,
          upStreakAt: stickNowMs(),
        },
        reason,
        undefined,
        geometry,
      );
    },
    [commitState],
  );

  const clearBottomIntent = useCallback(() => {
    bottomIntentUntilRef.current = 0;
  }, []);

  /**
   * Restore the invariant for the current phase: pinned → the content end;
   * escaped → hold the anchor element's on-screen position (ledger fallback).
   */
  const restoreNow = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const g = readGeometry();
    if (!g) return;
    if (isPinnedRef.current) {
      applyDirective({ kind: "end" }, "restore:end");
      return;
    }
    const anchor = escapedAnchorRef.current;
    if (!anchor) {
      captureEscapeAnchor();
      return;
    }
    // Same helper the trace samples with, so the restore and the C3 read-out
    // can never disagree about the anchor's displacement.
    const delta = anchorScreenShift(anchor);
    if (delta != null) {
      if (Math.abs(delta) > VIEWPORT_ANCHOR_TOLERANCE_PX) {
        applyScrollTop(
          Math.min(Math.max(0, el.scrollTop + delta), contentEndScrollTop(g)),
          "restore:anchor",
        );
      }
      return;
    }
    applyDirective(
      planRestore({
        state: viewportStateRef.current,
        geometry: g,
        rows: ledgerRef.current,
      }),
      "restore:anchorFallback",
    );
  }, [applyDirective, applyScrollTop, captureEscapeAnchor, readGeometry]);

  /**
   * Batch-end restore. Mutation callbacks are microtasks, so the first call
   * lands before paint; the latch coalesces every further mutation in the same
   * frame into that one restore (at most one geometry read and one write per
   * frame, per the spec budget).
   *
   * The latch is cleared by the next frame **or** by a stall fallback: while
   * rAF is paused (an occluded or covered window) no frame arrives, and a latch
   * that only a frame could clear would stick — every later mutation would
   * return early and the transcript would stop being restored. The fallback is
   * several frame intervals out, so while frames flow the frame path still wins.
   */
  const scheduleRestore = useCallback(() => {
    if (restoreScheduledRef.current) return;
    restoreScheduledRef.current = true;
    scheduleOnFrameWithin(
      restoreLatchRef.current,
      () => {
        restoreScheduledRef.current = false;
      },
      pausedRafFallbackMs(),
    );
    restoreNow();
  }, [restoreNow]);

  /**
   * The single decision path for a user gesture: the pure planner classifies
   * it and this hook applies the resulting state and position.
   */
  const applyGesture = useCallback(
    (intent: ViewportIntent, source: string) => {
      const g = readGeometry();
      if (!g) return;
      const decision = applyIntent({
        state: {
          ...viewportStateRef.current,
          phase: isPinnedRef.current ? "pinned" : "escaped",
        },
        intent,
        geometry: g,
        rows: ledgerRef.current,
        now: stickNowMs(),
      });
      if (decision.effect === "escape") {
        clearBottomIntent();
        programmaticFollowUntilRef.current = 0;
        commitState(decision.state, `${source}-escape`);
        captureEscapeAnchor();
        return;
      }
      if (decision.effect === "towardEnd") {
        bottomIntentUntilRef.current =
          stickNowMs() + STICK_BOTTOM_REBOUND_INTENT_MS;
        commitState(decision.state, `${source}-repin`);
        applyDirective(decision.directive, `${source}-end`);
      }
    },
    [applyDirective, captureEscapeAnchor, clearBottomIntent, commitState, readGeometry],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "instant", reason = "scroll-to-bottom") => {
      const el = viewportRef.current;
      if (!el) return;
      const pinnedBefore = isPinnedRef.current;
      const now = stickNowMs();
      programmaticFollowUntilRef.current =
        behavior === "smooth" ? now + 800 : 0;
      // `reason` reaches the flip classifier, so the explicit button is
      // attributable as `button` rather than a generic hard-bottom landing.
      commitState(createViewportState(), reason);
      clearBottomIntent();
      const top = bottomScrollTop(el.scrollHeight, el.clientHeight);
      traceViewport("scroll-to-bottom", {
        behavior,
        scrollTop: Math.round(el.scrollTop),
        targetTop: Math.round(top),
        scrollHeight: Math.round(el.scrollHeight),
        clientHeight: Math.round(el.clientHeight),
        pinnedBefore,
      });
      assign("stick:scrollToBottom", top, behavior);
      if (behavior === "smooth") {
        // Snap pin state; showBack clears once we land near bottom via scroll.
        const start = performance.now();
        const tick = () => {
          const v = viewportRef.current;
          if (!v || !isPinnedRef.current || escapedRef.current) return;
          const near = isNearBottom(
            v.scrollTop,
            v.scrollHeight,
            v.clientHeight,
            thresholdRef.current,
          );
          if (near || performance.now() - start > 600) {
            applyDirective({ kind: "end" }, "scroll-to-bottom:settle");
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
      syncShowBack();
    },
    [applyDirective, assign, clearBottomIntent, commitState, syncShowBack],
  );

  const followIfPinned = useCallback(() => {
    if (!isPinnedRef.current || !enabledRef.current) return;
    const el = viewportRef.current;
    if (!el) return;
    if (readViewportOcclusion(el).occluded) return;
    applyDirective({ kind: "end" }, "follow:pinned");
  }, [applyDirective, readViewportOcclusion]);

  // React onScroll is a no-op passthrough — real logic is on native listeners
  // so we never miss passive wheel/scroll during streaming.
  const onScroll = useCallback((_e: UIEvent<HTMLDivElement>) => {
    /* native handler owns pin state */
  }, []);

  // Wheel / touch / scroll / resize — native, passive.
  useEffect(() => {
    if (!enabled) return;
    const el = viewportRef.current;
    if (!el) return;

    const handleScroll = () => {
      const scrollTop = el.scrollTop;
      const programmaticFollowActive =
        stickNowMs() < programmaticFollowUntilRef.current;
      if (readViewportOcclusion(el).occluded) {
        if (programmaticFollowActive) {
          isPinnedRef.current = true;
          escapedRef.current = false;
        }
        lastScrollTopRef.current = scrollTop;
        lastScrollHeightRef.current = el.scrollHeight;
        ignoreScrollTopRef.current = undefined;
        return;
      }
      const lastScrollTop = lastScrollTopRef.current;
      const lastScrollHeight = lastScrollHeightRef.current;
      const ignore = ignoreScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
      ignoreScrollTopRef.current = undefined;

      // Ignore only the synthetic event that actually landed on the written
      // position. A smooth follow stores its target before the animation; an
      // unrelated keyboard or scrollbar scroll must still reach escape logic.
      const landedOnIgnoredTop =
        ignore != null && Math.abs(scrollTop - ignore) < 0.5;
      // A follow wrote scrollTop. That is not a user leave.
      if (shouldIgnoreProgrammaticStickLeave(landedOnIgnoredTop ? ignore : undefined)) {
        return;
      }

      // A programmatic follow is still animating; never read its intermediate
      // events as a leave.
      if (programmaticFollowActive && !escapedRef.current) {
        isPinnedRef.current = true;
        return;
      }

      const now = stickNowMs();
      const gestureRecent =
        now - lastGestureAtRef.current < GESTURE_ESCAPE_WINDOW_MS;
      // A gesture-driven scroll, or any scroll while escaped (the reader is
      // driving), is a real move. A gesture-free scroll while pinned is stream
      // growth or a collapse clamp: flagging it would flash the wallpaper
      // backdrop on every stream frame (the flag drives `data-scrolling`).
      if (escapedRef.current || gestureRecent) noteTranscriptScrolling();
      const decision = applyScrollSample({
        state: {
          ...viewportStateRef.current,
          phase: isPinnedRef.current ? "pinned" : "escaped",
        },
        sample: {
          scrollTop,
          previousScrollTop: lastScrollTop,
          scrollHeight: el.scrollHeight,
          previousScrollHeight:
            lastScrollHeight > 0 ? lastScrollHeight : undefined,
          clientHeight: el.clientHeight,
          gestureRecent,
          downIntentActive: now <= bottomIntentUntilRef.current,
          recoveryWindow: now < collapseRecoveryUntilRef.current,
          thresholdPx: thresholdRef.current,
        },
        rows: ledgerRef.current,
        now,
        streakWindowMs: GESTURE_ESCAPE_WINDOW_MS,
      });

      if (decision.state.phase === "escaped") {
        if (isPinnedRef.current) {
          programmaticFollowUntilRef.current = 0;
          clearBottomIntent();
          // A scroll event names no gesture. A recent one attributes the flip;
          // otherwise the pure planner only escapes here after repeated upward
          // moves at a stable height — a scrollbar drag.
          commitState(
            decision.state,
            "scroll-escape",
            gestureRecent ? lastGestureTypeRef.current : "scrollbar",
          );
        }
        // Keep the anchor on the element now at the viewport top.
        captureEscapeAnchor();
        return;
      }

      if (escapedRef.current) {
        // Landed back on the end under a gesture: re-engage.
        commitState(
          decision.state,
          "scroll-repin",
          gestureRecent ? lastGestureTypeRef.current : "none",
        );
        applyDirective({ kind: "end" }, "scroll-repin");
        return;
      }

      commitState(
        decision.state,
        "scroll-settle",
        gestureRecent ? lastGestureTypeRef.current : "none",
      );
      applyDirective(decision.directive, "scroll-clamp");
    };

    const handleWheel = (e: WheelEvent) => {
      lastGestureAtRef.current = stickNowMs();
      lastGestureTypeRef.current = "wheel";
      noteTranscriptScrolling();
      if (
        shouldPreventPinnedBottomWheel({
          pinned: isPinnedRef.current,
          escaped: escapedRef.current,
          deltaY: e.deltaY,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        })
      ) {
        // At the locked bottom a downward tick cannot reveal more transcript;
        // let the pure planner keep the pin instead of rubber-banding.
        e.preventDefault();
      }
      applyGesture({ kind: "wheel", deltaY: e.deltaY }, "wheel");
    };

    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      lastGestureAtRef.current = stickNowMs();
      lastGestureTypeRef.current = "touch";
      noteTranscriptScrolling();
      const y = e.touches[0]?.clientY;
      if (touchY == null || y == null) return;
      const dy = y - touchY;
      // Finger moves down → content moves up (reading history). Require a
      // clear drag so a light touch at the locked bottom does not unstick and
      // then snap back (bounce + flash).
      if (Math.abs(dy) >= STICK_ESCAPE_MIN_DELTA_PX) {
        applyGesture({ kind: "touch", deltaY: dy }, "touch");
      }
      touchY = y;
    };
    const onTouchEnd = () => {
      touchY = null;
      // After a fling toward latest, re-pin only if we settled on the end.
      if (!escapedRef.current || stickNowMs() > bottomIntentUntilRef.current) {
        return;
      }
      requestAnimationFrame(() => {
        const v = viewportRef.current;
        if (!v) return;
        if (isHardBottom(v.scrollTop, v.scrollHeight, v.clientHeight)) {
          applyGesture(
            { kind: "touch", deltaY: -STICK_ESCAPE_MIN_DELTA_PX },
            "touch",
          );
        }
      });
    };

    const onKeyScroll = (e: KeyboardEvent) => {
      lastGestureAtRef.current = stickNowMs();
      lastGestureTypeRef.current = "keyboard";
      noteTranscriptScrolling();
      applyGesture({ kind: "keyboard", key: e.key }, "keyboard");
    };

    el.addEventListener("keydown", onKeyScroll, { passive: true });
    el.addEventListener("scroll", handleScroll, { passive: true });
    // Non-passive: at the locked bottom we preventDefault downward
    // overscroll so WKWebView cannot rubber-band the last lines under
    // the floating composer. Scroll-up is never blocked.
    el.addEventListener("wheel", handleWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;

    return () => {
      el.removeEventListener("keydown", onKeyScroll);
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      // The scroller may unmount mid-gesture: drop the flag and its timer
      // directly, so no pending clear can outlive the element.
      clearTranscriptScrolling();
    };
  }, [
    enabled,
    conversationKey,
    applyDirective,
    applyGesture,
    captureEscapeAnchor,
    clearBottomIntent,
    commitState,
    clearTranscriptScrolling,
    noteTranscriptScrolling,
  ]);

  // Conversation switch → re-pin and jump to bottom before paint so the
  // resident list's layout effect sees pin=true (otherwise it bands from
  // leftover scrollTop / the previous chat's browse range). Extra frames +
  // a short follow window cover journal hydrate and image/PDF decode.
  useLayoutEffect(() => {
    if (!enabled) return;
    commitState(createViewportState(), "conversation-switch");
    clearBottomIntent();
    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    openFollowUntilRef.current = now + STICK_OPEN_FOLLOW_MS;
    scrollToBottom("instant");
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      scrollToBottom("instant");
      raf2 = requestAnimationFrame(() => {
        if (!cancelled && !escapedRef.current) scrollToBottom("instant");
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [conversationKey, enabled, scrollToBottom, commitState, clearBottomIntent]);

  // User sent / turn became busy → force follow even if they had scrolled up.
  // Layout first so the resident list's itemCount effect sees pin=true in the
  // same frame (avoids a band flash, then a snap). One rAF covers
  // the new bubble height that is not measured until after paint.
  useLayoutEffect(() => {
    if (!enabled || forceStickKey == null || forceStickKey === "") return;
    commitState(createViewportState(), "force-stick");
    clearBottomIntent();
    scrollToBottom("instant");
    const raf = requestAnimationFrame(() => scrollToBottom("instant"));
    return () => cancelAnimationFrame(raf);
  }, [forceStickKey, enabled, scrollToBottom, commitState, clearBottomIntent]);

  // Content growth / shrink while pinned.
  useEffect(() => {
    if (!enabled) return;
    const el = viewportRef.current;
    if (!el) return;

    let previousHeight: number | undefined;
    let previousViewportWidth: number | undefined = el.clientWidth;
    let previousViewportHeight: number | undefined = el.clientHeight;
    /** Last content-box height the ResizeObserver reported, for the decode path. */
    let previousContentHeight: number | undefined;
    let viewportWidthChanged = false;
    let raf = 0;
    let mediaFollowTimer: ReturnType<typeof setTimeout> | null = null;

    const onHeightChange = (height: number) => {
      if (readViewportOcclusion(el).occluded) {
        previousHeight = height;
        return;
      }
      const widthMoved = viewportWidthChanged;
      viewportWidthChanged = false;
      const difference = height - (previousHeight ?? height);
      // Thought-stream / font / 1–3px reflow: skip full follow machinery so
      // micro reflows do not bounce — BUT still clamp if many small stream
      // deltas stacked and left us off hard bottom while pinned (smooth
      // thinking/body reveal is usually 2–7px per frame).
      if (
        previousHeight != null &&
        isHeightDeltaNoise(difference) &&
        !widthMoved
      ) {
        previousHeight = height;
        if (
          shouldClampPinnedStreamDrift(
            isPinnedRef.current,
            escapedRef.current,
            el.scrollTop,
            el.scrollHeight,
            el.clientHeight,
          )
        ) {
          applyDirective({ kind: "end" }, "height:streamDrift");
        }
        return;
      }
      if (difference < -0.5 && isPinnedRef.current && !escapedRef.current) {
        collapseRecoveryUntilRef.current =
          stickNowMs() + STICK_COLLAPSE_RECOVERY_MS;
      }

      // Browser can leave scrollTop past max after a shrink — clamp without
      // treating it as a user scroll (would thrash pin / jump to top).
      const maxTop = bottomScrollTop(el.scrollHeight, el.clientHeight);
      if (el.scrollTop > maxTop + 1) {
        applyScrollTop(maxTop, "height:overscroll");
      }

      if (
        difference < 0 &&
        !escapedRef.current &&
        isNearBottom(
          el.scrollTop,
          el.scrollHeight,
          el.clientHeight,
          thresholdRef.current,
        )
      ) {
        // Shrink while still following (markdown reflow): stay pinned so the
        // next grow does not leave a gap. Never re-engage if user escaped.
        isPinnedRef.current = true;
      }

      // Defense: pin can be dropped without an intentional escape after a
      // browser clamp / resident remeasure race (escaped stays false). If the
      // user is still parked on the absolute bottom, re-engage follow so the
      // rest of the stream keeps sticking. Intentional escape blocks this
      // (reading history is never yanked back down).
      if (
        !isPinnedRef.current &&
        !escapedRef.current &&
        isHardBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
      ) {
        commitState(createViewportState(), "height-change-repin");
      }

      // Grow, shrink, or viewport-only resize: follow only while pinned.
      // Never compensate with the full height delta while escaped — stream
      // growth is almost always at the bottom, so adding the delta would yank
      // the user down. The escaped anchor is held against its own measured
      // displacement instead (the RO callback's decode path and the mutation
      // restore), which is zero when the growth is below it.
      // Large jumps (image/PDF decode) wait so a storm of screenshots is one
      // snap, not one per file. Width interpolation (aside / env gutter) must
      // follow this frame or the column jumps up until the motion ends, then
      // snaps back.
      // Opening a chat: image cards / journal rows often land after the
      // first pin. Follow immediately only while still pinned — never
      // re-engage if the user already scrolled into history.
      const opening = isConversationOpenFollowActive({
        now:
          typeof performance !== "undefined" &&
          typeof performance.now === "function"
            ? performance.now()
            : Date.now(),
        until: openFollowUntilRef.current,
        escaped: escapedRef.current,
      });
      const delay = pinnedFollowDelayForLayout({
        heightDelta: difference,
        viewportWidthChanged: widthMoved,
        conversationOpening: opening && isPinnedRef.current,
      });
      if (delay <= 0) {
        if (mediaFollowTimer != null) {
          clearTimeout(mediaFollowTimer);
          mediaFollowTimer = null;
        }
        followIfPinned();
      } else if (mediaFollowTimer == null) {
        // Follow once immediately, then keep one trailing follow for a resize storm.
        // Do not reset the timer on every frame or continuous body growth can starve it.
        followIfPinned();
        mediaFollowTimer = setTimeout(() => {
          mediaFollowTimer = null;
          followIfPinned();
        }, delay);
      }

      previousHeight = height;
    };

    const measureContentHeight = () => {
      const content = contentRef.current ?? el.firstElementChild;
      if (content instanceof HTMLElement) return content.offsetHeight;
      return el.scrollHeight;
    };

    const scheduleMeasure = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        onHeightChange(measureContentHeight());
      });
    };

    const content = contentRef.current ?? el.firstElementChild;
    const ro = new ResizeObserver((entries) => {
      // Arm collapse recovery before the rAF measurement so the browser's
      // first clamp event cannot outrun the recovery window.
      const contentEntry = entries.find((entry) => entry.target === content);
      const contentHeight = contentEntry?.contentRect.height;
      if (
        contentHeight != null &&
        previousHeight != null &&
        contentHeight < previousHeight - STICK_HEIGHT_NOISE_PX &&
        isPinnedRef.current &&
        !escapedRef.current
      ) {
        collapseRecoveryUntilRef.current =
          stickNowMs() + STICK_COLLAPSE_RECOVERY_MS;
      }

      // Coalesce multi-node notifications to one frame. Always read the
      // content column height from the DOM — viewport RO entries report
      // client box size, which is not what we want for grow/shrink.
      let viewportResized = false;
      for (const entry of entries) {
        if (entry.target !== el) continue;
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (
          previousViewportWidth != null &&
          Math.abs(w - previousViewportWidth) >= 0.5
        ) {
          viewportWidthChanged = true;
          viewportResized = true;
        }
        if (
          previousViewportHeight != null &&
          Math.abs(h - previousViewportHeight) >= 0.5
        ) {
          viewportResized = true;
        }
        previousViewportWidth = w;
        previousViewportHeight = h;
      }
      if (viewportResized && chatViewportTraceEnabled()) {
        // Guarded so a production resize drag pays no extra layout reads for a
        // payload it will never record.
        traceViewport("viewport-size", {
          width: Math.round(el.clientWidth),
          height: Math.round(el.clientHeight),
          scrollTop: Math.round(el.scrollTop),
          pinned: isPinnedRef.current,
          escaped: escapedRef.current,
        });
      }

      // A viewport resize reflows the column and changes the usable height, so
      // the invariant must be re-asserted on this frame, not the next one
      // (pinned → the new content end, escaped → the anchor's position).
      //
      // Both this and the content-decode case below go through the frame latch:
      // one callback still restores once, and `scheduleRestore` runs
      // `restoreNow` synchronously on its first call, so the restore is still
      // before paint.
      if (viewportResized) {
        scheduleRestore();
      }

      if (contentHeight != null) {
        const contentChanged =
          previousContentHeight == null ||
          Math.abs(contentHeight - previousContentHeight) >= 0.5;
        previousContentHeight = contentHeight;
        // A media element finishing decode takes its rendered height without a
        // DOM mutation carrying the new size, so the MutationObserver cannot see
        // it; only this content-box change reports it. While escaped the anchor
        // must hold.
        if (contentChanged && escapedRef.current) {
          scheduleRestore();
        }
      }

      scheduleMeasure();
    });

    /**
     * Collapse / reflow changes the DOM in one task; the ResizeObserver
     * callback that re-asserts the position runs a frame later, so the shifted
     * frame is painted. Mutation callbacks run as microtasks in the same task,
     * so the first restore lands before that paint — pinned returns to the end,
     * escaped holds the anchor — and `scheduleRestore` coalesces the rest of
     * the frame's mutations into it.
     */
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (readViewportOcclusion(el).occluded) return;
            scheduleRestore();
          })
        : null;
    if (content && mo) {
      mo.observe(content, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }

    if (content) ro.observe(content);
    // Viewport size changes (window / stage chrome) also need a re-follow.
    ro.observe(el);

    let occlusion = readViewportOcclusion(el);

    /**
     * Re-assert the invariant on the first frame the window is available again
     * (C5). `regainedFocus` marks a focus event, which is the boundary for an
     * occlusion that happened while the window was blurred.
     */
    const restoreAfterOcclusion = (regainedFocus: boolean) => {
      const v = viewportRef.current;
      if (!v) return;
      const next = readViewportOcclusion(v);
      if (next.occluded !== occlusion.occluded) {
        traceOcclusion({
          state: next.occluded ? "enter" : "exit",
          cause: next.occluded ? next.cause : occlusion.cause,
          clientHeight: v.clientHeight,
          pinned: isPinnedRef.current,
          escaped: escapedRef.current,
        });
      }
      const restore = shouldRestoreAfterOcclusion({
        wasOccluded: occlusion.occluded,
        occluded: next.occluded,
        regainedFocus,
      });
      occlusion = next;
      if (!restore) return;
      // Pinned → the content end; escaped → the anchor's recorded on-screen
      // position. restoreNow applies exactly that for the current phase.
      restoreNow();
      lastScrollTopRef.current = v.scrollTop;
      lastScrollHeightRef.current = v.scrollHeight;
    };

    const onVisibility = () => {
      // Synchronous attempt (still before the next paint), then once more in
      // the first frame: a window that was minimized can report a collapsed
      // scroller at the synchronous read, and only the rAF sees the real one.
      restoreAfterOcclusion(false);
      requestAnimationFrame(() => restoreAfterOcclusion(false));
    };
    const onFocus = () => restoreAfterOcclusion(true);

    // Host-reported occlusion (macOS): the only signal for "completely covered
    // by another app", where Page Visibility stays visible and focus may not
    // change. The event payload crosses a process boundary, so it is parsed,
    // not trusted; a malformed payload is ignored and the state is kept.
    let hostListenerDisposed = false;
    let unlistenHostOcclusion: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<unknown>(CHAT_VIEWPORT_OCCLUSION_EVENT, (event) => {
          const covered = parseHostOcclusionPayload(event.payload);
          if (covered == null) return;
          hostOccludedRef.current = covered;
          restoreAfterOcclusion(false);
        }),
      )
      .then((unlisten) => {
        if (hostListenerDisposed) unlisten();
        else unlistenHostOcclusion = unlisten;
      })
      .catch(() => {
        // Not under Tauri (browser / tests): Page Visibility and focus still
        // cover the hidden case; only the covered case is host-reported.
      });

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (mediaFollowTimer != null) clearTimeout(mediaFollowTimer);
      mo?.disconnect();
      ro.disconnect();
      hostListenerDisposed = true;
      unlistenHostOcclusion?.();
      cancelFrameSchedule(restoreLatchRef.current);
      restoreScheduledRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [
    enabled,
    conversationKey,
    applyDirective,
    applyScrollTop,
    commitState,
    followIfPinned,
    readViewportOcclusion,
    restoreNow,
    scheduleRestore,
  ]);

  /**
   * Handle other transcript writers use. The resident list reports row heights
   * and layout batches; the rail / find jumps assign positions. Both funnel
   * into the single write point above.
   */
  const controller = useMemo<ChatViewportControllerHandle>(
    () => ({
      assign,
      ledger() {
        return ledgerRef.current;
      },
      reportRowHeight(index, height, generation) {
        const ledger = ledgerRef.current;
        if (index >= ledger.rowCount()) ledger.setCount(index + 1);
        ledger.setRowHeight(index, height, "measured", generation);
      },
      reestimateRow(index, height, isRich) {
        if (isRich(index)) return;
        ledgerRef.current.reestimateRow(index, height);
      },
      resetLedger() {
        ledgerRef.current = createLayoutLedger({
          count: 0,
          estimateHeight: LEDGER_FALLBACK_ESTIMATE_PX,
        });
      },
      restoreLayout() {
        restoreNow();
      },
      subscribePosition(listener) {
        const listeners = positionListenersRef.current;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      escape(reason) {
        beginEscape(reason);
      },
      jumpTo(source, target) {
        const el = viewportRef.current;
        if (!el) return;
        // One geometry read backs the whole decision (planJump and the pin-flip
        // trace); the landing write then reads only what it needs.
        const geometry = readGeometry();
        if (!geometry) return;
        const decision = planJump({ target, geometry });
        if (decision.kind === "end") {
          // The landing is the content end (the target is the last row, or its
          // position clamps to the bottom): the reader is at the tail, so follow
          // re-engages instead of holding an escaped anchor there.
          scrollToBottom(
            "instant",
            target.kind === "end" ? `${source}:tail` : `${source}:end`,
          );
          return;
        }
        beginEscape(source, geometry);
        applyScrollTop(decision.top, source);
        // The landing is the anchor: capture it now so a later height change
        // above restores it instead of displacing the landed message.
        captureEscapeAnchor();
      },
      pinToEnd(source, behavior = "instant") {
        scrollToBottom(behavior, source);
      },
    }),
    [
      applyScrollTop,
      assign,
      beginEscape,
      captureEscapeAnchor,
      readGeometry,
      restoreNow,
      scrollToBottom,
    ],
  );

  return {
    viewportRef,
    contentRef,
    onScroll,
    scrollToBottom,
    isPinnedRef,
    escapedRef,
    showBack: showBackRef.current,
    subscribeShowBack,
    anchorRef: escapedAnchorRef,
    controller,
  };
}
