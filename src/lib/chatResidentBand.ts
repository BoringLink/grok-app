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
