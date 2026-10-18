/**
 * Pick the transcript's visible band (可见带) for the resident list.
 *
 * Every conversation row stays in the DOM; this module decides which of them
 * must carry real content this frame. The band is the rows the viewport spans
 * plus a margin, so a scroll or a collapse never exposes a shell inside the
 * viewport. There is no fixed row cap — the band follows the viewport height
 * (CONTEXT.md: 可见带), and rows outside it keep only their ledger height.
 *
 * Geometry comes from the layout ledger (the single row-geometry source), not
 * from the DOM, so the band costs an O(log n) offset search per frame instead
 * of a rect walk over the whole conversation. Pure module: no DOM, no React.
 */

import type { LayoutLedger } from "@/lib/chatViewportLedger";

/**
 * Margin kept real above and below the viewport. One screen of runway keeps a
 * fling or a collapse from revealing a shell before the next frame's band
 * update; the ceiling bounds markdown hydration on very tall windows.
 */
export const CHAT_RESIDENT_OVERSCAN_MIN_PX = 1200;
export const CHAT_RESIDENT_OVERSCAN_MAX_PX = 4800;

/** Viewport height assumed before the scroller has been measured (first frame). */
export const CHAT_RESIDENT_FALLBACK_VIEWPORT_PX = 800;

/** Ledger surface the band policy reads; a `LayoutLedger` satisfies it. */
export type ResidentBandRows = Pick<
  LayoutLedger,
  "rowCount" | "totalHeight" | "bandFor"
>;

/**
 * Margin for the band at a given viewport height. A hidden / not-yet-measured
 * scroller reports 0, which would collapse the band onto a single row, so the
 * fallback height stands in until the real one is known.
 */
export function resolveResidentOverscanPx(viewportHeight: number): number {
  const vh =
    Number.isFinite(viewportHeight) && viewportHeight > 0
      ? viewportHeight
      : CHAT_RESIDENT_FALLBACK_VIEWPORT_PX;
  return Math.min(
    CHAT_RESIDENT_OVERSCAN_MAX_PX,
    Math.max(CHAT_RESIDENT_OVERSCAN_MIN_PX, vh),
  );
}

export type ResidentBand = { start: number; end: number };

/**
 * Half-open band of rows that must render real content.
 *
 * While pinned the viewport is at the content end regardless of a stale
 * `scrollTop`, so the band anchors there instead of on the scroller — that is
 * what lands a just-opened conversation on its tail in the first frame.
 */
export function resolveResidentBand(input: {
  ledger: ResidentBandRows;
  scrollTop: number;
  viewportHeight: number;
  pinned: boolean;
  overscanPx?: number;
}): ResidentBand {
  const count = input.ledger.rowCount();
  if (count === 0) return { start: 0, end: 0 };
  const viewportHeight =
    Number.isFinite(input.viewportHeight) && input.viewportHeight > 0
      ? input.viewportHeight
      : CHAT_RESIDENT_FALLBACK_VIEWPORT_PX;
  const overscan =
    input.overscanPx != null && Number.isFinite(input.overscanPx)
      ? Math.max(0, input.overscanPx)
      : resolveResidentOverscanPx(viewportHeight);
  const anchorTop = input.pinned
    ? input.ledger.totalHeight()
    : input.scrollTop;
  const band = input.ledger.bandFor({
    scrollTop: anchorTop,
    viewportHeight,
    overscan,
  });
  return { start: band.start, end: band.end };
}

/** Band for a conversation opened (or re-pinned) at its content end. */
export function residentTailBand(
  ledger: ResidentBandRows,
  viewportHeight: number,
): ResidentBand {
  return resolveResidentBand({
    ledger,
    scrollTop: ledger.totalHeight(),
    viewportHeight,
    pinned: true,
  });
}

/**
 * Band membership and shell-height revision as an external store. Each row
 * subscribes for its own index, so a band change (or a shell height change)
 * notifies only the rows concerned — a scroll must not cost an O(rows)
 * getSnapshot pass on a 10k-row list.
 */
export type ChatResidentBandStore = {
  /** True when the row must render its real content this frame. */
  isRich(index: number): boolean;
  /**
   * Monotonic revision of a row's shell height. A shell reads its height from
   * the ledger during render, so a height that changes without a band change —
   * a collapse re-seeded from the model while the row was a shell — needs a
   * snapshot that moves to make that row re-render before paint.
   */
  heightRevision(index: number): number;
  /** Stable per-index subscribe, for `useSyncExternalStore`. */
  subscribeFor(index: number): (listener: () => void) => () => void;
};

/** The store plus the mutators the resident list owns. */
export type ChatResidentBandStoreControl = ChatResidentBandStore & {
  setBand(band: ResidentBand): void;
  /** Signal that a shell row's height changed; re-renders only that row. */
  notifyHeightChanged(index: number): void;
  /**
   * Drop the per-row revisions and subscribe cache on a row-identity change
   * (conversation / filter switch), so neither grows with the largest index ever
   * seen. Mounted rows re-subscribe on their next render.
   */
  clearRowState(): void;
};

export function createChatResidentBandStore(
  initial: ResidentBand,
): ChatResidentBandStoreControl {
  let band = initial;
  const listeners = new Map<number, Set<() => void>>();
  const revisions = new Map<number, number>();
  const subscribeCache = new Map<
    number,
    (listener: () => void) => () => void
  >();

  const notifyRow = (index: number): void => {
    const set = listeners.get(index);
    if (!set) return;
    for (const listener of set) listener();
  };
  const notifyRange = (lo: number, hi: number): void => {
    for (let i = lo; i < hi; i++) notifyRow(i);
  };

  return {
    isRich(index) {
      return index >= band.start && index < band.end;
    },
    heightRevision(index) {
      return revisions.get(index) ?? 0;
    },
    subscribeFor(index) {
      const cached = subscribeCache.get(index);
      if (cached) return cached;
      const subscribe = (listener: () => void) => {
        let set = listeners.get(index);
        if (!set) {
          set = new Set();
          listeners.set(index, set);
        }
        set.add(listener);
        return () => {
          set.delete(listener);
          if (set.size === 0) listeners.delete(index);
        };
      };
      subscribeCache.set(index, subscribe);
      return subscribe;
    },
    setBand(next) {
      const prev = band;
      if (prev.start === next.start && prev.end === next.end) return;
      band = next;
      // Notify exactly the symmetric difference of the two half-open ranges:
      // rows rich before and shell after, then shell before and rich after.
      if (prev.start < next.start) {
        notifyRange(prev.start, Math.min(prev.end, next.start));
      }
      if (prev.end > next.end) {
        notifyRange(Math.max(prev.start, next.end), prev.end);
      }
      if (next.start < prev.start) {
        notifyRange(next.start, Math.min(next.end, prev.start));
      }
      if (next.end > prev.end) {
        notifyRange(Math.max(next.start, prev.end), next.end);
      }
    },
    notifyHeightChanged(index) {
      revisions.set(index, (revisions.get(index) ?? 0) + 1);
      notifyRow(index);
    },
    clearRowState() {
      revisions.clear();
      subscribeCache.clear();
    },
  };
}

/** One mounted row's box, for the dev-only shell-in-band check. */
export type BandRowRect = {
  index: number;
  top: number;
  bottom: number;
  shell: boolean;
};

/**
 * Indices of shell rows that cross `[viewTop, viewBottom)` — a placeholder
 * inside the visible band, which AC2 forbids. Pure so the paint-boundary check
 * and its test share the same rule.
 */
export function shellsCrossingViewport(
  rows: readonly BandRowRect[],
  viewTop: number,
  viewBottom: number,
): number[] {
  const out: number[] = [];
  for (const row of rows) {
    if (!row.shell) continue;
    if (row.bottom <= viewTop || row.top >= viewBottom) continue;
    out.push(row.index);
  }
  return out;
}

