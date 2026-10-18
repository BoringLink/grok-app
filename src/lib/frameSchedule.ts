/**
 * Schedule work for the next paint, with a measured-cadence fallback.
 *
 * `requestAnimationFrame` follows the **main** display's vsync. On macOS with a
 * 120 Hz built-in panel and a 75 Hz external, a window on the external can miss
 * a vsync and the next rAF lands a frame late. A timeout sized from the
 * measured frame interval still commits the scroll burst if rAF is late — and
 * unlike a fixed 60 Hz constant it follows whichever display the window is on.
 */

import { frameFallbackMs, noteAnimationFrame } from "@/lib/frameCadence";

export type FrameSchedule = {
  raf: number | null;
  timeout: ReturnType<typeof setTimeout> | null;
};

export function emptyFrameSchedule(): FrameSchedule {
  return { raf: null, timeout: null };
}

export function isFrameSchedulePending(s: FrameSchedule): boolean {
  return s.raf != null || s.timeout != null;
}

export type FrameScheduleHost = {
  raf: (cb: FrameRequestCallback) => number;
  cancelRaf: (id: number) => void;
  timeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

const defaultHost: FrameScheduleHost = {
  raf: (cb) => requestAnimationFrame(cb),
  cancelRaf: (id) => cancelAnimationFrame(id),
  timeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function cancelFrameSchedule(
  state: FrameSchedule,
  host: FrameScheduleHost = defaultHost,
): void {
  if (state.raf != null) {
    host.cancelRaf(state.raf);
    state.raf = null;
  }
  if (state.timeout != null) {
    host.clearTimeout(state.timeout);
    state.timeout = null;
  }
}

/** Arm once; later calls no-op until the scheduled run fires or is cancelled. */
export function scheduleOnFrame(
  state: FrameSchedule,
  run: () => void,
  host: FrameScheduleHost = defaultHost,
): void {
  armFrameSchedule(state, run, frameFallbackMs(), host);
}

/**
 * Like {@link scheduleOnFrame}, but with a caller-supplied fallback. Use it
 * when the fallback is not "commit half a frame early" but "assume the frame
 * loop is stalled" (see `pausedRafFallbackMs`).
 */
export function scheduleOnFrameWithin(
  state: FrameSchedule,
  run: () => void,
  fallbackMs: number,
  host: FrameScheduleHost = defaultHost,
): void {
  armFrameSchedule(state, run, fallbackMs, host);
}

function armFrameSchedule(
  state: FrameSchedule,
  run: () => void,
  fallbackMs: number,
  host: FrameScheduleHost,
): void {
  if (state.raf != null || state.timeout != null) return;
  const fire = () => {
    cancelFrameSchedule(state, host);
    run();
  };
  state.raf = host.raf((timestamp) => {
    // A delivered frame is the only cadence the window actually receives; the
    // fallback below is sized from it, so it must be recorded on this path.
    noteAnimationFrame(timestamp > 0 ? timestamp : nowMs());
    fire();
  });
  state.timeout = host.timeout(fire, fallbackMs);
}
