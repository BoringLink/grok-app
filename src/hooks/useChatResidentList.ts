/**
 * Resident transcript list (会话流：全量行常驻 + 视口动态可见带).
 *
 * Replaces the moving virtual window: every conversation row stays in the DOM
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
 * rows.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { LayoutLedger, LayoutRowHeight } from "@/lib/chatViewportLedger";
import {
  resolveResidentBand,
  residentTailBand,
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
import type {
  ChatResidentBandStore,
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

type BandStoreInternal = ChatResidentBandStore & {
  setBand(band: ResidentBand): void;
};

/** Band membership store; notifies only when a row's membership actually flips. */
function createBandStore(initial: ResidentBand): BandStoreInternal {
  let band = initial;
  const listeners = new Set<() => void>();
  return {
    isRich(index: number) {
      return index >= band.start && index < band.end;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setBand(next: ResidentBand) {
      if (next.start === band.start && next.end === band.end) return;
      band = next;
      for (const listener of listeners) listener();
    },
  };
}

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
  } = args;

  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;
  const estimateRef = useRef(getEstimateHeight);
  estimateRef.current = getEstimateHeight;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const lastViewportHeightRef = useRef(0);
  /** Ledger + seeded row count, so seeding never walks the whole list twice. */
  const seedRef = useRef<{
    ledger: LayoutLedger | null;
    count: number;
    resetKey: string | number | null;
  }>({ ledger: null, count: 0, resetKey });

  // Seed the ledger's estimate tier during render: the first painted frame must
  // already know every shell's height, so the scrollbar is real from frame one.
  // The writes are idempotent, so a StrictMode double render is harmless.
  const ledgerForRender = seedLedger(
    controller,
    seedRef.current,
    itemCount,
    resetKey,
    estimateRef,
  );

  const bandStoreRef = useRef<BandStoreInternal | null>(null);
  if (!bandStoreRef.current) {
    bandStoreRef.current = createBandStore(
      initialBand(enabled, ledgerForRender, itemCount, lastViewportHeightRef.current),
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
  const scrollActiveUntilRef = useRef(0);
  const pendingRestoreRef = useRef(false);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitRowHeight = useCallback(
    (index: number, el: HTMLElement, measuredHeight?: number) => {
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
      controller?.reportRowHeight(index, next);
      const delta = next - prevHeight;
      if (Math.abs(delta) > 0.5) {
        if (nowMs() < scrollActiveUntilRef.current) {
          // Mid-scroll: the controller learns at scroll idle so its restore
          // does not fight the user's own move.
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
        } else if (entry.contentRect && Number.isFinite(entry.contentRect.height)) {
          height = entry.contentRect.height;
        }
        if (height <= 0) continue;
        commitRowHeightRef.current(index, el, height);
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
          observedIndicesRef.current.delete(index);
        }
        if (!el) return;
        observedElementsRef.current.set(el, index);
        observedIndicesRef.current.set(index, el);
        if (ro) ro.observe(el);
        else commitRowHeightRef.current(index, el);
      };
      measureCallbackCacheRef.current.set(index, cb);
      return cb;
    },
    [ensureSharedObserver],
  );

  const rowHeight = useCallback(
    (index: number): number => {
      const ledger = controller?.ledger();
      return ledger ? ledger.heightOf(index) : CHAT_DEFAULT_ROW_ESTIMATE_PX;
    },
    [controller],
  );

  // ---- lifecycle --------------------------------------------------------

  // Drop per-row observer / callback state when the row identity changes.
  useEffect(() => {
    sharedRowObserverRef.current?.disconnect();
    sharedRowObserverRef.current = null;
    observedElementsRef.current.clear();
    observedIndicesRef.current.clear();
    measureCallbackCacheRef.current.clear();
    pendingRestoreRef.current = false;
  }, [resetKey]);

  // First frame and every structural change: re-band before paint.
  useLayoutEffect(() => {
    refreshBand();
    // Unknown viewport (mount before layout): retry on the next frame so the
    // first painted band is not stuck on the fallback height.
    const raf = requestAnimationFrame(refreshBand);
    return () => cancelAnimationFrame(raf);
  }, [refreshBand, itemCount, resetKey, enabled, controller]);

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

/** Band for the first painted frame: the tail while pinned, else the whole list. */
function initialBand(
  enabled: boolean,
  ledger: LayoutLedger | null,
  itemCount: number,
  viewportHeight: number,
): ResidentBand {
  if (!enabled || !ledger) return { start: 0, end: itemCount };
  return residentTailBand(ledger, viewportHeight);
}

/**
 * Grow the ledger to `itemCount` and give every never-seeded row its content
 * estimate. Idempotent, and stable across a StrictMode double render.
 */
function seedLedger(
  controller: UseChatResidentListArgs["controller"],
  state: {
    ledger: LayoutLedger | null;
    count: number;
    resetKey: string | number | null;
  },
  itemCount: number,
  resetKey: string | number | null,
  estimateRef: { current: ((index: number) => number) | undefined },
): LayoutLedger | null {
  if (!controller) return null;
  let ledger = controller.ledger();
  // A new identity on the same ledger object: drop remembered heights first.
  if (resetKey !== state.resetKey && state.ledger === ledger) {
    controller.resetLedger();
    ledger = controller.ledger();
  }
  if (state.ledger !== ledger) {
    // The controller recreated the ledger (conversation switch).
    state.ledger = ledger;
    state.count = 0;
  }
  state.resetKey = resetKey;
  if (ledger.rowCount() !== itemCount) ledger.setCount(itemCount);
  if (state.count > itemCount) state.count = 0;
  if (state.count >= itemCount) return ledger;
  const changes: LayoutRowHeight[] = [];
  for (let i = state.count; i < itemCount; i++) {
    const est = estimateRef.current?.(i);
    changes.push({
      index: i,
      height:
        est != null && Number.isFinite(est) && est >= 0
          ? est
          : CHAT_DEFAULT_ROW_ESTIMATE_PX,
      source: "estimate",
    });
  }
  ledger.applyRowHeights(changes);
  state.count = itemCount;
  return ledger;
}
