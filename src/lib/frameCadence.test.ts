import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FRAME_INTERVAL_MS,
  FRAME_INTERVAL_MAX_MS,
  FRAME_INTERVAL_MIN_MS,
  frameFallbackMs,
  measuredFrameIntervalMs,
  measuredRefreshRateHz,
  nominalRefreshRateHz,
  noteAnimationFrame,
  pausedRafFallbackMs,
  resetFrameCadence,
} from "./frameCadence";

beforeEach(resetFrameCadence);

describe("frameCadence", () => {
  it("seeds with one 60 Hz frame before any delivery", () => {
    // Arrange + Act + Assert
    expect(measuredFrameIntervalMs()).toBe(DEFAULT_FRAME_INTERVAL_MS);
    expect(measuredRefreshRateHz()).toBeCloseTo(60, 5);
  });

  it("converges on the interval the engine actually delivers", () => {
    // Arrange — a 120 Hz display delivers ~8.3ms frames.
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 8.3);

    // Act + Assert
    expect(measuredFrameIntervalMs()).toBeCloseTo(8.3, 1);
    expect(measuredRefreshRateHz()).toBeGreaterThan(110);
  });

  it("re-learns after a refresh-rate change", () => {
    // Arrange — 120 Hz, then the window moves to a 60 Hz display.
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 8.3);
    for (let i = 0; i < 40; i++) noteAnimationFrame(332 + i * 16.7);

    // Assert
    expect(measuredRefreshRateHz()).toBeCloseTo(60, 0);
  });

  it("rejects an interval outside the display range, so a stall cannot poison it", () => {
    // Arrange — one good frame, then a throttled/stalled tab gap.
    noteAnimationFrame(0);
    noteAnimationFrame(16.7);
    const settled = measuredFrameIntervalMs();

    // Act
    noteAnimationFrame(16.7 + 5000);
    noteAnimationFrame(16.7 + 5000 + 1);

    // Assert — the 1ms follow-up is also out of range (<4ms), so nothing moved.
    expect(measuredFrameIntervalMs()).toBe(settled);
  });

  it("sizes the fallback at half the measured interval, clamped", () => {
    // Arrange — a 60 Hz cadence.
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 16.7);

    // Act + Assert — roughly half a 60 Hz frame, and never out of the clamp.
    expect(frameFallbackMs()).toBeCloseTo(DEFAULT_FRAME_INTERVAL_MS / 2, 1);
    expect(frameFallbackMs()).toBeGreaterThanOrEqual(FRAME_INTERVAL_MIN_MS);
    expect(frameFallbackMs()).toBeLessThanOrEqual(FRAME_INTERVAL_MAX_MS);
  });

  it("keeps the fallback under one frame even at a very high refresh rate", () => {
    // Arrange — a 240 Hz display (~4.2ms frames).
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 4.2);

    // Act
    const fallback = frameFallbackMs();

    // Assert — roughly half a frame, not a whole one (the old 4ms floor bug).
    expect(fallback).toBeLessThan(measuredFrameIntervalMs());
    expect(fallback).toBeCloseTo(measuredFrameIntervalMs() / 2, 1);
  });

  it("sizes the paused-rAF fallback above one frame, capped", () => {
    // Arrange — 60 Hz.
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 16.7);

    // Act + Assert — several frames out, so a flowing rAF still wins the latch.
    expect(pausedRafFallbackMs()).toBeGreaterThan(measuredFrameIntervalMs());

    // Arrange — a very high refresh rate clamps to the floor, not below it.
    resetFrameCadence();
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 4.2);
    expect(pausedRafFallbackMs()).toBeGreaterThanOrEqual(16);
  });

  it("drops back to the seed on reset", () => {
    // Arrange
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 8.3);
    expect(measuredFrameIntervalMs()).toBeLessThan(1000 / 60);

    // Act
    resetFrameCadence();

    // Assert
    expect(measuredFrameIntervalMs()).toBe(DEFAULT_FRAME_INTERVAL_MS);
  });

  it("snaps to the nearest nominal refresh rate, so a display change is detectable", () => {
    // Arrange — 120 Hz then 60 Hz.
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 8.3);
    const at120 = nominalRefreshRateHz();
    resetFrameCadence();
    for (let i = 0; i < 40; i++) noteAnimationFrame(i * 16.7);
    const at60 = nominalRefreshRateHz();

    // Assert
    expect(at120).toBe(120);
    expect(at60).toBe(60);
  });
});
