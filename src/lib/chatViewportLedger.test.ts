import { describe, expect, it } from "vitest";
import {
  createLayoutLedger,
  LEDGER_FALLBACK_ESTIMATE_PX,
  type LayoutRowSource,
} from "./chatViewportLedger";

const ROW = 100;

/**
 * Offsets recomputed from scratch — the incremental rebuild has to match this
 * after any burst.
 */
function prefixSums(heights: readonly number[]): number[] {
  const out: number[] = [0];
  heights.forEach((height) => out.push(out[out.length - 1] + height));
  return out;
}

function seededInts(seed: number): (max: number) => number {
  let state = seed;
  return (max: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % max;
  };
}

describe("offsets and total height", () => {
  it("answers the first row, the last row and the total", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 4, estimateHeight: 120 });

    // Act
    ledger.setRowHeight(1, 240, "measured");
    ledger.setRowHeight(3, 0, "measured");

    // Assert
    expect(ledger.offsetOf(0)).toBe(0);
    expect(ledger.offsetOf(1)).toBe(120);
    expect(ledger.offsetOf(2)).toBe(360);
    expect(ledger.offsetOf(3)).toBe(480);
    expect(ledger.offsetOf(4)).toBe(480);
    expect(ledger.totalHeight()).toBe(480);
    expect(ledger.heightOf(3)).toBe(0);
  });

  it("holds a single-row conversation", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 1, estimateHeight: 120 });

    // Act / Assert
    expect(ledger.offsetOf(0)).toBe(0);
    expect(ledger.offsetOf(1)).toBe(120);
    expect(ledger.totalHeight()).toBe(120);
    expect(ledger.indexAtOffset(0)).toBe(0);
    expect(ledger.indexAtOffset(119.5)).toBe(0);
    expect(ledger.indexAtOffset(1_000_000)).toBe(0);
    expect(ledger.sourceOf(0)).toBe("estimate");
  });

  it("stays within 1px with fractional heights", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 4, estimateHeight: 100.4 });

    // Act
    ledger.setRowHeight(2, 75.6, "measured");

    // Assert
    expect(Math.abs(ledger.offsetOf(2) - 200.8)).toBeLessThan(1);
    expect(Math.abs(ledger.offsetOf(3) - 276.4)).toBeLessThan(1);
    expect(Math.abs(ledger.totalHeight() - 376.8)).toBeLessThan(1);
  });

  it("treats a bad estimate as the documented fallback", () => {
    // Arrange
    const ledger = createLayoutLedger({
      count: 2,
      estimateHeight: () => Number.NaN,
    });

    // Act / Assert
    expect(ledger.heightOf(0)).toBe(LEDGER_FALLBACK_ESTIMATE_PX);
    expect(ledger.totalHeight()).toBe(LEDGER_FALLBACK_ESTIMATE_PX * 2);
  });

  it("searches the row containing a pixel and clamps at both ends", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 5, estimateHeight: ROW });

    // Act / Assert
    expect(ledger.indexAtOffset(-50)).toBe(0);
    expect(ledger.indexAtOffset(0)).toBe(0);
    expect(ledger.indexAtOffset(99.5)).toBe(0);
    expect(ledger.indexAtOffset(100)).toBe(1);
    expect(ledger.indexAtOffset(250)).toBe(2);
    expect(ledger.indexAtOffset(499)).toBe(4);
    expect(ledger.indexAtOffset(500)).toBe(4);
    expect(ledger.indexAtOffset(Number.POSITIVE_INFINITY)).toBe(4);
  });

  it("reports an empty ledger without rows", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 0, estimateHeight: ROW });

    // Act / Assert
    expect(ledger.rowCount()).toBe(0);
    expect(ledger.totalHeight()).toBe(0);
    expect(ledger.indexAtOffset(0)).toBe(-1);
    expect(ledger.heightOf(0)).toBe(0);
    expect(ledger.sourceOf(0)).toBe("estimate");
    expect(ledger.bandFor({ scrollTop: 0, viewportHeight: 800 })).toEqual({
      start: 0,
      end: 0,
      top: 0,
      bottom: 0,
    });
  });
});

describe("height tiers", () => {
  it("moves never-rendered rows when the estimate changes", () => {
    // Arrange
    let estimate = 120;
    const ledger = createLayoutLedger({
      count: 4,
      estimateHeight: () => estimate,
    });

    // Act
    estimate = 300;

    // Assert
    expect(ledger.setRowHeight(2, 300, "estimate")).toBe(true);
    expect(ledger.heightOf(2)).toBe(300);
    expect(ledger.sourceOf(2)).toBe("estimate");
    expect(ledger.totalHeight()).toBe(120 + 120 + 300 + 120);
  });

  it("never lets a late estimate move a measured row", () => {
    // Arrange
    let estimate = 120;
    const ledger = createLayoutLedger({
      count: 3,
      estimateHeight: () => estimate,
    });
    ledger.setRowHeight(1, 400, "measured");
    const before = ledger.offsetOf(2);

    // Act
    estimate = 900;
    const accepted = ledger.setRowHeight(1, 900, "estimate");

    // Assert
    expect(accepted).toBe(false);
    expect(ledger.heightOf(1)).toBe(400);
    expect(ledger.sourceOf(1)).toBe("measured");
    expect(ledger.offsetOf(2)).toBe(before);
    expect(ledger.totalHeight()).toBe(120 + 400 + 120);
  });

  it("never lets a late estimate move a remembered row", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });
    ledger.setRowHeight(1, 260, "remembered");
    const before = ledger.totalHeight();

    // Act
    const accepted = ledger.setRowHeight(1, 900, "estimate");

    // Assert
    expect(accepted).toBe(false);
    expect(ledger.sourceOf(1)).toBe("remembered");
    expect(ledger.totalHeight()).toBe(before);
  });

  it("keeps measured above remembered", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });

    // Act
    const first = ledger.setRowHeight(1, 400, "measured");
    const downgrade = ledger.setRowHeight(1, 250, "remembered");
    const remeasure = ledger.setRowHeight(1, 300, "measured");

    // Assert
    expect(first).toBe(true);
    expect(downgrade).toBe(false);
    expect(remeasure).toBe(true);
    expect(ledger.heightOf(1)).toBe(300);
    expect(ledger.sourceOf(1)).toBe("measured");
    expect(ledger.totalHeight()).toBe(120 + 300 + 120);
  });

  it("records a source upgrade at the same height without moving offsets", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });
    const before = ledger.offsetOf(2);

    // Act
    const unchanged = ledger.setRowHeight(0, 120, "measured");
    const stale = ledger.setRowHeight(0, 900, "estimate");

    // Assert
    expect(unchanged).toBe(false);
    expect(stale).toBe(false);
    expect(ledger.sourceOf(0)).toBe("measured");
    expect(ledger.heightOf(0)).toBe(120);
    expect(ledger.offsetOf(2)).toBe(before);
  });

  it("rejects invalid writes without touching geometry or doing rebuild work", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });

    // Act
    const writes = [
      ledger.setRowHeight(-1, 500, "measured"),
      ledger.setRowHeight(3, 500, "measured"),
      ledger.setRowHeight(0, Number.NaN, "measured"),
      ledger.setRowHeight(0, -10, "measured"),
      ledger.setRowHeight(0, 500, "junk" as LayoutRowSource),
    ];

    // Assert
    expect(writes).toEqual([false, false, false, false, false]);
    expect(ledger.totalHeight()).toBe(360);
    expect(ledger.stats()).toMatchObject({
      rebuilds: 0,
      rebuiltRows: 0,
      shiftedRows: 0,
    });
  });

  it("reports the exact typed-array footprint of its storage", () => {
    // Arrange — 10k rows at the spec's design scale.
    const ledger = createLayoutLedger({ count: 10_000, estimateHeight: 120 });

    // Act
    const { memoryBytes } = ledger.stats();

    // Assert — heights + offsets (count + 1) + sources + generations, i.e.
    // 8 + 8 + 1 + 8 bytes per row plus the extra offset slot. ~250KB, far under
    // the spec's 20MB ledger budget.
    expect(memoryBytes).toBe(10_000 * 25 + 8);
    expect(memoryBytes).toBeLessThan(20 * 1024 * 1024);
  });
});

describe("reestimateRow", () => {
  it("demotes a measured row so the total follows a collapse", () => {
    // Arrange: row 1 was rendered expanded and measured at 500.
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });
    ledger.setRowHeight(1, 500, "measured");
    expect(ledger.totalHeight()).toBe(740);

    // Act: a model-known collapse re-seeds it from the collapsed estimate.
    const changed = ledger.reestimateRow(1, 60);

    // Assert
    expect(changed).toBe(true);
    expect(ledger.heightOf(1)).toBe(60);
    expect(ledger.sourceOf(1)).toBe("estimate");
    expect(ledger.totalHeight()).toBe(300);
    expect(ledger.offsetOf(2)).toBe(180);
  });

  it("lets a later measurement upgrade the row back to measured", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });
    ledger.setRowHeight(1, 500, "measured");
    ledger.reestimateRow(1, 60);

    // Act: the row scrolls back into the band and is measured at its real size.
    const upgraded = ledger.setRowHeight(1, 70, "measured");

    // Assert
    expect(upgraded).toBe(true);
    expect(ledger.sourceOf(1)).toBe("measured");
    expect(ledger.heightOf(1)).toBe(70);
    expect(ledger.totalHeight()).toBe(310);
  });

  it("is a no-op when the estimate already matches", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });
    const before = ledger.stats().rebuilds;

    // Act
    const changed = ledger.reestimateRow(0, 120);

    // Assert
    expect(changed).toBe(false);
    expect(ledger.stats().rebuilds).toBe(before);
  });

  it("rejects an out-of-range index or an invalid height", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });

    // Act
    const writes = [
      ledger.reestimateRow(-1, 60),
      ledger.reestimateRow(3, 60),
      ledger.reestimateRow(0, Number.NaN),
      ledger.reestimateRow(0, -10),
    ];

    // Assert
    expect(writes).toEqual([false, false, false, false]);
    expect(ledger.totalHeight()).toBe(360);
  });

  it("reports an empty ledger without rows", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });

    // Act / Assert
    expect(ledger.reestimateRow(0, 60)).toBe(false);
  });

  it("rejects a measurement taken before the demotion", () => {
    // Arrange: row 1 was measured expanded at generation 0.
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });
    ledger.setRowHeight(1, 500, "measured", ledger.generationOf(1));
    const staleGeneration = ledger.generationOf(1);

    // Act: the fold demotes the row, then the old measurement is delivered late.
    ledger.reestimateRow(1, 60);
    const restored = ledger.setRowHeight(1, 500, "measured", staleGeneration);

    // Assert: the demotion is authoritative.
    expect(restored).toBe(false);
    expect(ledger.heightOf(1)).toBe(60);
    expect(ledger.sourceOf(1)).toBe("estimate");
  });

  it("accepts a measurement taken at the current generation", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 120 });
    ledger.setRowHeight(1, 500, "measured", ledger.generationOf(1));
    ledger.reestimateRow(1, 60);

    // Act: the row is rendered again and measured for the collapsed shape.
    const accepted = ledger.setRowHeight(
      1,
      80,
      "measured",
      ledger.generationOf(1),
    );

    // Assert
    expect(accepted).toBe(true);
    expect(ledger.heightOf(1)).toBe(80);
    expect(ledger.sourceOf(1)).toBe("measured");
  });

  it("bumps the generation on every demotion", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 2, estimateHeight: 120 });
    expect(ledger.generationOf(0)).toBe(0);

    // Act
    ledger.reestimateRow(0, 60);
    ledger.reestimateRow(0, 60);

    // Assert
    expect(ledger.generationOf(0)).toBe(2);
  });

  it("does not gate a measurement that carries no generation", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 2, estimateHeight: 120 });
    ledger.reestimateRow(0, 60);

    // Act / Assert
    expect(ledger.setRowHeight(0, 90, "measured")).toBe(true);
    expect(ledger.heightOf(0)).toBe(90);
  });
});

describe("row count changes", () => {
  it("keeps measured heights when the conversation grows", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 2, estimateHeight: 120 });
    ledger.setRowHeight(1, 200, "measured");

    // Act
    ledger.setCount(4);

    // Assert
    expect(ledger.rowCount()).toBe(4);
    expect(ledger.heightOf(1)).toBe(200);
    expect(ledger.sourceOf(1)).toBe("measured");
    expect(ledger.heightOf(3)).toBe(120);
    expect(ledger.offsetOf(3)).toBe(440);
    expect(ledger.totalHeight()).toBe(560);
    expect(ledger.offsetOf(4)).toBe(560);
  });

  it("drops trailing rows on shrink and re-estimates them on regrow", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 100 });
    ledger.setRowHeight(2, 250, "measured");

    // Act
    ledger.setCount(1);

    // Assert
    expect(ledger.totalHeight()).toBe(100);
    expect(ledger.offsetOf(1)).toBe(100);

    // Act
    ledger.setCount(3);

    // Assert
    expect(ledger.heightOf(2)).toBe(100);
    expect(ledger.sourceOf(2)).toBe("estimate");
    expect(ledger.totalHeight()).toBe(300);
  });

  it("keeps measured rows across a capacity reallocation", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 2, estimateHeight: 120 });
    ledger.setRowHeight(0, 400, "measured");

    // Act
    ledger.setCount(50);

    // Assert
    expect(ledger.rowCount()).toBe(50);
    expect(ledger.heightOf(0)).toBe(400);
    expect(ledger.sourceOf(0)).toBe("measured");
    expect(ledger.totalHeight()).toBe(400 + 120 * 49);
  });
});

describe("incremental rebuild", () => {
  const COUNT = 10_000;
  const BASE = 5_000;
  const BURST = 64;

  const burst = Array.from({ length: BURST }, (_, i) => ({
    index: BASE + i,
    height: 200 + i,
    source: "measured" as const,
  }));

  /** Same range, different heights, so every round does real rebuild work. */
  const burstFor = (round: number) =>
    Array.from({ length: BURST }, (_, i) => ({
      index: BASE + i,
      height: 200 + ((i + round) % 50),
      source: "measured" as const,
    }));

  it("keeps a burst on a 10k-row ledger in the microsecond range", () => {
    // Arrange
    const ROUNDS = 50;
    const WARMUP = 5;
    const batched = createLayoutLedger({ count: COUNT, estimateHeight: 120 });
    const singles = createLayoutLedger({ count: COUNT, estimateHeight: 120 });
    const writeSingles = (round: number) =>
      burstFor(round).forEach((c) =>
        singles.setRowHeight(c.index, c.height, c.source),
      );
    // Warm both paths: the printed figure is steady-state cost, not the first
    // call's JIT compile.
    for (let round = 0; round < WARMUP; round++) {
      batched.applyRowHeights(burstFor(round));
      writeSingles(round);
    }

    // Act
    const batchStart = performance.now();
    for (let round = 0; round < ROUNDS; round++) {
      batched.applyRowHeights(burstFor(round));
    }
    const batchUs = ((performance.now() - batchStart) * 1000) / ROUNDS;

    const singleStart = performance.now();
    for (let round = 0; round < ROUNDS; round++) {
      writeSingles(round);
    }
    const singlesUs = ((performance.now() - singleStart) * 1000) / ROUNDS;

    // Assert
    console.info(
      `[ledger] 10k rows: batch of ${BURST} writes ${batchUs.toFixed(2)}µs, ` +
        `${BURST} single writes ${singlesUs.toFixed(2)}µs`,
    );
    expect(batched.totalHeight()).toBe(singles.totalHeight());
    // Deliberately loose: shared CI runners are noisy and both paths are under
    // 0.2ms locally.
    expect(batchUs).toBeLessThan(2_000);
    expect(singlesUs).toBeLessThan(20_000);
  });

  it("rebuilds only the dirty range and carries the tail", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: COUNT, estimateHeight: 120 });

    // Act
    ledger.applyRowHeights(burst);

    // Assert
    expect(ledger.stats()).toMatchObject({
      rebuilds: 1,
      rebuiltRows: BURST,
      shiftedRows: COUNT - (BASE + BURST),
    });
  });

  it("rebuilds one row and carries the tail for a head write", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: COUNT, estimateHeight: 120 });

    // Act
    const changed = ledger.setRowHeight(0, 300, "measured");

    // Assert
    expect(changed).toBe(true);
    expect(ledger.stats()).toMatchObject({
      rebuilds: 1,
      rebuiltRows: 1,
      shiftedRows: COUNT - 1,
    });
    expect(ledger.totalHeight()).toBe(300 + 120 * (COUNT - 1));
  });

  it("matches a from-scratch prefix sum after a randomized wiring pass", () => {
    // Arrange
    const rows = 2_000;
    const ledger = createLayoutLedger({ count: rows, estimateHeight: 120 });
    const heights: number[] = new Array(rows).fill(120);
    const nextInt = seededInts(7);
    const changes = Array.from({ length: 500 }, () => {
      const index = nextInt(rows);
      const height = 40 + nextInt(400);
      heights[index] = height;
      return { index, height, source: "measured" as const };
    });

    // Act
    ledger.applyRowHeights(changes);

    // Assert
    const expected = prefixSums(heights);
    [0, 1, 500, 999, 1_500, 1_999, rows].forEach((index) => {
      expect(ledger.offsetOf(index)).toBeCloseTo(expected[index], 6);
    });
    expect(ledger.totalHeight()).toBeCloseTo(expected[rows], 6);
  });
});

describe("bandFor", () => {
  it("scales with the viewport instead of a fixed row cap", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 10_000, estimateHeight: ROW });

    // Act
    const short = ledger.bandFor({
      scrollTop: 20_000,
      viewportHeight: 400,
      overscan: 200,
    });
    const tall = ledger.bandFor({
      scrollTop: 20_000,
      viewportHeight: 2_000,
      overscan: 200,
    });

    // Assert
    expect(short.end - short.start).toBe(8);
    expect(tall.end - tall.start).toBe(24);
    // The band has no fixed row cap, so a tall viewport spans well past a dozen.
    expect(tall.end - tall.start).toBeGreaterThan(12);
    expect(tall.start).toBe(short.start);
  });

  it("covers every pixel the viewport and the margin ask for", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 10_000, estimateHeight: ROW });
    const total = ledger.totalHeight();
    const viewportHeight = 800;
    const overscan = 400;

    // Act / Assert
    [0, 1, 99, 100, 150_000, 500_000, 999_900, 10_000_000].forEach(
      (scrollTop) => {
        const band = ledger.bandFor({ scrollTop, viewportHeight, overscan });
        const clamped = Math.min(
          Math.max(0, scrollTop),
          Math.max(0, total - viewportHeight),
        );
        const bandTop = Math.max(0, clamped - overscan);
        const bandBottom = Math.min(clamped + viewportHeight + overscan, total);
        const top = ledger.offsetOf(band.start);
        const bottom = ledger.offsetOf(band.end);

        expect(band.end).toBeGreaterThan(band.start);
        expect(band.top).toBe(top);
        expect(band.bottom).toBe(bottom);
        expect(top).toBeLessThanOrEqual(bandTop + 0.5);
        expect(bottom).toBeGreaterThanOrEqual(bandBottom - 0.5);
        expect(bottom - top).toBeGreaterThanOrEqual(
          Math.min(viewportHeight, total) - 0.5,
        );
      },
    );
  });

  it("keeps the tail in the band when scrollTop is stale", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 10_000, estimateHeight: ROW });

    // Act
    const band = ledger.bandFor({
      scrollTop: 10_000_000,
      viewportHeight: 800,
      overscan: 200,
    });

    // Assert
    expect(band.end).toBe(10_000);
    expect(ledger.offsetOf(band.start)).toBeLessThanOrEqual(999_200);
    expect(ledger.offsetOf(band.end)).toBe(ledger.totalHeight());
  });

  it("covers the whole conversation when it is shorter than the viewport", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 3, estimateHeight: 100 });

    // Act
    const band = ledger.bandFor({
      scrollTop: 0,
      viewportHeight: 800,
      overscan: 200,
    });

    // Assert
    expect(band).toEqual({ start: 0, end: 3, top: 0, bottom: 300 });
  });

  it("skips zero-height rows at the band edge", () => {
    // Arrange: ten never-rendered rows at zero height between two real rows.
    const ledger = createLayoutLedger({ count: 12, estimateHeight: 0 });
    ledger.setRowHeight(0, 500, "measured");
    ledger.setRowHeight(11, 500, "measured");

    // Act
    const band = ledger.bandFor({
      scrollTop: 500,
      viewportHeight: 500,
      overscan: 0,
    });

    // Assert: the zero-height run carries no pixels, so the band starts at the
    // first row that actually occupies the requested pixel.
    expect(band.start).toBe(11);
    expect(band.end).toBe(12);
    expect(band.top).toBe(500);
    expect(band.bottom).toBe(1_000);
  });

  it("still returns one row for a zero-height viewport", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 10, estimateHeight: ROW });

    // Act
    const band = ledger.bandFor({
      scrollTop: 250,
      viewportHeight: 0,
      overscan: 0,
    });

    // Assert
    expect(band.start).toBe(2);
    expect(band.end).toBe(3);
  });

  it("tolerates missing and invalid viewport numbers", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 10, estimateHeight: ROW });

    // Act
    const band = ledger.bandFor({
      scrollTop: Number.NaN,
      viewportHeight: -100,
      overscan: Number.NaN,
    });

    // Assert
    expect(band.start).toBe(0);
    expect(band.end).toBe(1);
  });
});
