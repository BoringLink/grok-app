import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_INTERVAL_MIN_MS,
  measuredFrameIntervalMs,
  noteAnimationFrame,
  resetFrameCadence,
} from "./frameCadence";
import {
  cancelFrameSchedule,
  emptyFrameSchedule,
  isFrameSchedulePending,
  scheduleOnFrame,
  type FrameScheduleHost,
} from "./frameSchedule";

function mockHost() {
  let rafId = 0;
  let toId = 0;
  const rafs = new Map<number, FrameRequestCallback>();
  const tos = new Map<number, () => void>();
  let lastTimeoutMs = -1;
  const host: FrameScheduleHost = {
    raf: (cb) => {
      const id = ++rafId;
      rafs.set(id, cb);
      return id;
    },
    cancelRaf: (id) => {
      rafs.delete(id);
    },
    timeout: (cb, ms) => {
      lastTimeoutMs = ms;
      const id = ++toId;
      tos.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => {
      tos.delete(id as unknown as number);
    },
  };
  return {
    host,
    lastTimeoutMs: () => lastTimeoutMs,
    flushRaf: (timestamp = 16.7) => {
      const first = rafs.entries().next().value;
      if (!first) return;
      const [id, cb] = first;
      rafs.delete(id);
      cb(timestamp);
    },
    flushTimeout: () => {
      const first = tos.entries().next().value;
      if (!first) return;
      const [id, cb] = first;
      tos.delete(id);
      cb();
    },
    rafCount: () => rafs.size,
    timeoutCount: () => tos.size,
  };
}

beforeEach(resetFrameCadence);

describe("scheduleOnFrame", () => {
  it("runs once when rAF fires and clears pending state", () => {
    const m = mockHost();
    const state = emptyFrameSchedule();
    const run = vi.fn();
    scheduleOnFrame(state, run, m.host);
    expect(isFrameSchedulePending(state)).toBe(true);
    scheduleOnFrame(state, run, m.host);
    expect(m.rafCount()).toBe(1);
    m.flushRaf();
    expect(run).toHaveBeenCalledTimes(1);
    expect(isFrameSchedulePending(state)).toBe(false);
  });

  it("runs once when timeout fires before rAF and clears dual channels", () => {
    const m = mockHost();
    const state = emptyFrameSchedule();
    const run = vi.fn();
    scheduleOnFrame(state, run, m.host);
    expect(isFrameSchedulePending(state)).toBe(true);
    expect(m.rafCount()).toBe(1);
    expect(m.timeoutCount()).toBe(1);
    m.flushTimeout();
    expect(run).toHaveBeenCalledTimes(1);
    expect(isFrameSchedulePending(state)).toBe(false);
    expect(m.rafCount()).toBe(0);
    expect(m.timeoutCount()).toBe(0);
  });

  it("feeds the measured cadence from the delivered rAF timestamp", () => {
    const m = mockHost();
    // Arrange — two deliveries with a 120 Hz gap.
    scheduleOnFrame(emptyFrameSchedule(), vi.fn(), m.host);
    m.flushRaf(16.7);
    scheduleOnFrame(emptyFrameSchedule(), vi.fn(), m.host);
    m.flushRaf(25.0);

    // Assert — the estimate moved down from the 60 Hz seed toward 120 Hz.
    expect(measuredFrameIntervalMs()).toBeLessThan(1000 / 60);
  });

  it("sizes the fallback from the measured interval, so 120 Hz waits less than 60 Hz", () => {
    // Arrange — a converged 120 Hz cadence.
    for (let i = 0; i < 30; i++) noteAnimationFrame(i * 8.3);
    const m120 = mockHost();
    scheduleOnFrame(emptyFrameSchedule(), vi.fn(), m120.host);
    const fast = m120.lastTimeoutMs();

    // Arrange — a converged 60 Hz cadence.
    resetFrameCadence();
    for (let i = 0; i < 30; i++) noteAnimationFrame(i * 16.7);
    const m60 = mockHost();
    scheduleOnFrame(emptyFrameSchedule(), vi.fn(), m60.host);
    const slow = m60.lastTimeoutMs();

    // Assert — cadence-proportional, never a fixed constant.
    expect(fast).toBeGreaterThanOrEqual(FRAME_INTERVAL_MIN_MS);
    expect(fast).toBeLessThan(slow);
    expect(slow).toBeLessThan(1000 / 60);
  });

  it("cancelFrameSchedule cancels pending rAF", () => {
    const m = mockHost();
    const state = emptyFrameSchedule();
    const run = vi.fn();
    scheduleOnFrame(state, run, m.host);
    cancelFrameSchedule(state, m.host);
    expect(isFrameSchedulePending(state)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
