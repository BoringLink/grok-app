import { describe, expect, it, vi } from "vitest";
import { createLayoutLedger } from "./chatViewportLedger";
import {
  CHAT_RESIDENT_FALLBACK_VIEWPORT_PX,
  CHAT_RESIDENT_OVERSCAN_MAX_PX,
  CHAT_RESIDENT_OVERSCAN_MIN_PX,
  createChatResidentBandStore,
  resolveResidentBand,
  resolveResidentOverscanPx,
  residentTailBand,
  shellsCrossingViewport,
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

describe("createChatResidentBandStore", () => {
  it("notifies only the rows whose membership flipped", () => {
    // Arrange: 0 and 1 start rich; 10 and 11 start outside.
    const store = createChatResidentBandStore({ start: 0, end: 10 });
    const seen: number[] = [];
    store.subscribeFor(0)(() => seen.push(0));
    store.subscribeFor(3)(() => seen.push(3));
    store.subscribeFor(9)(() => seen.push(9));
    store.subscribeFor(10)(() => seen.push(10));

    // Act: the band slides right into [2, 12).
    store.setBand({ start: 2, end: 12 });

    // Assert: 0 leaves and 10 enters; 3 and 9 never move.
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 10]);
    expect(store.isRich(0)).toBe(false);
    expect(store.isRich(2)).toBe(true);
    expect(store.isRich(11)).toBe(true);
  });

  it("does not notify at all when the band is unchanged", () => {
    const store = createChatResidentBandStore({ start: 0, end: 10 });
    const listener = vi.fn();
    store.subscribeFor(1)(listener);

    store.setBand({ start: 0, end: 10 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a stable per-index subscribe and stops after unsubscribe", () => {
    const store = createChatResidentBandStore({ start: 0, end: 5 });
    expect(store.subscribeFor(1)).toBe(store.subscribeFor(1));
    const listener = vi.fn();
    const off = store.subscribeFor(1)(listener);

    // Row 1 stays inside [1, 6); only 0 leaves and 5 enters.
    store.setBand({ start: 1, end: 6 });
    expect(listener).not.toHaveBeenCalled();

    off();
    store.setBand({ start: 2, end: 6 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("bumps one row's height revision and notifies only that row", () => {
    // Arrange
    const store = createChatResidentBandStore({ start: 0, end: 10 });
    const seen: number[] = [];
    store.subscribeFor(4)(() => seen.push(4));
    store.subscribeFor(5)(() => seen.push(5));
    expect(store.heightRevision(4)).toBe(0);

    // Act
    store.notifyHeightChanged(4);

    // Assert: the changed row re-renders; the revision is monotonic.
    expect(seen).toEqual([4]);
    expect(store.heightRevision(4)).toBe(1);
    expect(store.heightRevision(5)).toBe(0);
    store.notifyHeightChanged(4);
    expect(store.heightRevision(4)).toBe(2);
  });

  it("drops per-row state on clearRowState and keeps serving subscribers", () => {
    // Arrange
    const store = createChatResidentBandStore({ start: 0, end: 10 });
    store.notifyHeightChanged(4);
    expect(store.heightRevision(4)).toBe(1);

    // Act
    store.clearRowState();

    // Assert: revisions reset; a fresh subscription still observes band changes.
    expect(store.heightRevision(4)).toBe(0);
    expect(store.subscribeFor(4)).toBe(store.subscribeFor(4));
    const listener = vi.fn();
    store.subscribeFor(4)(listener);
    store.setBand({ start: 5, end: 15 });
    expect(listener).toHaveBeenCalled();
  });
});

describe("shellsCrossingViewport", () => {
  it("returns the shell rows inside the viewport and nothing else", () => {
    const rows = [
      { index: 0, top: -50, bottom: 50, shell: true },
      { index: 1, top: 50, bottom: 150, shell: false },
      { index: 2, top: 150, bottom: 250, shell: true },
      { index: 3, top: 250, bottom: 350, shell: true },
    ];

    expect(shellsCrossingViewport(rows, 100, 300)).toEqual([2, 3]);
    expect(shellsCrossingViewport(rows, 0, 40)).toEqual([0]);
    expect(shellsCrossingViewport(rows, 1000, 1200)).toEqual([]);
  });
});
