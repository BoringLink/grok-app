/**
 * Measured display frame cadence.
 *
 * The transcript viewport must behave the same on a 60 Hz panel, a 120 Hz
 * ProMotion panel and a mixed multi-display setup, where `requestAnimationFrame`
 * follows the main display and can land late for a window that sits on another
 * one. A hardcoded frame duration cannot: this records the interval the engine
 * actually delivers, so a scheduling fallback and the trace scale with the
 * display the window is on instead of assuming one refresh rate.
 *
 * The value is a module global on purpose (like the trace's mirror of the pin
 * state): the frame cadence is a property of the display, not of one hook, and
 * every consumer reads the same estimate. A stalled or throttled tab delivers a
 * huge interval; the range guard rejects it so it cannot poison the estimate.
 */

/** Seed before the engine has delivered a frame — one 60 Hz frame. */
export const DEFAULT_FRAME_INTERVAL_MS = 1000 / 60;
/** Intervals outside this range are not a display frame (stall, clamp, clock jump). */
export const FRAME_INTERVAL_MIN_MS = 4;
export const FRAME_INTERVAL_MAX_MS = 40;
/** Weight of the newest sample in the exponential moving average. */
const EWMA_WEIGHT = 0.3;

let intervalMs = DEFAULT_FRAME_INTERVAL_MS;
let lastFrameAtMs: number | null = null;

/**
 * Record one delivered animation frame. Called from a `requestAnimationFrame`
 * callback (and the dev trace's rAF sampler), so the estimate converges on the
 * cadence the window actually receives.
 */
export function noteAnimationFrame(nowMs: number): void {
  if (!Number.isFinite(nowMs)) return;
  if (lastFrameAtMs != null) {
    const delta = nowMs - lastFrameAtMs;
    if (delta >= FRAME_INTERVAL_MIN_MS && delta <= FRAME_INTERVAL_MAX_MS) {
      intervalMs = intervalMs * (1 - EWMA_WEIGHT) + delta * EWMA_WEIGHT;
    }
  }
  lastFrameAtMs = nowMs;
}

/** Current estimate of the display frame interval, in ms. */
export function measuredFrameIntervalMs(): number {
  return intervalMs;
}

/** Estimated refresh rate, in Hz, from the measured interval. */
export function measuredRefreshRateHz(): number {
  return 1000 / intervalMs;
}

/** Refresh rates a display actually advertises, for change detection. */
const NOMINAL_REFRESH_RATES_HZ = [60, 75, 90, 120, 144, 165, 240] as const;

/**
 * Nearest nominal refresh rate to the measured one. Use it to detect a display
 * / refresh-rate change (e.g. 120 Hz ↔ 60 Hz) without flapping on the jitter of
 * a single measured interval.
 */
export function nominalRefreshRateHz(): number {
  const hz = 1000 / intervalMs;
  return NOMINAL_REFRESH_RATES_HZ.reduce((best, candidate) =>
    Math.abs(candidate - hz) < Math.abs(best - hz) ? candidate : best,
  );
}

/**
 * Wait before committing frame-scheduled work when `requestAnimationFrame` is
 * late. Half the measured frame interval keeps the commit roughly half a frame
 * ahead of a delivery that missed its vsync, without assuming 60 Hz. The floor
 * is deliberately far below one frame: a floor of ~4ms would return a whole
 * frame at 240 Hz instead of half of one.
 */
export const FRAME_FALLBACK_MIN_MS = 1;

export function frameFallbackMs(): number {
  return Math.max(FRAME_FALLBACK_MIN_MS, intervalMs * 0.5);
}

/** How many frame intervals of silence mean "rAF is paused, not late". */
export const PAUSED_RAF_FRAME_MULTIPLE = 4;
export const PAUSED_RAF_FALLBACK_MIN_MS = 16;
export const PAUSED_RAF_FALLBACK_MAX_MS = 500;

/**
 * Wait before assuming `requestAnimationFrame` is paused (an occluded or
 * backgrounded window), used to clear the transcript's per-frame restore latch
 * when no frame arrives. A multiple of the measured interval, so while frames
 * are flowing the frame path still wins and the "one restore per frame" budget
 * holds; only a real stall reaches the timer.
 */
export function pausedRafFallbackMs(): number {
  return Math.min(
    PAUSED_RAF_FALLBACK_MAX_MS,
    Math.max(
      PAUSED_RAF_FALLBACK_MIN_MS,
      intervalMs * PAUSED_RAF_FRAME_MULTIPLE,
    ),
  );
}

/**
 * Drop the estimate back to the seed. A test seam (mirrors the trace's
 * `setChatViewportTraceEnabled`): production re-learns a display change on its
 * own, because the moving average re-converges as new frames arrive.
 */
export function resetFrameCadence(): void {
  intervalMs = DEFAULT_FRAME_INTERVAL_MS;
  lastFrameAtMs = null;
}
