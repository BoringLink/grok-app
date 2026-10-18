import { describe, expect, it } from "vitest";
import { createLayoutLedger } from "./chatViewportLedger";
import {
  CHAT_RESIDENT_FALLBACK_VIEWPORT_PX,
  CHAT_RESIDENT_OVERSCAN_MAX_PX,
  CHAT_RESIDENT_OVERSCAN_MIN_PX,
  resolveResidentBand,
  resolveResidentOverscanPx,
  residentTailBand,
} from "./chatResidentBand";

const ROW = 100;

function ledgerOf(count: number, height = ROW) {
  return createLayoutLedger({ count, estimateHeight: height });
}

describe("resolveResidentOverscanPx", () => {
  it("clamps a measured viewport into the margin band", () => {
    expect(resolveResidentOverscanPx(300)).toBe(CHAT_RESIDENT_OVERSCAN_MIN_PX);
    expect(resolveResidentOverscanPx(2000)).toBe(2000);
    expect(resolveResidentOverscanPx(9000)).toBe(CHAT_RESIDENT_OVERSCAN_MAX_PX);
  });

  it("falls back to a usable margin when the scroller is unmeasured", () => {
    expect(resolveResidentOverscanPx(0)).toBe(CHAT_RESIDENT_OVERSCAN_MIN_PX);
    expect(resolveResidentOverscanPx(Number.NaN)).toBe(
      CHAT_RESIDENT_OVERSCAN_MIN_PX,
    );
  });
});

describe("resolveResidentBand", () => {
  it("returns an empty band for an empty conversation", () => {
    expect(
      resolveResidentBand({
        ledger: ledgerOf(0),
        scrollTop: 0,
        viewportHeight: 600,
        pinned: false,
      }),
    ).toEqual({ start: 0, end: 0 });
  });

  it("covers the viewport with a margin on both sides", () => {
    // 100 rows x 100px; viewport 600 at scrollTop 2000 (row 20) with overscan 400.
    const band = resolveResidentBand({
      ledger: ledgerOf(100),
      scrollTop: 2000,
      viewportHeight: 600,
      pinned: false,
      overscanPx: 400,
    });
    // Rows 16..30: margin 400px above (1600) and below (3000).
    expect(band.start).toBe(16);
    expect(band.end).toBe(30);
  });

  it("anchors the band on the content end while pinned, ignoring a stale scrollTop", () => {
    const unchanged = resolveResidentBand({
      ledger: ledgerOf(100),
      scrollTop: 0,
      viewportHeight: 600,
      pinned: true,
      overscanPx: 400,
    });
    const atEnd = resolveResidentBand({
      ledger: ledgerOf(100),
      scrollTop: 9400,
      viewportHeight: 600,
      pinned: true,
      overscanPx: 400,
    });
    expect(unchanged).toEqual(atEnd);
    expect(unchanged.end).toBe(100);
  });

  it("uses the fallback viewport height when the scroller reports 0", () => {
    const band = residentTailBand(ledgerOf(200), 0);
    // 800px fallback + 1200px default margin over the tail of a 200px row list.
    expect(band.end).toBe(200);
    expect(band.start).toBeLessThanOrEqual(
      200 - Math.floor(CHAT_RESIDENT_FALLBACK_VIEWPORT_PX / ROW),
    );
  });

  it("keeps a single row visible in a one-row conversation", () => {
    const band = resolveResidentBand({
      ledger: ledgerOf(1),
      scrollTop: 0,
      viewportHeight: 600,
      pinned: false,
    });
    expect(band).toEqual({ start: 0, end: 1 });
  });

  it("returns the whole list when everything fits in the viewport", () => {
    const band = resolveResidentBand({
      ledger: ledgerOf(3),
      scrollTop: 0,
      viewportHeight: 600,
      pinned: false,
      overscanPx: 0,
    });
    expect(band).toEqual({ start: 0, end: 3 });
  });
});
