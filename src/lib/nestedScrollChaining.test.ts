import { describe, expect, it } from "vitest";
import {
  canNestedBoxConsume,
  nextScrollTop,
  wheelDeltaToPixels,
} from "./nestedScrollChaining";

describe("wheelDeltaToPixels", () => {
  it("keeps pixel deltas and normalizes line/page modes", () => {
    expect(wheelDeltaToPixels(24, 0, 800)).toBe(24);
    expect(wheelDeltaToPixels(3, 1, 800)).toBe(48);
    expect(wheelDeltaToPixels(1, 2, 800)).toBe(800);
    expect(wheelDeltaToPixels(Number.NaN, 0, 800)).toBe(0);
    expect(wheelDeltaToPixels(0, 0, 800)).toBe(0);
  });
});

describe("canNestedBoxConsume", () => {
  const box = { scrollTop: 120, scrollHeight: 800, clientHeight: 220 };

  it("is true only while the box has room in the gesture direction", () => {
    expect(canNestedBoxConsume(box, -20)).toBe(true);
    expect(canNestedBoxConsume(box, 20)).toBe(true);
    expect(canNestedBoxConsume({ ...box, scrollTop: 0 }, -20)).toBe(false);
    expect(canNestedBoxConsume({ ...box, scrollTop: 580 }, 20)).toBe(false);
  });

  it("treats fractional edge positions as consumed", () => {
    expect(canNestedBoxConsume({ ...box, scrollTop: 0.3 }, -1)).toBe(false);
    expect(canNestedBoxConsume({ ...box, scrollTop: 579.7 }, 1)).toBe(false);
  });

  it("never consumes when content fits or the delta is zero", () => {
    expect(canNestedBoxConsume(box, 0)).toBe(false);
    expect(
      canNestedBoxConsume(
        { scrollTop: 0, scrollHeight: 200, clientHeight: 220 },
        20,
      ),
    ).toBe(false);
  });
});

describe("nextScrollTop", () => {
  const box = { scrollTop: 400, scrollHeight: 2000, clientHeight: 800 };

  it("moves by the gesture delta", () => {
    expect(nextScrollTop(box, -30)).toBe(370);
    expect(nextScrollTop(box, 30)).toBe(430);
  });

  it("clamps at the box edges", () => {
    expect(nextScrollTop({ ...box, scrollTop: 10 }, -30)).toBe(0);
    expect(nextScrollTop({ ...box, scrollTop: 1190 }, 30)).toBe(1200);
  });

  it("returns null when the box cannot move", () => {
    expect(nextScrollTop({ ...box, scrollTop: 0 }, -30)).toBeNull();
    expect(nextScrollTop({ ...box, scrollTop: 1200 }, 30)).toBeNull();
    expect(
      nextScrollTop({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 }, 30),
    ).toBeNull();
  });

  it("ignores sub-pixel writes that the transcript writer would drop", () => {
    const tall = { scrollTop: 1599.4, scrollHeight: 2800, clientHeight: 800 };
    expect(nextScrollTop(tall, 0.5)).toBeNull();
    expect(nextScrollTop(tall, 1)).toBe(1600.4);
  });
});
