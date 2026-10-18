/**
 * Resident transcript list (transcript: every row resident + a viewport-driven
 * visible band).
 *
 * Every conversation row stays in the DOM
 * for the whole session, its box height coming from the viewport controller's
 * layout ledger. The rows inside the visible band render their real content;
 * the rows outside keep only their height (a shell) — a placeholder is allowed
 * there and only there. Because the DOM always carries every row, the
 * scrollbar length equals the real content length, before and after a collapse
 * or a re-growth.
 *
 * The list produces layout only (ADR 0006): it seeds the ledger with content
 * estimates, reports measured heights back, and asks the controller to restore
 * the invariant. It never writes `scrollTop`.
 *
 * Cost: the band is computed from the ledger (an O(log n) offset search), not
 * from a rect walk, and it lives in an external store, so a scroll re-renders
 * only the rows whose band membership flipped — never the parent with its 10k
 * rows and never a getSnapshot pass over all of them.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { LayoutLedger, LayoutRowHeight } from "@/lib/chatViewportLedger";
import {
  createChatResidentBandStore,
  resolveResidentBand,
  type ChatResidentBandStoreControl,
  type ResidentBand,
} from "@/lib/chatResidentBand";
import {
  CHAT_DEFAULT_ROW_ESTIMATE_PX,
  shouldCommitRowHeight,
} from "@/lib/chatRowHeight";
import {
  cancelFrameSchedule,
  emptyFrameSchedule,
  scheduleOnFrame,
  type FrameSchedule,
} from "@/lib/frameSchedule";
import {
  chatViewportTraceEnabled,
  publishTraceToHost,
  traceViewport,
} from "@/lib/chatViewportTrace";
import type {
  UseChatResidentListArgs,
  UseChatResidentListResult,
} from "@/hooks/chatResidentListShared";

export type {
  ChatResidentBandStore,
  UseChatResidentListArgs,
  UseChatResidentListResult,
} from "@/hooks/chatResidentListShared";

/** A scroll event within this window still counts as the user moving the list. */
const SCROLL_ACTIVE_MS = 150;
/** Restore the invariant this long after the last scroll event settles. */
const SCROLL_IDLE_MS = 180;

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Element-wise identity compare of two fold-input lists. */
function sameFoldInputs(
  a: readonly unknown[],
  b: readonly unknown[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, i) => Object.is(value, b[i]));
}

/** Seed bookkeeping: which ledger is in use and how many rows it holds. */
export type ResidentLedgerSeed = {
  ledger: LayoutLedger | null;
  count: number;
  resetKey: string | number | null;
};

/**
 * Grow `ledger` to `itemCount` and write the content estimate for every row
 * that has never been seeded. Idempotent: a repeat call with the same seed
 * state does no work, so it is safe across a StrictMode double effect.
 */
export function seedResidentLedger(input: {
  ledger: LayoutLedger;
  seed: ResidentLedgerSeed;
  itemCount: number;
  estimate: (index: number) => number;
}): void {
  const { ledger, seed, itemCount, estimate } = input;
  if (ledger.rowCount() !== itemCount) ledger.setCount(itemCount);
  if (seed.count > itemCount) seed.count = 0;
  if (seed.count >= itemCount) return;
  const changes: LayoutRowHeight[] = [];
  for (let i = seed.count; i < itemCount; i++) {
    changes.push({ index: i, height: estimate(i), source: "estimate" });
  }
  ledger.applyRowHeights(changes);
  seed.count = itemCount;
}

/**
 * Resident transcript list: keep every conversation row in the DOM, render real
 * content only inside the visible band, and let the layout ledger drive the
 * rest. The band is recomputed from the ledger before paint (and synchronously
 * in the controller's write path), measured heights go back to the controller,
 * and the single `scrollTop` writer stays the controller.
 */
export function useChatResidentList(
  args: UseChatResidentListArgs,
): UseChatResidentListResult {
  const {
    itemCount,
    getEstimateHeight,
    viewportRef,
    isPinnedRef,
    controller,
    resetKey = null,
    enabled = true,
    getActivityFold,
    activityRevision,
  } = args;

  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;
  const estimateRef = useRef(getEstimateHeight);
  estimateRef.current = getEstimateHeight;
  const activityFoldRef = useRef(getActivityFold);
  activityFoldRef.current = getActivityFold;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const lastViewportHeightRef = useRef(0);
  const seedRef = useRef<ResidentLedgerSeed>({
    ledger: null,
    count: 0,
    resetKey,
  });

  const estimateFor = useCallback((index: number): number => {
    const est = estimateRef.current?.(index);
    return est != null && Number.isFinite(est) && est >= 0
      ? est
      : CHAT_DEFAULT_ROW_ESTIMATE_PX;
  }, []);

  // Nothing is rich until the layout effect bands (and seeds) before the first
  // paint; with the shell band disabled, every row is rich from the start.
  const bandStoreRef = useRef<ChatResidentBandStoreControl | null>(null);
  if (!bandStoreRef.current) {
    bandStoreRef.current = createChatResidentBandStore(
      enabled ? { start: 0, end: 0 } : { start: 0, end: itemCount },
    );
  }
  const bandStore = bandStoreRef.current;

  const computeBand = useCallback((): ResidentBand => {
    const ledger = controller?.ledger();
    const el = viewportRef.current;
    if (!ledger) return { start: 0, end: 0 };
    if (!enabledRef.current) return { start: 0, end: itemCountRef.current };
    const height = el?.clientHeight ?? 0;
    if (height > 0) lastViewportHeightRef.current = height;
    return resolveResidentBand({
      ledger,
      scrollTop: el?.scrollTop ?? 0,
      viewportHeight: height,
      pinned: !!isPinnedRef.current,
    });
  }, [controller, viewportRef, isPinnedRef]);

  const frameRef = useRef<FrameSchedule>(emptyFrameSchedule());
  const refreshBand = useCallback(() => {
    bandStore.setBand(computeBand());
  }, [bandStore, computeBand]);
  const scheduleBand = useCallback(() => {
    scheduleOnFrame(frameRef.current, refreshBand);
  }, [refreshBand]);

  // ---- measured heights -------------------------------------------------

  const sharedRowObserverRef = useRef<ResizeObserver | null>(null);
  const observedElementsRef = useRef<Map<HTMLElement, number>>(new Map());
  const observedIndicesRef = useRef<Map<number, HTMLElement>>(new Map());
  /**
   * Rows with foldable activity, tracked from their last render. A row outside
   * the band can only hold a stale height if its fold changed since, so only
   * these are re-checked when the model revision moves — never a scan over every
   * resident row. `expandedHeight` remembers the last height measured while the
   * fold was open, so an out-of-band re-growth can restore it.
   */
  const activityRowsRef = useRef<
    Map<number, { inputs: readonly unknown[]; expanded: boolean; expandedHeight: number | null }>
  >(new Map());
  /** Generation observed when a row element was attached, stamped on its measurement. */
  const observedGenerationsRef = useRef<Map<HTMLElement, number>>(new Map());
  const scrollActiveUntilRef = useRef(0);
  const pendingRestoreRef = useRef(false);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitRowHeight = useCallback(
    (
      index: number,
      el: HTMLElement,
      measuredHeight?: number,
      generation?: number,
    ) => {
      const ledger = controller?.ledger();
      if (!ledger) return;
      const next =
        measuredHeight != null &&
        Number.isFinite(measuredHeight) &&
        measuredHeight >= 0
          ? Math.round(measuredHeight)
          : Math.round(el.getBoundingClientRect().height);
      const prevHeight = ledger.heightOf(index);
      const prevMeasured =
        ledger.sourceOf(index) === "measured" ? prevHeight : undefined;
      if (!shouldCommitRowHeight(prevMeasured, next)) return;
      controller?.reportRowHeight(index, next, generation);
      const fold = activityFoldRef.current?.(index) ?? null;
      if (!fold || !fold.hasActivity) {
        activityRowsRef.current.delete(index);
      } else {
        const prev = activityRowsRef.current.get(index);
        activityRowsRef.current.set(index, {
          inputs: fold.inputs,
          expanded: fold.expanded,
          expandedHeight: fold.expanded ? next : (prev?.expandedHeight ?? null),
        });
      }
      const delta = next - prevHeight;
      if (Math.abs(delta) > 0.5) {
        if (nowMs() < scrollActiveUntilRef.current) {
          // Mid-scroll: the controller learns at scroll idle. This only gates
          // the ledger-commit restore (a pin re-assert / band re-seed), never an
          // escaped anchor — the row's own resize also changes the content
          // column, and the controller's content ResizeObserver holds the
          // escaped anchor each frame regardless of this deferral.
          pendingRestoreRef.current = true;
        } else {
          controller?.restoreLayout();
        }
      }
      scheduleBand();
    },
    [controller, scheduleBand],
  );

  const commitRowHeightRef = useRef(commitRowHeight);
  commitRowHeightRef.current = commitRowHeight;

  const ensureSharedObserver = useCallback(() => {
    if (sharedRowObserverRef.current || typeof ResizeObserver === "undefined") {
      return sharedRowObserverRef.current;
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const index = observedElementsRef.current.get(el);
        if (index === undefined) continue;
        let height = 0;
        if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
          const box = entry.borderBoxSize[0];
          if (box && Number.isFinite(box.blockSize) && box.blockSize > 0) {
            height = box.blockSize;
          }
        } else if (
          entry.contentRect &&
          Number.isFinite(entry.contentRect.height)
        ) {
          height = entry.contentRect.height;
        }
        if (height <= 0) continue;
        commitRowHeightRef.current(
          index,
          el,
          height,
          observedGenerationsRef.current.get(el),
        );
      }
    });
    sharedRowObserverRef.current = ro;
    return ro;
  }, []);

  /**
   * Stable per-index ref callbacks: returning a fresh function each render makes
   * React detach / reattach the ref, which thrashes the ResizeObserver.
   */
  const measureCallbackCacheRef = useRef<
    Map<number, (el: HTMLElement | null) => void>
  >(new Map());

  const measureRef = useCallback(
    (index: number) => {
      const cached = measureCallbackCacheRef.current.get(index);
      if (cached) return cached;
      const cb = (el: HTMLElement | null) => {
        const ro = ensureSharedObserver();
        const prevEl = observedIndicesRef.current.get(index);
        if (prevEl && prevEl !== el) {
          ro?.unobserve(prevEl);
          observedElementsRef.current.delete(prevEl);
          observedGenerationsRef.current.delete(prevEl);
          observedIndicesRef.current.delete(index);
        }
        if (!el) {
          return;
        }
        // Stamp the generation at attach: a measurement delivered after the row
        // was re-estimated carries this older generation and is refused.
        const generation = controller?.ledger().generationOf(index) ?? 0;
        observedElementsRef.current.set(el, index);
        observedIndicesRef.current.set(index, el);
        observedGenerationsRef.current.set(el, generation);
        if (ro) ro.observe(el);
        else commitRowHeightRef.current(index, el, undefined, generation);
      };
      measureCallbackCacheRef.current.set(index, cb);
      return cb;
    },
    [ensureSharedObserver, controller],
  );

  /**
   * Shell height for a row. Before the ledger is seeded (the very first commit)
   * the content estimate stands in, so the DOM already has the real scroll
   * height when the controller pins the conversation to its tail.
   */
  const rowHeight = useCallback(
    (index: number): number => {
      const ledger = controller?.ledger();
      if (ledger && index >= 0 && index < ledger.rowCount()) {
        return ledger.heightOf(index);
      }
      return estimateFor(index);
    },
    [controller, estimateFor],
  );

  // ---- lifecycle --------------------------------------------------------

  // Drop per-row observer / callback state when the row identity changes.
  useEffect(() => {
    sharedRowObserverRef.current?.disconnect();
    sharedRowObserverRef.current = null;
    observedElementsRef.current.clear();
    observedIndicesRef.current.clear();
    observedGenerationsRef.current.clear();
    measureCallbackCacheRef.current.clear();
    activityRowsRef.current.clear();
    bandStore.clearRowState();
    pendingRestoreRef.current = false;
  }, [resetKey, bandStore]);

  /**
   * Re-seed a shell whose activity fold changed since it was last rendered.
   *
   * When a thinking / tool block folds while its row is outside the band,
   * nothing renders to measure, so the ledger would keep the old height and the
   * scrollbar would lie. The model fold is the only source here; for a shell it
   * re-seeds the ledger and re-renders exactly that row before paint:
   *
   * - fold closed  → the estimate (the collapsed shape);
   * - fold opened  → the height remembered from the row's last expanded render,
   *   falling back to the estimate. This is what carries an out-of-band
   *   re-growth, not only a collapse.
   *
   * A rich row is left alone — its own measurement is exact — but its tracked
   * fold is advanced so the next revision does not re-fire on a stale input.
   */
  useLayoutEffect(() => {
    const getFold = activityFoldRef.current;
    if (!getFold || !controller) return;
    const rows = activityRowsRef.current;
    if (rows.size === 0) return;
    let changed = false;
    for (const [index, state] of [...rows]) {
      const fold = getFold(index);
      if (!fold || !fold.hasActivity) {
        rows.delete(index);
        continue;
      }
      if (sameFoldInputs(state.inputs, fold.inputs)) continue;
      const wasExpanded = state.expanded;
      state.inputs = fold.inputs;
      state.expanded = fold.expanded;
      if (wasExpanded === fold.expanded) continue;
      if (bandStore.isRich(index)) continue;
      const height = fold.expanded
        ? (state.expandedHeight ?? estimateFor(index))
        : estimateFor(index);
      controller.reestimateRow(index, height, bandStore.isRich);
      bandStore.notifyHeightChanged(index);
      changed = true;
    }
    if (changed) refreshBand();
  }, [activityRevision, controller, bandStore, estimateFor, refreshBand]);

  // Seed, then band, before paint: the first painted frame must know every
  // shell's height and which rows carry content. Layout effects run before
  // paint, so this keeps the first-frame behaviour without a render-phase
  // side effect.
  useLayoutEffect(() => {
    seedControllerLedger({
      controller,
      seed: seedRef.current,
      itemCount,
      resetKey,
      estimate: estimateFor,
    });
    refreshBand();
    // Unknown viewport (mount before layout): retry on the next frame so the
    // first painted band is not stuck on the fallback height.
    const raf = requestAnimationFrame(refreshBand);
    return () => cancelAnimationFrame(raf);
  }, [controller, itemCount, resetKey, enabled, estimateFor, refreshBand]);

  // Re-band synchronously in the controller's write path: a programmatic jump
  // (find / Home / rail) must not paint a shell row inside the band.
  useEffect(() => {
    if (!controller) return;
    return controller.subscribePosition(refreshBand);
  }, [controller, refreshBand]);

  // DEV-only: record the transcript's first painted frame so the number can be
  // read from the Host log in the packaged client (AC4). No-op when the trace
  // flag is unset.
  useLayoutEffect(() => {
    if (!chatViewportTraceEnabled()) return;
    const start = nowMs();
    const raf = requestAnimationFrame(() => {
      const el = viewportRef.current;
      const payload = {
        ms: Math.round(nowMs() - start),
        rows: itemCountRef.current,
        scrollTop: Math.round(el?.scrollTop ?? 0),
        scrollHeight: Math.round(el?.scrollHeight ?? 0),
        clientHeight: Math.round(el?.clientHeight ?? 0),
      };
      traceViewport("first-frame", payload);
      void publishTraceToHost({ reason: "chat-first-frame", ...payload });
    });
    return () => cancelAnimationFrame(raf);
  }, [controller, resetKey, viewportRef]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollActiveUntilRef.current = nowMs() + SCROLL_ACTIVE_MS;
      scheduleBand();
      if (scrollIdleTimerRef.current != null) {
        clearTimeout(scrollIdleTimerRef.current);
      }
      scrollIdleTimerRef.current = setTimeout(() => {
        scrollIdleTimerRef.current = null;
        if (pendingRestoreRef.current) {
          pendingRestoreRef.current = false;
          controller?.restoreLayout();
        }
      }, SCROLL_IDLE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => scheduleBand())
        : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (scrollIdleTimerRef.current != null) {
        clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
    };
  }, [viewportRef, controller, scheduleBand]);

  useEffect(
    () => () => {
      cancelFrameSchedule(frameRef.current);
    },
    [],
  );

  return {
    rowCount: itemCount,
    bandStore,
    rowHeight,
    measureRef,
  };
}

/**
 * Seed the controller's ledger, dropping remembered heights first when the row
 * identity changed on the same ledger object (conversation switch recreates the
 * ledger inside the controller, so only the reset case is handled here).
 */
function seedControllerLedger(input: {
  controller: UseChatResidentListArgs["controller"];
  seed: ResidentLedgerSeed;
  itemCount: number;
  resetKey: string | number | null;
  estimate: (index: number) => number;
}): void {
  const { controller, seed, itemCount, resetKey, estimate } = input;
  if (!controller) return;
  let ledger = controller.ledger();
  if (resetKey !== seed.resetKey && seed.ledger === ledger) {
    controller.resetLedger();
    ledger = controller.ledger();
  }
  if (seed.ledger !== ledger) {
    seed.ledger = ledger;
    seed.count = 0;
  }
  seed.resetKey = resetKey;
  seedResidentLedger({ ledger, seed, itemCount, estimate });
}
