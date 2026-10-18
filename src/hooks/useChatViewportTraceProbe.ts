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
 * can be told apart from a probe that never sampled. The heartbeat also dumps
 * the recent per-frame samples (distance to the content end, visible-band
 * shift, write sources), which otherwise only leave the process on a trigger.
 *
 * Cost when disabled: one cached boolean check, no rAF loop, no listeners.
 */

import { useEffect, useRef, type RefObject } from "react";
import { distanceFromBottom } from "@/lib/stickToBottom";
import {
  anchorScreenShift,
  chatTraceSessionId,
  chatViewportTraceEnabled,
  chatViewportTraceEvents,
  chatViewportWriteStats,
  dumpChatViewportTrace,
  frameCostSummary,
  frameWriteSummary,
  isBackwardViewportMove,
  isSuspiciousUpwardJump,
  lastPinFlipCause,
  publishTraceToHost,
  setChatViewportTracePinned,
  traceViewport,
  viewportViolationSummary,
  visibleBandShift,
  type ViewportTraceEvent,
  type VisibleRowPosition,
} from "@/lib/chatViewportTrace";
import { VIEWPORT_ANCHOR_TOLERANCE_PX } from "@/lib/chatViewportController";
import type { EscapedAnchorElement } from "@/hooks/useChatViewportController";
import {
  shellsCrossingViewport,
  type BandRowRect,
} from "@/lib/chatResidentBand";
import {
  measuredFrameIntervalMs,
  measuredRefreshRateHz,
  nominalRefreshRateHz,
  noteAnimationFrame,
} from "@/lib/frameCadence";

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
/** Cadence of the live follower published for an external tracking session. */
const LIVE_FOLLOW_MS = 250;

/** The layout ledger's footprint the ledger-memory budget is read against. */
export type LedgerStatsSnapshot = {
  /** Rows the ledger currently holds. */
  rows: number;
  /** The ledger's typed-array footprint in bytes. */
  memoryBytes: number;
};

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

/**
 * On-screen position of every row crossing the viewport, for the C2
 * visible-shift metric. Rows are emitted in DOM order (ascending index), so a
 * row that starts below the viewport ends the walk. Crossing rows are also
 * copied into `crossing` (with a shell flag) for the visible-band (no-shell) check.
 */
function visibleRowPositions(
  viewport: HTMLElement,
  content: HTMLElement | null,
  crossing?: BandRowRect[],
): VisibleRowPosition[] {
  const root = content ?? viewport;
  const rows = root.querySelectorAll<HTMLElement>("[data-virt-index]");
  const viewTop = viewport.getBoundingClientRect().top;
  const viewBottom = viewTop + viewport.clientHeight;
  const positions: VisibleRowPosition[] = [];
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.top >= viewBottom) break;
    if (rect.bottom <= viewTop) continue;
    const raw = row.dataset.virtIndex;
    const index = raw == null ? Number.NaN : Number(raw);
    if (!Number.isFinite(index)) continue;
    positions.push({ index, top: rect.top });
    crossing?.push({
      index,
      top: rect.top,
      bottom: rect.bottom,
      shell: row.querySelector("[data-virt-shell]") != null,
    });
  }
  return positions;
}

export function useChatViewportTraceProbe(input: {
  viewportRef: RefObject<HTMLElement | null>;
  isPinnedRef: RefObject<boolean>;
  escapedRef?: RefObject<boolean>;
  contentRef?: RefObject<HTMLElement | null>;
  /** The escaped anchor the controller holds, for the C3 read-out. */
  anchorRef?: RefObject<EscapedAnchorElement | null>;
  /** The chat's own session/conversation id, for correlating a viewport run. */
  sessionId?: string | null;
  /**
   * The layout ledger's footprint, for the ledger-memory budget on the
   * heartbeat. Read only while the trace is on; the probe keeps the latest
   * getter in a ref so its identity cannot re-run the effect.
   */
  getLedgerStats?: () => LedgerStatsSnapshot | null;
}): void {
  const {
    viewportRef,
    isPinnedRef,
    escapedRef,
    contentRef,
    anchorRef,
    sessionId,
    getLedgerStats,
  } = input;
  const getLedgerStatsRef = useRef(getLedgerStats);
  getLedgerStatsRef.current = getLedgerStats;

  useEffect(() => {
    if (!chatViewportTraceEnabled()) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    let raf = 0;
    let lastGestureAt = 0;
    let lastDumpAt = Number.NEGATIVE_INFINITY;
    let prevIndex: number | null = null;
    let prevScrollTop = viewport.scrollTop;
    let previousNativeScrollTop = viewport.scrollTop;
    let prevScrollHeight = viewport.scrollHeight;
    let prevPinned = isPinnedRef.current;
    /** Visible-band row positions from the previous frame, for the shift metric. */
    let prevPositions: VisibleRowPosition[] = [];
    /** Shell indices seen inside the band last frame, so a repeat is not re-logged. */
    let prevShellsInBand = "";
    let lastDTop = 0;
    let lastDHeight = 0;
    /** Latest frame metrics, surfaced on the heartbeat so the log reads out. */
    let lastDistFromBottom = 0;
    let lastVisibleShift: number | null = null;
    /** Latest escaped-anchor displacement (px), the C3 read-out. */
    let lastAnchorShift: number | null = null;
    let lastWriteSource: string | null = null;
    let prevWriteCount = chatViewportWriteStats().writes;
    let writesSinceHeartbeat = 0;
    /**
     * Paint-boundary callback durations for the current heartbeat window (ms).
     * Reset on every heartbeat, so the aggregate covers one 10s window.
     */
    let frameCostWindow: number[] = [];
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
    /** Nominal refresh rate at the previous heartbeat; null until the first. */
    let lastNominalRefreshHz: number | null = null;

    const geometry = () => ({
      rows: contentRef?.current
        ? contentRef.current.querySelectorAll("[data-virt-index]").length
        : 0,
      index: prevIndex,
      scrollTop: Math.round(viewport.scrollTop),
      scrollHeight: Math.round(viewport.scrollHeight),
      clientHeight: Math.round(viewport.clientHeight),
      distFromBottom: Math.round(lastDistFromBottom),
      visibleShiftPx: lastVisibleShift,
      anchorShiftPx: lastAnchorShift,
      pinned: !!isPinnedRef.current,
      escaped: !!escapedRef?.current,
      writeSource: lastWriteSource,
      writes: writesSinceHeartbeat,
      hidden: typeof document !== "undefined" ? document.hidden : null,
      visibility:
        typeof document !== "undefined" ? document.visibilityState : null,
      frameIntervalMs: Math.round(measuredFrameIntervalMs() * 100) / 100,
      fps: Math.round(measuredRefreshRateHz()),
    });

    const publish = (
      reason: string,
      force: boolean,
      trigger: ViewportTraceEvent | null = null,
    ) => {
      const now = performance.now();
      if (!force && now - lastDumpAt < DUMP_COOLDOWN_MS) return;
      lastDumpAt = now;
      void publishTraceToHost(dumpChatViewportTrace(reason, trigger));
    };

    // Manual flush for devtools use, e.g. after an episode ends.
    const manualDump = () => publish("manual", true);
    (window as unknown as { __CHAT_VIEWPORT_DUMP__?: () => void })
      .__CHAT_VIEWPORT_DUMP__ = manualDump;

    const onGesture = () => {
      lastGestureAt = performance.now();
    };

    const onNativeScroll = () => {
      if (cancelled) return;
      const scrollTop = viewport.scrollTop;
      const dTop = scrollTop - previousNativeScrollTop;
      previousNativeScrollTop = scrollTop;
      const gestureRecent = performance.now() - lastGestureAt < GESTURE_WINDOW_MS;
      if (
        Math.abs(dTop) >= GEOMETRY_EPSILON_PX ||
        gestureRecent
      ) {
        traceViewport("native-scroll", {
          scrollTop: Math.round(scrollTop),
          scrollHeight: Math.round(viewport.scrollHeight),
          clientHeight: Math.round(viewport.clientHeight),
          dTop: Math.round(dTop),
          pinned: !!isPinnedRef.current,
          gestureRecent,
        });
      }
      if (isSuspiciousUpwardJump({ userGestureRecent: gestureRecent, deltaTop: dTop })) {
        const trigger = traceViewport("upward-jump-native", {
          dTop: Math.round(dTop),
          scrollTop: Math.round(scrollTop),
          scrollHeight: Math.round(viewport.scrollHeight),
          clientHeight: Math.round(viewport.clientHeight),
          pinned: !!isPinnedRef.current,
          gestureRecent,
        });
        publish("viewport-native-jumped-up", false, trigger);
      }
    };

    /**
     * One sample of the viewport, taken on the paint boundary when called from
     * {@link frame} and on the timer fallback otherwise; records only when
     * something changed.
     *
     * The metric fields use compact keys (`d` distance to the content end,
     * `v` visible-band shift, `w`/`ws` write count/source, `by` sampling path)
     * so a dump window covers as many frames as the host line budget allows.
     * The key legend is documented in docs/llm-wiki/chat-viewport-trace.md.
     */
    const takeSample = (sampledBy: "raf" | "fallback") => {
      if (cancelled) return;
      const pinned = !!isPinnedRef.current;
      const escaped = !!escapedRef?.current;
      setChatViewportTracePinned(pinned);
      const scrollTop = viewport.scrollTop;
      const scrollHeight = viewport.scrollHeight;
      const clientHeight = viewport.clientHeight;
      // One layout walk per frame: the first visible index falls out of the
      // band positions instead of a second `getBoundingClientRect` pass.
      const crossing: BandRowRect[] = [];
      const positions = visibleRowPositions(
        viewport,
        contentRef?.current ?? null,
        crossing,
      );
      const index = positions[0]?.index ?? null;
      const shift = visibleBandShift(prevPositions, positions);
      // C3 read-out: the captured anchor element's own screen-top shift from
      // the position the controller recorded — the same source of truth the
      // restore corrects. Null while pinned (the anchor is then the content
      // end, judged by `d`).
      const anchorShift = escaped
        ? anchorScreenShift(anchorRef?.current ?? null)
        : null;
      lastAnchorShift = anchorShift;
      // No shell may sit inside the visible band. Judged here, at the
      // paint boundary, on the same rows the C2 shift metric uses.
      const viewTop = viewport.getBoundingClientRect().top;
      const shellsInBand = shellsCrossingViewport(
        crossing,
        viewTop,
        viewTop + clientHeight,
      );
      const shellKey = shellsInBand.join(",");
      if (shellKey !== prevShellsInBand) {
        prevShellsInBand = shellKey;
        if (shellsInBand.length > 0) {
          const trigger = traceViewport("shell-in-band", {
            count: shellsInBand.length,
            indices: shellsInBand.slice(0, 8),
            scrollTop: Math.round(scrollTop),
            scrollHeight: Math.round(scrollHeight),
            clientHeight: Math.round(clientHeight),
            by: sampledBy,
          });
          console.warn(
            "[chat-viewport] shell row inside the visible band",
            shellsInBand.slice(0, 8),
          );
          publish("shell-in-band", false, trigger);
        }
      }
      const distFromBottom = distanceFromBottom(
        scrollTop,
        scrollHeight,
        clientHeight,
        false,
      );
      const writeStats = chatViewportWriteStats();
      const dWrites = writeStats.writes - prevWriteCount;
      lastDistFromBottom = distFromBottom;
      lastVisibleShift = shift;
      lastWriteSource = writeStats.lastSource;
      const dTop = scrollTop - prevScrollTop;
      const dHeight = scrollHeight - prevScrollHeight;
      const dMutations = mutations - prevMutations;
      const gestureRecent = performance.now() - lastGestureAt < GESTURE_WINDOW_MS;

      const moved =
        index !== prevIndex ||
        pinned !== prevPinned ||
        Math.abs(dTop) >= GEOMETRY_EPSILON_PX ||
        Math.abs(dHeight) >= GEOMETRY_EPSILON_PX ||
        // A ≤ 0.5px C3 bound is below the geometry noise floor, so an escaped
        // anchor drift must itself count as "moved" or it would never reach the
        // ring and the manual pass could not read it.
        (anchorShift != null && Math.abs(anchorShift) > VIEWPORT_ANCHOR_TOLERANCE_PX);

      if (moved) {
        lastDTop = dTop;
        lastDHeight = dHeight;
        sampled += 1;
        writesSinceHeartbeat += dWrites;
        traceViewport("sample", {
          i: index,
          pi: prevIndex,
          st: Math.round(scrollTop),
          sh: Math.round(scrollHeight),
          ch: Math.round(clientHeight),
          d: Math.round(distFromBottom),
          v: shift,
          a: anchorShift,
          dt: Math.round(dTop),
          dh: Math.round(dHeight),
          dm: dMutations,
          p: pinned,
          e: escaped,
          w: dWrites,
          ws: writeStats.lastSource,
          g: gestureRecent,
          by: sampledBy,
          // A pin flip the sampler sees between the hook's own flip records is
          // attributed to the cause that flip recorded (C4).
          ...(pinned !== prevPinned ? { fc: lastPinFlipCause() } : {}),
        });
      }

      if (
        isBackwardViewportMove({
          pinned,
          escaped,
          userGestureRecent: gestureRecent,
          previousIndex: prevIndex,
          index,
        }) ||
        isSuspiciousUpwardJump({ userGestureRecent: gestureRecent, deltaTop: dTop })
      ) {
        const backward = index !== null && prevIndex !== null && index < prevIndex;
        if (backward) backwardCount += 1;
        const trigger = traceViewport(backward ? "backward" : "upward-jump", {
          fromIndex: prevIndex,
          toIndex: index,
          dTop: Math.round(dTop),
          dMutations,
          mutations,
          scrollTop: Math.round(scrollTop),
          scrollHeight: Math.round(scrollHeight),
          clientHeight: Math.round(clientHeight),
          distFromBottom: Math.round(distFromBottom),
          pinned,
          escaped,
          gestureRecent,
          sampledBy,
        });
        // The chain matters more than later samples: publish now (rate limited).
        publish(
          backward ? "viewport-moved-to-older-message" : "viewport-jumped-up",
          true,
          trigger,
        );
      }

      prevIndex = index;
      prevScrollTop = scrollTop;
      prevScrollHeight = scrollHeight;
      prevPinned = pinned;
      prevPositions = positions;
      prevMutations = mutations;
      prevWriteCount = writeStats.writes;
    };

    // Sampling boundary: the rAF callback runs after the browser has applied
    // this frame's layout and immediately before it paints, so a sample
    // describes what the user is about to see. Sampling from mutation or scroll
    // callbacks instead reported a false 980px jump — those fire mid-layout.
    const frame = () => {
      if (cancelled) return;
      // This is the sampled rAF loop, so it also feeds the shared cadence
      // estimate: a refresh-rate change (120 Hz ↔ 60 Hz) or a cross-display
      // move then shows up in the heartbeat without a separate timer.
      noteAnimationFrame(performance.now());
      // The delivery's own work at the paint boundary — the band / shell check,
      // the geometry walk and the app callbacks that share this tick. It is the
      // per-frame cost the app can measure from inside; see the field legend.
      const frameStartedAt = performance.now();
      takeSample("raf");
      frameCostWindow.push(performance.now() - frameStartedAt);
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
    viewport.addEventListener("scroll", onNativeScroll, { passive: true });
    traceViewport("probe-mounted", {
      ...geometry(),
      probeVersion: 4,
      session: chatTraceSessionId(),
      chatSession: sessionId ?? null,
    });
    void publishTraceToHost({
      reason: "tracking-begin",
      probeVersion: 4,
      session: chatTraceSessionId(),
      chatSession: sessionId ?? null,
      ...geometry(),
    });
    raf = requestAnimationFrame(frame);

    // Timer fallback: rAF is throttled in a background window, timers are not
    // (as aggressively), so a capture still yields samples while unfocused.
    // These are marked `by: "fallback"` — they are not drawn frames.
    const fallback = window.setInterval(() => takeSample("fallback"), FALLBACK_SAMPLE_MS);

    // Live follower for an external tracking session: while a session id is
    // set, publish a compact per-frame-ish summary so `tail -F
    // logs/app.log.<day> | grep <id>` follows the reproduction in near-real
    // time (pin flips, big scrollTop moves, the chain before an upward jump).
    let livePrevTop: number | null = null;
    let livePrevHeight: number | null = null;
    let livePeakTopMove = 0;
    const liveTimer = chatTraceSessionId()
      ? window.setInterval(() => {
          if (cancelled) return;
          const top = viewport.scrollTop;
          const height = viewport.scrollHeight;
          const dTop = livePrevTop == null ? 0 : top - livePrevTop;
          const dHeight = livePrevHeight == null ? 0 : height - livePrevHeight;
          if (Math.abs(dTop) > Math.abs(livePeakTopMove)) {
            livePeakTopMove = dTop;
          }
          livePrevTop = top;
          livePrevHeight = height;
          if (Math.abs(dTop) < GEOMETRY_EPSILON_PX && livePeakTopMove === 0) {
            return; // not moving — only emit the begin marker until something changes
          }
          void publishTraceToHost({
            reason: "tracking-live",
            session: chatTraceSessionId(),
            chatSession: sessionId ?? null,
            scrollTop: Math.round(top),
            scrollHeight: Math.round(height),
            clientHeight: Math.round(viewport.clientHeight),
            distFromBottom: Math.round(
              distanceFromBottom(
                top,
                height,
                viewport.clientHeight,
                false,
              ),
            ),
            index: firstVisibleRowIndex(viewport, contentRef?.current ?? null),
            dTop: Math.round(dTop),
            dHeight: Math.round(dHeight),
            peakTopMove: Math.round(livePeakTopMove),
            pinned: !!isPinnedRef.current,
            escaped: !!escapedRef?.current,
          });
          livePeakTopMove = 0;
        }, LIVE_FOLLOW_MS)
      : null;

    // Baseline: proves the console → Host → log channel works, and records the
    // geometry at mount.
    const startTimer = window.setTimeout(() => {
      traceViewport("start", geometry());
      publish("trace-start", false);
    }, 2000);

    const heartbeat = window.setInterval(() => {
      // A refresh-rate change (120 Hz ↔ 60 Hz) or a cross-display move is worth
      // its own event: the position criteria are judged per drawn frame, so the
      // cadence the frames arrived at has to be readable next to them.
      const nominalHz = nominalRefreshRateHz();
      if (lastNominalRefreshHz != null && nominalHz !== lastNominalRefreshHz) {
        traceViewport("refresh-rate", {
          fromHz: lastNominalRefreshHz,
          toHz: nominalHz,
          frameIntervalMs: Math.round(measuredFrameIntervalMs() * 100) / 100,
          fps: Math.round(measuredRefreshRateHz()),
        });
      }
      lastNominalRefreshHz = nominalHz;
      // The frame-cost window and the ledger footprint for this heartbeat. The
      // window resets so the aggregate covers one 10s interval.
      const frameCost = frameCostSummary(frameCostWindow);
      const ledgerStats = getLedgerStatsRef.current?.() ?? null;
      frameCostWindow = [];
      // A dump, not a bare status line: the per-frame samples (distance to the
      // content end, visible-band shift, write sources) only reach the log
      // through a dump, so a session with no trigger would otherwise keep them
      // in the ring. The heartbeat event is itself the newest event the dump
      // anchors on.
      traceViewport("heartbeat", {
        ...geometry(),
        // The spec's per-frame write budget, read off the paint-boundary frames:
        // the peak and how many frames exceeded one write. This is what the
        // manual macOS pass reads to confirm "≤ 1 position write per frame".
        ...frameWriteSummary(chatViewportTraceEvents()),
        // The measured frame cost over the window, against the 120Hz budget.
        ...frameCost,
        // The C4 violation aggregate over the paint-boundary frames read off
        // the same ring: gesture-free upward moves, backward moves, and frames
        // whose band / anchor drifted past the tolerance.
        ...viewportViolationSummary(
          chatViewportTraceEvents(),
          VIEWPORT_ANCHOR_TOLERANCE_PX,
        ),
        // The ledger-memory budget (absolute footprint, not a delta). Absent
        // when no ledger getter was supplied.
        ...(ledgerStats
          ? {
              ledgerMemoryBytes: ledgerStats.memoryBytes,
              ledgerRows: ledgerStats.rows,
            }
          : {}),
        sampled,
        mutations,
        backward: backwardCount,
        lastDTop: Math.round(lastDTop),
        lastDHeight: Math.round(lastDHeight),
        gestureMsAgo:
          lastGestureAt === 0 ? null : Math.round(performance.now() - lastGestureAt),
      });
      publish("heartbeat", true);
      writesSinceHeartbeat = 0;
    }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.clearInterval(fallback);
      window.clearInterval(heartbeat);
      if (liveTimer != null) window.clearInterval(liveTimer);
      mutationObserver.disconnect();
      cancelAnimationFrame(raf);
      viewport.removeEventListener("wheel", onGesture);
      viewport.removeEventListener("touchmove", onGesture);
      viewport.removeEventListener("scroll", onNativeScroll);
      const host = window as unknown as { __CHAT_VIEWPORT_DUMP__?: () => void };
      if (host.__CHAT_VIEWPORT_DUMP__ === manualDump) {
        delete host.__CHAT_VIEWPORT_DUMP__;
      }
    };
  }, [viewportRef, isPinnedRef, contentRef, anchorRef, sessionId, escapedRef]);
}
