/**
 * Chat transcript layout ledger (几何账本).
 *
 * Single source of truth for the transcript's row geometry: how tall every row
 * is and where it starts. The viewport controller reads offsets, the total
 * container height and the band that must carry real content from here instead
 * of deriving geometry from the DOM. Pure module: no DOM, no React, no timers,
 * no scroll writes.
 *
 * Three height tiers, in priority order:
 *   measured   — a real render was observed for this row
 *   remembered — a height carried over from a persisted transcript
 *   estimate   — a guess for a row that has never been rendered
 *
 * An estimate may only ever describe a never-rendered row: a write whose source
 * ranks below the row's current source is rejected, so a late estimate can never
 * move a row the user has already seen. That tier boundary is also the exact
 * limit of the scrollbar promise: the resident list sets a shell's height from
 * this ledger, so the total — and the scrollbar drawn from it — is exact for
 * every measured row and estimated only for rows never rendered yet.
 *
 * Memory: heights (Float64Array) + offsets (Float64Array, count + 1) + sources
 * (Uint8Array) = 17 bytes per row plus one 8-byte offset slot. At the design
 * scale of 10k rows that is ~170KB, and ~1.7MB at 100k rows — two orders of
 * magnitude under the 20MB ledger budget from the spec, so resident DOM rows,
 * not the ledger, are the memory constraint.
 *
 * Incremental rebuild: a write burst collapses into one dirty span [lo, hi).
 * Only offsets[lo + 1..hi] are summed again from row heights, and only the tail
 * after hi is shifted by the span's delta. A burst therefore costs O(dirty)
 * height reads + O(tail) additions instead of re-summing every row per change.
 */

/** Height provenance of one row, in ascending priority. */
export type LayoutRowSource = "estimate" | "remembered" | "measured";

/** One height write. */
export type LayoutRowHeight = {
  index: number;
  height: number;
  source: LayoutRowSource;
  /**
   * Generation this measurement was taken at, when the caller can stamp it. A
   * measurement older than the row's current generation is rejected, so a
   * measurement queued before a {@link LayoutLedger.reestimateRow} cannot undo
   * the demotion (see that method).
   */
  generation?: number;
};

/** Rows that must carry real content for one viewport position. */
export type LayoutBand = {
  /** Inclusive first row of the band. */
  start: number;
  /** Exclusive end of the band. */
  end: number;
  /** Top offset of `start` (px). */
  top: number;
  /** Offset of the last band row's bottom (px). */
  bottom: number;
};

export type LayoutBandRequest = {
  scrollTop: number;
  viewportHeight: number;
  /** Extra px kept real above and below the viewport. Caller owns the policy. */
  overscan?: number;
};

export type LayoutLedgerOptions = {
  count: number;
  /** Per-row estimate, or one constant for every row. */
  estimateHeight: number | ((index: number) => number);
};

/**
 * Rebuild work since creation. `rebuiltRows` is the dirty span re-summed from
 * row heights; `shiftedRows` is the suffix carried by the span delta.
 */
export type LayoutLedgerStats = {
  rebuilds: number;
  rebuiltRows: number;
  shiftedRows: number;
};

export type LayoutLedger = {
  /**
   * Record one row height. Returns true when the row's effective height
   * changed (offsets moved), false when the write was rejected or was a
   * source-only upgrade at the same height.
   */
  setRowHeight(
    index: number,
    height: number,
    source: LayoutRowSource,
    generation?: number,
  ): boolean;
  /** Batched writes, collapsed into one dirty span. Returns rows that changed. */
  applyRowHeights(changes: readonly LayoutRowHeight[]): number;
  /**
   * Force a row back to the estimate tier, even after it was measured.
   *
   * Used for a row that is outside the viewport band (a shell): when the model
   * knows the row's collapsible content changed while it was a shell — a
   * thinking / tool block folded — the remembered measured height describes
   * content that is gone, so the scrollbar would under-report the shrink until
   * the row is rendered again. Demoting it to the estimate lets the total, and
   * the scrollbar drawn from it, follow the collapse immediately; the next real
   * render measures the row exactly and upgrades it back to `measured`.
   *
   * This deliberately bypasses the tier rule in {@link setRowHeight}: that rule
   * protects a measured row from a stale estimate, which is exactly what must
   * NOT happen when the estimate is the newer, correct shape.
   *
   * It is authoritative: it bumps the row's generation, so a measurement taken
   * before this call — even one queued in the same frame — is rejected by
   * {@link setRowHeight} instead of restoring the old shape.
   */
  reestimateRow(index: number, height: number): boolean;
  /**
   * The row's current generation. A caller stamps a measurement with the
   * generation it observed at, so a measurement queued across a
   * {@link reestimateRow} is rejected rather than undoing the demotion.
   */
  generationOf(index: number): number;
  /** Grow / shrink the conversation. Appended rows start at the estimate. */
  setCount(count: number): void;
  rowCount(): number;
  /** Effective height of a row; 0 for an empty ledger. */
  heightOf(index: number): number;
  sourceOf(index: number): LayoutRowSource;
  /** Top offset of a row; `offsetOf(rowCount())` is the total height. */
  offsetOf(index: number): number;
  /**
   * Total conversation height. Exact for every row that has been measured;
   * a row that has never been rendered contributes its estimate, so the total
   * (and the scrollbar time draws from it) is an estimate only until that row
   * is measured once.
   */
  totalHeight(): number;
  /** Row containing a pixel. -1 for an empty ledger. */
  indexAtOffset(px: number): number;
  bandFor(request: LayoutBandRequest): LayoutBand;
  stats(): LayoutLedgerStats;
};

/**
 * Fallback when a caller's estimate is not a finite, non-negative number.
 * Matches CHAT_DEFAULT_ROW_ESTIMATE_PX so estimate mistakes keep today's row
 * sizing instead of collapsing rows to zero.
 */
export const LEDGER_FALLBACK_ESTIMATE_PX = 120;

const SOURCE_RANK: Record<LayoutRowSource, number> = {
  estimate: 0,
  remembered: 1,
  measured: 2,
};

const SOURCE_NAME: readonly LayoutRowSource[] = [
  "estimate",
  "remembered",
  "measured",
];

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function createLayoutLedger(options: LayoutLedgerOptions): LayoutLedger {
  const estimateFor = (index: number): number => {
    const raw =
      typeof options.estimateHeight === "function"
        ? options.estimateHeight(index)
        : options.estimateHeight;
    return Number.isFinite(raw) && raw >= 0 ? raw : LEDGER_FALLBACK_ESTIMATE_PX;
  };

  let count = normalizeCount(options.count);
  let capacity = Math.max(1, count);
  let heights = new Float64Array(capacity);
  let offsets = new Float64Array(capacity + 1);
  let sources = new Uint8Array(capacity);
  let generations = new Float64Array(capacity);
  const stats: LayoutLedgerStats = {
    rebuilds: 0,
    rebuiltRows: 0,
    shiftedRows: 0,
  };

  for (let i = 0; i < count; i++) {
    heights[i] = estimateFor(i);
    offsets[i + 1] = offsets[i] + heights[i];
  }

  const ensureCapacity = (next: number): void => {
    if (next <= capacity) return;
    const grown = Math.max(next, capacity * 2);
    const nextHeights = new Float64Array(grown);
    nextHeights.set(heights.subarray(0, count));
    const nextOffsets = new Float64Array(grown + 1);
    nextOffsets.set(offsets.subarray(0, count + 1));
    const nextSources = new Uint8Array(grown);
    nextSources.set(sources.subarray(0, count));
    const nextGenerations = new Float64Array(grown);
    nextGenerations.set(generations.subarray(0, count));
    heights = nextHeights;
    offsets = nextOffsets;
    sources = nextSources;
    generations = nextGenerations;
    capacity = grown;
  };

  /**
   * Re-sum the rows inside [lo, hi) and carry the span's delta over the tail.
   * Re-summing every row instead is what made a mount storm re-derive the whole
   * prefix table on each commit.
   */
  const rebuild = (lo: number, hi: number): void => {
    const before = offsets[hi];
    let sum = offsets[lo];
    for (let i = lo; i < hi; i++) {
      sum += heights[i];
      offsets[i + 1] = sum;
    }
    const delta = offsets[hi] - before;
    stats.rebuilds += 1;
    stats.rebuiltRows += hi - lo;
    if (delta === 0) return;
    stats.shiftedRows += count - hi;
    for (let i = hi + 1; i <= count; i++) {
      offsets[i] += delta;
    }
  };

  const writeHeights = (changes: readonly LayoutRowHeight[]): number => {
    let lo = count;
    let hi = 0;
    let changed = 0;
    for (const change of changes) {
      if (!change) continue;
      const rank: number | undefined = SOURCE_RANK[change.source];
      const index = Math.floor(change.index);
      if (rank === undefined) continue;
      if (!Number.isFinite(index) || index < 0 || index >= count) continue;
      const height = change.height;
      if (!Number.isFinite(height) || height < 0) continue;
      // A measurement taken before this row's last re-estimate describes the
      // old shape; refuse it so it cannot undo the demotion.
      if (
        change.generation != null &&
        change.generation < generations[index]
      ) {
        continue;
      }
      // Tier rule: a lower tier never overwrites a higher one, so a stale
      // estimate cannot move a row that has already been rendered.
      if (sources[index] > rank) continue;
      const heightChanged = heights[index] !== height;
      if (!heightChanged && sources[index] === rank) continue;
      heights[index] = height;
      sources[index] = rank;
      if (!heightChanged) continue;
      if (index < lo) lo = index;
      if (index + 1 > hi) hi = index + 1;
      changed += 1;
    }
    if (changed === 0) return 0;
    rebuild(lo, hi);
    return changed;
  };

  const setCount = (next: number): void => {
    const target = normalizeCount(next);
    if (target === count) return;
    if (target < count) {
      // Trailing rows are dropped; the prefix stays valid for the new length.
      count = target;
      return;
    }
    ensureCapacity(target);
    const from = count;
    count = target;
    for (let i = from; i < count; i++) {
      heights[i] = estimateFor(i);
      sources[i] = SOURCE_RANK.estimate;
      generations[i] = 0;
    }
    // Appended rows only change the suffix of the prefix table.
    let sum = offsets[from];
    for (let i = from; i < count; i++) {
      sum += heights[i];
      offsets[i + 1] = sum;
    }
    stats.rebuilds += 1;
    stats.rebuiltRows += count - from;
  };

  const clampIndex = (index: number, max: number): number => {
    if (!Number.isFinite(index)) return 0;
    const i = Math.floor(index);
    if (i < 0) return 0;
    return i > max ? max : i;
  };

  const indexAtOffset = (px: number): number => {
    if (count === 0) return -1;
    // NaN / negative / rubber-band overshoot all clamp to the first row.
    const y = px > 0 ? px : 0;
    // Upper bound over offsets[1..count]: the first row whose bottom is past
    // `px`. Zero-height plateaus are skipped, so a pixel belongs to the first
    // row that actually occupies it.
    let lo = 1;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };

  /** First row index whose top is at or past `y`; `count` when none. */
  const firstRowStartingAtOrAfter = (y: number): number => {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const reestimate = (index: number, height: number): boolean => {
    if (!Number.isFinite(index) || index < 0 || index >= count) return false;
    if (!Number.isFinite(height) || height < 0) return false;
    const i = Math.floor(index);
    // Bump first: the demotion must outrank any measurement still in flight for
    // the old shape, even when the new estimate happens to equal the old height.
    generations[i] += 1;
    if (heights[i] === height && sources[i] === SOURCE_RANK.estimate) {
      return false;
    }
    heights[i] = height;
    sources[i] = SOURCE_RANK.estimate;
    rebuild(i, i + 1);
    return true;
  };

  return {
    setRowHeight(index, height, source, generation) {
      return writeHeights([{ index, height, source, generation }]) > 0;
    },

    applyRowHeights(changes) {
      return writeHeights(changes);
    },

    reestimateRow(index, height) {
      return reestimate(index, height);
    },

    generationOf(index) {
      if (count === 0) return 0;
      return generations[clampIndex(index, count - 1)];
    },

    setCount,

    rowCount() {
      return count;
    },

    heightOf(index) {
      if (count === 0) return 0;
      return heights[clampIndex(index, count - 1)];
    },

    sourceOf(index) {
      if (count === 0) return "estimate";
      return SOURCE_NAME[sources[clampIndex(index, count - 1)]];
    },

    offsetOf(index) {
      return offsets[clampIndex(index, count)];
    },

    totalHeight() {
      return offsets[count];
    },

    indexAtOffset,

    bandFor(request) {
      if (count === 0) return { start: 0, end: 0, top: 0, bottom: 0 };
      const rawOverscan = request.overscan ?? 0;
      const viewportHeight = Math.max(
        0,
        Number.isFinite(request.viewportHeight) ? request.viewportHeight : 0,
      );
      const overscan = Math.max(
        0,
        Number.isFinite(rawOverscan) ? rawOverscan : 0,
      );
      const scrollTop = Math.min(
        Math.max(0, Number.isFinite(request.scrollTop) ? request.scrollTop : 0),
        // Clamp like the engine would: a stale or overshooting scrollTop still
        // describes rows that exist.
        Math.max(0, offsets[count] - viewportHeight),
      );
      const start = indexAtOffset(Math.max(0, scrollTop - overscan));
      // No fixed row cap — the band is whatever the viewport plus margin spans.
      const end = Math.max(
        firstRowStartingAtOrAfter(scrollTop + viewportHeight + overscan),
        start + 1,
      );
      return { start, end, top: offsets[start], bottom: offsets[end] };
    },

    stats() {
      return { ...stats };
    },
  };
}
