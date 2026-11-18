import { describe, expect, it } from "vitest";
import { positiveContextWindows } from "./modelWindows";

describe("positiveContextWindows", () => {
  it("keeps positive whole counts in catalog order", () => {
    expect(positiveContextWindows([500000, 256000])).toEqual([500000, 256000]);
  });

  it("drops non-finite, zero and negative entries", () => {
    expect(
      positiveContextWindows([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 256000]),
    ).toEqual([256000]);
  });

  it("floors fractions and drops duplicates", () => {
    expect(positiveContextWindows([256000.9, 256000, 256000.2])).toEqual([
      256000,
    ]);
  });

  it("returns undefined for an empty or missing list", () => {
    expect(positiveContextWindows([])).toBeUndefined();
    expect(positiveContextWindows(null)).toBeUndefined();
    expect(positiveContextWindows(undefined)).toBeUndefined();
  });

  it("returns undefined when nothing valid remains", () => {
    expect(positiveContextWindows([0, -5])).toBeUndefined();
  });
});
