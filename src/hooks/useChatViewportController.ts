/**
 * Keep a scroll viewport pinned to the bottom while the user is following,
 * and release pin after they scroll up (wheel / touch / scrollbar).
 *
 * Pin model mirrors use-stick-to-bottom's escapedFromLock:
 * - User scroll-up escapes; we do NOT re-pin merely because they are still
 *   within the near-bottom threshold (that thrash is what causes bounce).
 * - Re-pin only after they scroll down again and land on the absolute
 *   bottom, or after force-stick / conversation switch.
 * - Programmatic follows are instant and ignored by the scroll handler so
 *   resize + stream growth cannot fight the user mid-gesture.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
  type UIEvent,
} from "react";
import {
  STICK_ESCAPE_MIN_DELTA_PX,
  STICK_ESCAPE_WHEEL_DELTA,
  STICK_BOTTOM_REBOUND_INTENT_MS,
  STICK_BOTTOM_REBOUND_SETTLE_MS,
  STICK_COLLAPSE_RECOVERY_MS,
  STICK_HEIGHT_NOISE_PX,
  STICK_OPEN_FOLLOW_MS,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  bottomScrollTop,
  isConversationOpenFollowActive,
  isHardBottom,
  isHeightDeltaNoise,
  isNearBottom,
  nextStickPinState,
  pinnedFollowDelayForLayout,
  isStickViewportUnreliable,
  shouldClampPinnedOverscroll,
  shouldClampPinnedStreamDrift,
  shouldEscapePinnedScroll,
  shouldIgnorePinnedGrowthRebound,
  shouldIgnorePinnedLayoutScroll,
  shouldIgnoreProgrammaticStickLeave,
  shouldPreventPinnedBottomWheel,
  shouldRestorePinnedFollowOnViewportReady,
  shouldSettleBottomRebound,
  takeProgrammaticStickScroll,
} from "@/lib/stickToBottom";
import {
  applyScrollTopTraced,
  tracePinState,
  traceViewport,
} from "@/lib/chatViewportTrace";


export type UseStickToBottomOptions = {
  /** Re-pin when the conversation identity changes (session / first message). */
  conversationKey?: string | number | null;
  /** Force re-pin (e.g. user just sent a message). */
  forceStickKey?: string | number | null;
  /** px from bottom still considered "near" for re-engage. Default 100. */
  thresholdPx?: number;
  enabled?: boolean;
};

export type UseStickToBottomResult = {
  viewportRef: RefObject<HTMLDivElement | null>;
  /** Optional: attach to the content column for more accurate resize observe. */
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** True while auto-follow is active (ref, not reactive). */
  isPinnedRef: RefObject<boolean>;
  /** True after an explicit user scroll-up until the tail is re-engaged. */
  escapedRef: RefObject<boolean>;
  /** Reactive: show "back to bottom" control when user has scrolled up. */
  showBack: boolean;
  /** Fine-grained subscription for BackBottom button to avoid parent component re-renders. */
  subscribeShowBack: (cb: (val: boolean) => void) => () => void;
};

/**
 * A scroll event within this window of a real gesture is the user's own move.
 * Collapse clamps never have one, so they cannot release the pin.
 */
const GESTURE_ESCAPE_WINDOW_MS = 400;

function stickNowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function useStickToBottom(
  options: UseStickToBottomOptions = {},
): UseStickToBottomResult {
  const {
    conversationKey = null,
    forceStickKey = null,
    thresholdPx = STICK_TO_BOTTOM_THRESHOLD_PX,
    enabled = true,
  } = options;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** Auto-follow stream / growth. */
  const isPinnedRef = useRef(true);
  /**
   * User intentionally left the bottom. Stays true until they scroll down
   * (or force-stick). Prevents re-pin while still inside the near threshold.
   */
  const escapedRef = useRef(false);
  /**
   * Last intentional user gesture toward latest content. Cleared on scroll-up.
   * Used with hardBottom so landing at max scrollTop re-pins even when the
   * final scroll event has no positive delta.
   */
  const userIntentDownRef = useRef(false);
  /** Recent real wheel/touch intent toward the tail; survives elastic rebound. */
  const bottomIntentUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  /** scrollTop we just wrote — used to ignore synthetic scroll events. */
  const ignoreScrollTopRef = useRef<number | undefined>(undefined);
  /** Non-zero while a content resize is being applied (race with scroll). */
  const resizeDifferenceRef = useRef(0);
  /**
   * Collapse can produce multiple synthetic upward scroll events: browser
   * clamp first, virtual-window correction second. Keep pin through both.
   */
  const collapseRecoveryUntilRef = useRef(0);
  /**
   * Last real user gesture (wheel / touch / keyboard) on the viewport. A
   * scroll that no gesture can explain is layout, so it must not release the
   * pin: only a gesture, or a run of upward events at a *stable* height,
   * counts as the user walking into history. Negative sentinel: before the
   * first gesture, `now - last` must never look like a fresh gesture.
   */
  const lastGestureAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** Consecutive upward scroll events that happened at an unchanged height. */
  const upStreakRef = useRef({ count: 0, at: 0 });
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
    userIntentDownRef.current = false;
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
  const scrollDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const applyScrollTop = useCallback((top: number) => {
    const el = viewportRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - top) < 1) {
      ignoreScrollTopRef.current = el.scrollTop;
      return;
    }
    // Force instant assignment even if CSS scroll-behavior is smooth.
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    applyScrollTopTraced("stick:applyScrollTop", el, top);
    ignoreScrollTopRef.current = el.scrollTop;
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    if (prev) el.style.scrollBehavior = prev;
    else el.style.removeProperty("scroll-behavior");
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "instant") => {
      const el = viewportRef.current;
      if (!el) return;
      const pinnedBefore = isPinnedRef.current;
      if (scrollDebounceTimerRef.current != null) {
        clearTimeout(scrollDebounceTimerRef.current);
        scrollDebounceTimerRef.current = null;
      }
      const now = stickNowMs();
      programmaticFollowUntilRef.current =
        behavior === "smooth" ? now + 800 : 0;
      escapedRef.current = false;
      isPinnedRef.current = true;
      userIntentDownRef.current = false;
      const top = bottomScrollTop(el.scrollHeight, el.clientHeight);
      traceViewport("scroll-to-bottom", {
        behavior,
        scrollTop: Math.round(el.scrollTop),
        targetTop: Math.round(top),
        scrollHeight: Math.round(el.scrollHeight),
        clientHeight: Math.round(el.clientHeight),
        pinnedBefore,
      });
      if (behavior === "smooth" && typeof el.scrollTo === "function") {
        // Smooth is only for the explicit "back to bottom" button.
        // Mark ignore with the target so intermediate events don't re-escape.
        ignoreScrollTopRef.current = top;
        el.scrollTo({ top, behavior: "smooth" });
        // Snap pin state; showBack clears once we land near bottom via scroll.
        const start = performance.now();
        const tick = () => {
          if (
            !viewportRef.current ||
            !isPinnedRef.current ||
            escapedRef.current
          ) {
            return;
          }
          const near = isNearBottom(
            viewportRef.current.scrollTop,
            viewportRef.current.scrollHeight,
            viewportRef.current.clientHeight,
            thresholdRef.current,
          );
          if (near || performance.now() - start > 600) {
            applyScrollTop(
              bottomScrollTop(
                viewportRef.current.scrollHeight,
                viewportRef.current.clientHeight,
              ),
            );
            isPinnedRef.current = true;
            escapedRef.current = false;
            syncShowBack();
            return;
          }
          if (!isPinnedRef.current || escapedRef.current) return;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } else {
        applyScrollTop(top);
      }
      syncShowBack();
    },
    [applyScrollTop, syncShowBack],
  );

  const followIfPinned = useCallback(() => {
    if (!isPinnedRef.current || !enabledRef.current) return;
    const el = viewportRef.current;
    if (!el) return;
    if (
      isStickViewportUnreliable({
        clientHeight: el.clientHeight,
        hidden: typeof document !== "undefined" && document.hidden,
      })
    ) {
      return;
    }
    applyScrollTop(bottomScrollTop(el.scrollHeight, el.clientHeight));
  }, [applyScrollTop]);

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

    let bottomReboundTimer: ReturnType<typeof setTimeout> | null = null;
    const clearBottomRebound = () => {
      bottomIntentUntilRef.current = 0;
      if (bottomReboundTimer != null) {
        clearTimeout(bottomReboundTimer);
        bottomReboundTimer = null;
      }
    };
    const armBottomIntent = () => {
      bottomIntentUntilRef.current =
        stickNowMs() + STICK_BOTTOM_REBOUND_INTENT_MS;
    };
    const scheduleBottomReboundSettle = () => {
      if (bottomReboundTimer != null) clearTimeout(bottomReboundTimer);
      bottomReboundTimer = setTimeout(() => {
        bottomReboundTimer = null;
        const v = viewportRef.current;
        if (!v || stickNowMs() > bottomIntentUntilRef.current) return;
        if (
          !isNearBottom(
            v.scrollTop,
            v.scrollHeight,
            v.clientHeight,
            thresholdRef.current,
          )
        ) {
          return;
        }
        escapedRef.current = false;
        isPinnedRef.current = true;
        userIntentDownRef.current = false;
        bottomIntentUntilRef.current = 0;
        tracePinState({
          reason: "bottom-rebound",
          pinned: true,
          escaped: false,
          scrollTop: v.scrollTop,
          scrollHeight: v.scrollHeight,
          clientHeight: v.clientHeight,
        });
        applyScrollTop(bottomScrollTop(v.scrollHeight, v.clientHeight));
        syncShowBack();
      }, STICK_BOTTOM_REBOUND_SETTLE_MS);
    };

    const handleScroll = () => {
      const scrollTop = el.scrollTop;
      const programmaticFollowActive =
        stickNowMs() < programmaticFollowUntilRef.current;
      if (
        isStickViewportUnreliable({
          clientHeight: el.clientHeight,
          hidden: typeof document !== "undefined" && document.hidden,
        })
      ) {
        if (programmaticFollowActive) {
          isPinnedRef.current = true;
          escapedRef.current = false;
        }
        lastScrollTopRef.current = scrollTop;
        lastScrollHeightRef.current = el.scrollHeight;
        ignoreScrollTopRef.current = undefined;
        return;
      }
      let lastScrollTop = lastScrollTopRef.current;
      const lastScrollHeight = lastScrollHeightRef.current;
      const ignore =
        ignoreScrollTopRef.current ?? takeProgrammaticStickScroll(el);
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
      ignoreScrollTopRef.current = undefined;

      // Ignore only the synthetic event that actually landed on the written
      // position. A smooth follow stores its target before the animation; an
      // unrelated keyboard or scrollbar scroll must still reach escape logic.
      const landedOnIgnoredTop =
        ignore != null && Math.abs(scrollTop - ignore) < 0.5;
      // Follow / virtual pin-snap wrote scrollTop. That is not a user leave.
      // Using ignore as previousScrollTop used to invent a 10px+ "scroll-up"
      // and drop pin for the rest of the stream.
      if (shouldIgnoreProgrammaticStickLeave(landedOnIgnoredTop ? ignore : undefined)) {
        if (
          isPinnedRef.current &&
          !escapedRef.current &&
          shouldClampPinnedOverscroll(
            scrollTop,
            bottomScrollTop(el.scrollHeight, el.clientHeight),
          )
        ) {
          applyScrollTop(bottomScrollTop(el.scrollHeight, el.clientHeight));
        }
        return;
      }

      const maxTop = bottomScrollTop(el.scrollHeight, el.clientHeight);
      const isMovingUp = scrollTop < lastScrollTop - 0.5;

      // A prior intentional down-gesture (wheel/touch) armed bottom intent.
      // The elastic upward move that follows must settle to the new tail, not
      // be treated as a user escape. Only a move that is NOT a down-intent
      // settle reaches the escape logic below.
      const bottomRebound = shouldSettleBottomRebound({
        downIntentActive: stickNowMs() <= bottomIntentUntilRef.current,
        scrollTop,
        previousScrollTop: lastScrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        thresholdPx: thresholdRef.current,
      });
      if (bottomRebound) {
        if (scrollDebounceTimerRef.current != null) {
          clearTimeout(scrollDebounceTimerRef.current);
          scrollDebounceTimerRef.current = null;
        }
        scheduleBottomReboundSettle();
        return;
      }

      const shouldEscapeStick = shouldEscapePinnedScroll({
        pinned: isPinnedRef.current,
        escaped: escapedRef.current,
        scrollTop,
        previousScrollTop: lastScrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        previousScrollHeight:
          lastScrollHeight > 0 ? lastScrollHeight : undefined,
      });

      // Layout clamp vs. the user walking into history. A collapse clamps
      // scrollTop in the same layout pass that changed the height, so the move
      // is upward with a changed (or reverted) height and no gesture. Only a
      // gesture, or a run of upward events at an unchanged height, is the user.
      const gestureRecent =
        stickNowMs() - lastGestureAtRef.current < GESTURE_ESCAPE_WINDOW_MS;
      const heightStable = Math.abs(el.scrollHeight - lastScrollHeight) < 0.5;
      if (shouldEscapeStick && !gestureRecent && heightStable) {
        const now = stickNowMs();
        const streak =
          now - upStreakRef.current.at < GESTURE_ESCAPE_WINDOW_MS
            ? upStreakRef.current.count + 1
            : 1;
        upStreakRef.current = { count: streak, at: now };
      } else if (!isMovingUp) {
        upStreakRef.current = { count: 0, at: 0 };
      }
      const userWalked =
        gestureRecent ||
        (shouldEscapeStick && upStreakRef.current.count >= 2);

      // A real gesture (wheel / touch / key) or repeated upward scrolling at a
      // stable height is the user walking into history. Keyboard scrolling and
      // scrollbar drag land in those two cases; every other upward move is the
      // browser clamping scrollTop for a layout change.
      if (shouldEscapeStick && userWalked) {
        programmaticFollowUntilRef.current = 0;
        userIntentDownRef.current = false;
        isPinnedRef.current = false;
        escapedRef.current = true;
        tracePinState({
          reason: "scroll-escape",
          pinned: false,
          escaped: true,
          scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
        syncShowBack();
        return;
      }

      if (shouldEscapeStick) {
        // Gesture-free upward move: the browser clamped scrollTop after a
        // collapse. Hold the pin and put the viewport back on the tail.
        applyScrollTop(bottomScrollTop(el.scrollHeight, el.clientHeight));
        return;
      }

      if (programmaticFollowActive && !escapedRef.current) {
        isPinnedRef.current = true;
        return;
      }

      // A finished thought/tool phase may first trigger a browser clamp and
      // then a virtual-list anchor correction. Once the first event updates
      // lastScrollHeightRef, the second event no longer looks like a shrink;
      // keep it classified as layout recovery until the short window expires.
      if (
        shouldIgnorePinnedLayoutScroll({
          pinned: isPinnedRef.current,
          escaped: escapedRef.current,
          now: stickNowMs(),
          recoveryUntil: collapseRecoveryUntilRef.current,
        })
      ) {
        applyScrollTop(bottomScrollTop(el.scrollHeight, el.clientHeight));
        return;
      }

      // A content-growth reflow can produce a small native rebound after the
      // follow write. Preserve pin before the generic scroll-up escape path.
      if (
        shouldIgnorePinnedGrowthRebound({
          pinned: isPinnedRef.current,
          escaped: escapedRef.current,
          scrollTop,
          previousScrollTop: lastScrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          previousScrollHeight:
            lastScrollHeight > 0 ? lastScrollHeight : undefined,
          thresholdPx: thresholdRef.current,
        })
      ) {
        applyScrollTop(bottomScrollTop(el.scrollHeight, el.clientHeight));
        return;
      }

      const meaningfulDown =
        scrollTop - lastScrollTop >= STICK_ESCAPE_MIN_DELTA_PX;

      // While locked at bottom: only clamp positive overscroll past max.
      if (isPinnedRef.current && !escapedRef.current) {
        if (shouldClampPinnedOverscroll(scrollTop, maxTop)) {
          applyScrollTop(maxTop);
          return;
        }
        return;
      }

      if (isMovingUp) userIntentDownRef.current = false;
      if (meaningfulDown) userIntentDownRef.current = true;

      // ResizeObserver scroll races: suppress ambiguous resize-only events.
      // Never drop a clear scroll-down / intent-down hard-bottom landing —
      // those are how the user re-engages stick after reading history.
      // @see https://github.com/WICG/resize-observer/issues/25
      if (scrollDebounceTimerRef.current != null) {
        clearTimeout(scrollDebounceTimerRef.current);
      }
      scrollDebounceTimerRef.current = setTimeout(() => {
        scrollDebounceTimerRef.current = null;
        if (ignore != null && scrollTop === ignore) return;
        if (
          stickNowMs() < programmaticFollowUntilRef.current &&
          !escapedRef.current
        ) {
          isPinnedRef.current = true;
          syncShowBack();
          return;
        }

        // Still locked (e.g. no escape this frame)? Snap rubber-band only.
        if (isPinnedRef.current && !escapedRef.current) {
          const top = bottomScrollTop(el.scrollHeight, el.clientHeight);
          if (shouldClampPinnedOverscroll(el.scrollTop, top)) {
            applyScrollTop(top);
          }
          syncShowBack();
          return;
        }

        const near = isNearBottom(
          el.scrollTop,
          el.scrollHeight,
          el.clientHeight,
          thresholdRef.current,
        );
        const hard = isHardBottom(
          el.scrollTop,
          el.scrollHeight,
          el.clientHeight,
        );
        const intentDown = userIntentDownRef.current;
        const scrollingUp = isMovingUp;
        const scrollingDown = meaningfulDown;

        if (
          resizeDifferenceRef.current !== 0 &&
          !scrollingDown &&
          !(hard && intentDown)
        ) {
          return;
        }

        const previousPinned = isPinnedRef.current;
        const previousEscaped = escapedRef.current;
        const next = nextStickPinState(
          {
            pinned: previousPinned,
            escaped: previousEscaped,
          },
          {
            scrollingUp,
            scrollingDown,
            nearBottom: near,
            hardBottom: hard && !scrollingUp,
            userIntentDown: intentDown && !scrollingUp,
          },
        );
        isPinnedRef.current = next.pinned;
        escapedRef.current = next.escaped;
        if (
          next.pinned !== previousPinned ||
          next.escaped !== previousEscaped
        ) {
          tracePinState({
            reason: "scroll-state-transition",
            pinned: next.pinned,
            escaped: next.escaped,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }
        if (next.pinned) {
          userIntentDownRef.current = false;
          applyScrollTop(
            bottomScrollTop(el.scrollHeight, el.clientHeight),
          );
        }
        syncShowBack();
      }, 16);
    };

    const handleWheel = (e: WheelEvent) => {
      lastGestureAtRef.current = stickNowMs();
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
        // Still a downward intent: WebView may rubber-band anyway, and the
        // composer can grow during settle. Arm rebound snap to the new max.
        armBottomIntent();
        userIntentDownRef.current = true;
        e.preventDefault();
        return;
      }
      // Small ticks at the locked bottom (trackpad / elastic) — stay pinned.
      if (
        isPinnedRef.current &&
        !escapedRef.current &&
        Math.abs(e.deltaY) < STICK_ESCAPE_WHEEL_DELTA
      ) {
        return;
      }
      // deltaY < 0 → user reading history. Escape only on a clear gesture
      // so concurrent content-growth follow cannot yank the viewport back.
      if (
        e.deltaY <= -STICK_ESCAPE_WHEEL_DELTA &&
        el.scrollHeight > el.clientHeight
      ) {
        clearBottomRebound();
        programmaticFollowUntilRef.current = 0;
        userIntentDownRef.current = false;
        if (isPinnedRef.current) {
          escapedRef.current = true;
          isPinnedRef.current = false;
          tracePinState({
            reason: "wheel-escape",
            pinned: false,
            escaped: true,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
          syncShowBack();
        }
        return;
      }
      // deltaY > 0 → scrolling toward latest. Mark intent so a no-delta
      // hard-bottom landing (max scrollTop) still re-pins.
      if (e.deltaY >= STICK_ESCAPE_WHEEL_DELTA) {
        armBottomIntent();
        userIntentDownRef.current = true;
        if (escapedRef.current) {
          requestAnimationFrame(() => {
            if (!viewportRef.current) return;
            const v = viewportRef.current;
            // Hard bottom only — the 100px near band yanks back after a
            // trackpad escape and is the bottom-of-chat jitter.
            if (
              isHardBottom(v.scrollTop, v.scrollHeight, v.clientHeight)
            ) {
              escapedRef.current = false;
              isPinnedRef.current = true;
              userIntentDownRef.current = false;
              tracePinState({
                reason: "wheel-repin",
                pinned: true,
                escaped: false,
                scrollTop: v.scrollTop,
                scrollHeight: v.scrollHeight,
                clientHeight: v.clientHeight,
              });
              applyScrollTop(
                bottomScrollTop(v.scrollHeight, v.clientHeight),
              );
              syncShowBack();
            }
          });
        }
      }
    };

    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      lastGestureAtRef.current = stickNowMs();
      const y = e.touches[0]?.clientY;
      if (touchY == null || y == null) return;
      const dy = y - touchY;
      // Finger moves down → content moves up (reading history).
      // Require a clear drag so a light touch at the locked bottom does not
      // unstick and then snap back (bounce + flash).
      if (dy > STICK_ESCAPE_MIN_DELTA_PX) {
        clearBottomRebound();
        programmaticFollowUntilRef.current = 0;
        userIntentDownRef.current = false;
        if (isPinnedRef.current) {
          escapedRef.current = true;
          isPinnedRef.current = false;
          tracePinState({
            reason: "touch-escape",
            pinned: false,
            escaped: true,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
          syncShowBack();
        }
      } else if (dy < -STICK_ESCAPE_MIN_DELTA_PX) {
        // Finger moves up → content moves down (toward latest)
        armBottomIntent();
        userIntentDownRef.current = true;
      }
      touchY = y;
    };
    const onTouchEnd = () => {
      touchY = null;
      // After a fling toward latest, re-pin only if we settled on the end.
      if (userIntentDownRef.current && escapedRef.current) {
        requestAnimationFrame(() => {
          if (!viewportRef.current) return;
          const v = viewportRef.current;
          if (isHardBottom(v.scrollTop, v.scrollHeight, v.clientHeight)) {
            escapedRef.current = false;
            isPinnedRef.current = true;
            userIntentDownRef.current = false;
            tracePinState({
              reason: "touch-repin",
              pinned: true,
              escaped: false,
              scrollTop: v.scrollTop,
              scrollHeight: v.scrollHeight,
              clientHeight: v.clientHeight,
            });
            syncShowBack();
          }
        });
      }
    };

    const onKeyScroll = (e: KeyboardEvent) => {
      if (
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === " " ||
        e.key === "Spacebar"
      ) {
        lastGestureAtRef.current = stickNowMs();
      }
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
      if (scrollDebounceTimerRef.current != null) {
        clearTimeout(scrollDebounceTimerRef.current);
        scrollDebounceTimerRef.current = null;
      }
      if (bottomReboundTimer != null) {
        clearTimeout(bottomReboundTimer);
        bottomReboundTimer = null;
      }
    };
  }, [enabled, conversationKey, syncShowBack, applyScrollTop]);

  // Conversation switch → re-pin and jump to bottom before paint so the
  // virtual list's layout effect sees pin=true (otherwise it windows from
  // leftover scrollTop / the previous chat's browse range). Extra frames +
  // a short follow window cover journal hydrate and image/PDF decode.
  useLayoutEffect(() => {
    if (!enabled) return;
    escapedRef.current = false;
    isPinnedRef.current = true;
    userIntentDownRef.current = false;
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
  }, [conversationKey, enabled, scrollToBottom]);

  // User sent / turn became busy → force follow even if they had scrolled up.
  // Layout first so the virtual list's itemCount effect sees pin=true in the
  // same frame (avoids a browse-window flash, then a snap). One rAF covers
  // the new bubble height that is not measured until after paint.
  useLayoutEffect(() => {
    if (!enabled || forceStickKey == null || forceStickKey === "") return;
    escapedRef.current = false;
    isPinnedRef.current = true;
    userIntentDownRef.current = false;
    scrollToBottom("instant");
    const raf = requestAnimationFrame(() => scrollToBottom("instant"));
    return () => cancelAnimationFrame(raf);
  }, [forceStickKey, enabled, scrollToBottom]);

  // Content growth / shrink while pinned.
  useEffect(() => {
    if (!enabled) return;
    const el = viewportRef.current;
    if (!el) return;

    let previousHeight: number | undefined;
    let previousViewportWidth: number | undefined = el.clientWidth;
    let viewportWidthChanged = false;
    let raf = 0;
    let mediaFollowTimer: ReturnType<typeof setTimeout> | null = null;

    const onHeightChange = (height: number) => {
      if (
        isStickViewportUnreliable({
          clientHeight: el.clientHeight,
          hidden: typeof document !== "undefined" && document.hidden,
        })
      ) {
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
          applyScrollTop(bottomScrollTop(el.scrollHeight, el.clientHeight));
        }
        return;
      }
      resizeDifferenceRef.current = difference;
      if (difference < -0.5 && isPinnedRef.current && !escapedRef.current) {
        collapseRecoveryUntilRef.current =
          stickNowMs() + STICK_COLLAPSE_RECOVERY_MS;
      }

      // Browser can leave scrollTop past max after a shrink — clamp without
      // treating it as a user scroll (would thrash pin / jump to top).
      const maxTop = bottomScrollTop(el.scrollHeight, el.clientHeight);
      if (el.scrollTop > maxTop + 1) {
        applyScrollTop(maxTop);
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
      // browser clamp / virtual remeasure race (escaped stays false). If the
      // user is still parked on the absolute bottom, re-engage follow so the
      // rest of the stream keeps sticking. Intentional escape blocks this
      // (reading history is never yanked back down).
      if (
        !isPinnedRef.current &&
        !escapedRef.current &&
        isHardBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
      ) {
        isPinnedRef.current = true;
        tracePinState({
          reason: "height-change-repin",
          pinned: true,
          escaped: false,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
      }

      // Grow, shrink, or viewport-only resize: follow only while pinned.
      // Do NOT compensate scrollTop while escaped — stream growth is almost
      // always at the bottom; adding the full height delta would yank the
      // user down. Large jumps (image/PDF decode) wait so a storm of
      // screenshots is one snap, not one per file. Width interpolation
      // (aside / env gutter) must follow this frame or the column jumps
      // up until the motion ends, then snaps back.
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
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          if (resizeDifferenceRef.current === difference) {
            resizeDifferenceRef.current = 0;
          }
        }, 1);
      });
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
      for (const entry of entries) {
        if (entry.target !== el) continue;
        const w = entry.contentRect.width;
        if (
          previousViewportWidth != null &&
          Math.abs(w - previousViewportWidth) >= 0.5
        ) {
          viewportWidthChanged = true;
        }
        previousViewportWidth = w;
      }
      scheduleMeasure();
    });

    /**
     * Collapse / reflow changes the DOM in one task; the ResizeObserver
     * callback that re-asserts the bottom runs a frame later, so the shifted
     * frame is painted. Mutation callbacks run as microtasks in the same task,
     * which lands the compensating scrollTop write before that paint.
     */
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (!isPinnedRef.current || escapedRef.current) return;
            if (
              isStickViewportUnreliable({
                clientHeight: el.clientHeight,
                hidden: typeof document !== "undefined" && document.hidden,
              })
            ) {
              return;
            }
            applyScrollTop(bottomScrollTop(el.scrollHeight, el.clientHeight));
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

    let viewportWasUnreliable =
      typeof document !== "undefined" &&
      isStickViewportUnreliable({
        clientHeight: el.clientHeight,
        hidden: document.hidden,
      });

    const restoreAfterOcclusion = () => {
      const v = viewportRef.current;
      if (!v) return;
      const hidden = typeof document !== "undefined" && document.hidden;
      const unreliable = isStickViewportUnreliable({
        clientHeight: v.clientHeight,
        hidden,
      });
      if (
        shouldRestorePinnedFollowOnViewportReady({
          pinned: isPinnedRef.current,
          escaped: escapedRef.current,
          viewportWasUnreliable,
          viewportIsReliable: !unreliable,
        })
      ) {
        applyScrollTop(bottomScrollTop(v.scrollHeight, v.clientHeight));
        lastScrollTopRef.current = v.scrollTop;
        lastScrollHeightRef.current = v.scrollHeight;
      }
      viewportWasUnreliable = unreliable;
    };

    const onVisibility = () => {
      restoreAfterOcclusion();
      requestAnimationFrame(restoreAfterOcclusion);
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (mediaFollowTimer != null) clearTimeout(mediaFollowTimer);
      mo?.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [enabled, conversationKey, applyScrollTop, followIfPinned]);

  return {
    viewportRef,
    contentRef,
    onScroll,
    scrollToBottom,
    isPinnedRef,
    escapedRef,
    showBack: showBackRef.current,
    subscribeShowBack,
  };
}
