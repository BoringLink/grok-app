/**
 * DEV-only probe that watches the chat viewport and records a cause chain when
 * the viewport moves to an OLDER message while the chat is still following the
 * tail (see `src/lib/chatViewportTrace.ts`).
 *
 * The captured chain is published on `window.__CHAT_VIEWPORT_TRACE__` and, when
 * running under Tauri, appended to the Host log (`logs/app.log.<day>`) through
 * the `chat_viewport_trace` command — so a reproduction can be read from disk
 * instead of copied out of devtools.
 *
 * Sampling runs on rAF plus a timer fallback: WebKit throttles rAF in a
 * background window, and the heartbeat exists so a capture that finds nothing
 * can be told apart from a probe that never sampled.
 *
 * Cost when disabled: one cached boolean check, no rAF loop, no listeners.
 */

import { useEffect, type RefObject } from "react";
import {
  chatViewportTraceEnabled,
  dumpChatViewportTrace,
  isBackwardViewportMove,
  isSuspiciousUpwardJump,
  publishTraceToHost,
  setChatViewportTracePinned,
  traceViewport,
} from "@/lib/chatViewportTrace";

/** A real gesture within this window means the move was the user's, not a bug. */
const GESTURE_WINDOW_MS = 400;
/** Below this, geometry churn is measurement noise, not a viewport move. */
const GEOMETRY_EPSILON_PX = 4;
/**
 * Minimum spacing between published dumps. A viewport that oscillates would
 * otherwise publish once per frame and drown the log line it needs to be found
 * in; the events in between are still recorded for the next dump.
 */
const DUMP_COOLDOWN_MS = 1500;
/**
 * Compact status publish. Without it a capture that finds nothing is ambiguous:
 * "the viewport never moved" and "the probe never sampled" look identical from
 * the log. Carries visibility, because a background window throttles rAF.
 */
const HEARTBEAT_MS = 10_000;
/** Sampling cadence for throttled / background windows. */
const FALLBACK_SAMPLE_MS = 1000;

function firstVisibleRowIndex(
  viewport: HTMLElement,
  content: HTMLElement | null,
): number | null {
  const root = content ?? viewport;
  const rows = root.querySelectorAll<HTMLElement>("[data-virt-index]");
  if (rows.length === 0) return null;
  const viewTop = viewport.getBoundingClientRect().top;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewTop) {
      const raw = row.dataset.virtIndex;
      const index = raw == null ? Number.NaN : Number(raw);
      return Number.isFinite(index) ? index : null;
    }
  }
  return null;
}

export function useChatViewportTraceProbe(input: {
  viewportRef: RefObject<HTMLElement | null>;
  isPinnedRef: RefObject<boolean>;
  contentRef?: RefObject<HTMLElement | null>;
}): void {
  const { viewportRef, isPinnedRef, contentRef } = input;

  useEffect(() => {
    if (!chatViewportTraceEnabled()) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    let raf = 0;
    let lastGestureAt = 0;
    let lastDumpAt = Number.NEGATIVE_INFINITY;
    let prevIndex: number | null = null;
    let prevScrollTop = viewport.scrollTop;
    let prevScrollHeight = viewport.scrollHeight;
    let prevPinned = isPinnedRef.current;
    let lastDTop = 0;
    let lastDHeight = 0;
    let sampled = 0;
    let backwardCount = 0;
    let cancelled = false;
    /**
     * DOM mutations counted since mount. A viewport move with no mutation in
     * the same frame cannot be a content reflow, so it must be an external
     * scroll operation (`scrollIntoView`, focus, browser adjustment) — the
     * discriminator this trace needed.
     */
    let mutations = 0;
    let prevMutations = 0;

    const geometry = () => ({
      rows: contentRef?.current
        ? contentRef.current.querySelectorAll("[data-virt-index]").length
        : 0,
      index: prevIndex,
      scrollTop: Math.round(viewport.scrollTop),
      scrollHeight: Math.round(viewport.scrollHeight),
      clientHeight: Math.round(viewport.clientHeight),
      pinned: !!isPinnedRef.current,
      hidden: typeof document !== "undefined" ? document.hidden : null,
      visibility:
        typeof document !== "undefined" ? document.visibilityState : null,
    });

    const publish = (reason: string, force: boolean) => {
      const now = performance.now();
      if (!force && now - lastDumpAt < DUMP_COOLDOWN_MS) return;
      lastDumpAt = now;
      void publishTraceToHost(dumpChatViewportTrace(reason));
    };

    // Manual flush for devtools use, e.g. after an episode ends.
    const manualDump = () => publish("manual", true);
    (window as unknown as { __CHAT_VIEWPORT_DUMP__?: () => void })
      .__CHAT_VIEWPORT_DUMP__ = manualDump;

    const onGesture = () => {
      lastGestureAt = performance.now();
    };

    /** One sample of the viewport; records only when something changed. */
    const takeSample = () => {
      if (cancelled) return;
      const pinned = !!isPinnedRef.current;
      setChatViewportTracePinned(pinned);
      const scrollTop = viewport.scrollTop;
      const scrollHeight = viewport.scrollHeight;
      const clientHeight = viewport.clientHeight;
      const index = firstVisibleRowIndex(viewport, contentRef?.current ?? null);
      const dTop = scrollTop - prevScrollTop;
      const dHeight = scrollHeight - prevScrollHeight;
      const dMutations = mutations - prevMutations;
      const gestureRecent = performance.now() - lastGestureAt < GESTURE_WINDOW_MS;

      const moved =
        index !== prevIndex ||
        pinned !== prevPinned ||
        Math.abs(dTop) >= GEOMETRY_EPSILON_PX ||
        Math.abs(dHeight) >= GEOMETRY_EPSILON_PX;

      if (moved) {
        lastDTop = dTop;
        lastDHeight = dHeight;
        sampled += 1;
        traceViewport("sample", {
          index,
          prevIndex,
          scrollTop: Math.round(scrollTop),
          scrollHeight: Math.round(scrollHeight),
          clientHeight: Math.round(clientHeight),
          dTop: Math.round(dTop),
          dHeight: Math.round(dHeight),
          dMutations,
          pinned,
          gestureRecent,
        });
      }

      if (
        isBackwardViewportMove({
          pinned,
          escaped: false,
          userGestureRecent: gestureRecent,
          previousIndex: prevIndex,
          index,
        }) ||
        isSuspiciousUpwardJump({ userGestureRecent: gestureRecent, deltaTop: dTop })
      ) {
        const backward = index !== null && prevIndex !== null && index < prevIndex;
        if (backward) backwardCount += 1;
        traceViewport(backward ? "backward" : "upward-jump", {
          fromIndex: prevIndex,
          toIndex: index,
          dTop: Math.round(dTop),
          dMutations,
          mutations,
          scrollTop: Math.round(scrollTop),
          scrollHeight: Math.round(scrollHeight),
          clientHeight: Math.round(clientHeight),
          distFromBottom: Math.round(scrollHeight - clientHeight - scrollTop),
          pinned,
          gestureRecent,
        });
        // The chain matters more than later samples: publish now (rate limited).
        publish(
          backward ? "viewport-moved-to-older-message" : "viewport-jumped-up",
          false,
        );
      }

      prevIndex = index;
      prevScrollTop = scrollTop;
      prevScrollHeight = scrollHeight;
      prevPinned = pinned;
      prevMutations = mutations;
    };

    const frame = () => {
      if (cancelled) return;
      takeSample();
      raf = requestAnimationFrame(frame);
    };

    const mutationObserver = new MutationObserver(() => {
      mutations += 1;
    });
    mutationObserver.observe(contentRef?.current ?? viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    viewport.addEventListener("wheel", onGesture, { passive: true });
    viewport.addEventListener("touchmove", onGesture, { passive: true });
    viewport.addEventListener("pointerdown", onGesture, { passive: true });
    raf = requestAnimationFrame(frame);

    // Timer fallback: rAF is throttled in a background window, timers are not
    // (as aggressively), so a capture still yields samples while unfocused.
    const fallback = window.setInterval(takeSample, FALLBACK_SAMPLE_MS);

    // Baseline: proves the console → Host → log channel works, and records the
    // geometry at mount.
    const startTimer = window.setTimeout(() => {
      traceViewport("start", geometry());
      publish("trace-start", false);
    }, 2000);

    const heartbeat = window.setInterval(() => {
      void publishTraceToHost({
        reason: "heartbeat",
        ...geometry(),
        sampled,
        mutations,
        backward: backwardCount,
        lastDTop: Math.round(lastDTop),
        lastDHeight: Math.round(lastDHeight),
        gestureMsAgo:
          lastGestureAt === 0 ? null : Math.round(performance.now() - lastGestureAt),
      });
    }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.clearInterval(fallback);
      window.clearInterval(heartbeat);
      mutationObserver.disconnect();
      cancelAnimationFrame(raf);
      viewport.removeEventListener("wheel", onGesture);
      viewport.removeEventListener("touchmove", onGesture);
      viewport.removeEventListener("pointerdown", onGesture);
      const host = window as unknown as { __CHAT_VIEWPORT_DUMP__?: () => void };
      if (host.__CHAT_VIEWPORT_DUMP__ === manualDump) {
        delete host.__CHAT_VIEWPORT_DUMP__;
      }
    };
  }, [viewportRef, isPinnedRef, contentRef]);
}
