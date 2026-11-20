import { describe, expect, it } from "vitest";

import { continuityBanner } from "./sessionContinuity";

describe("continuityBanner", () => {
  it("shows nothing for an empty transcript or a missing snapshot", () => {
    expect(continuityBanner(null, true)).toBeNull();
    expect(
      continuityBanner({ status: "unverified", reason: "history_empty" }, false),
    ).toBeNull();
  });

  it("shows nothing when verified without a bootstrap boundary", () => {
    expect(
      continuityBanner(
        { status: "verified", coveredPromptCount: 3, bootstrapIncluded: 0 },
        true,
      ),
    ).toBeNull();
  });

  it("marks a restored context and reports the omitted budget range", () => {
    expect(
      continuityBanner(
        { status: "verified", bootstrapIncluded: 4, bootstrapOmitted: 2 },
        true,
      ),
    ).toEqual({
      kind: "restored",
      titleKey: "continuity.restored.title",
      detailKey: "continuity.restored.omitted",
      detailParams: { included: 4, omitted: 2 },
    });
  });

  it("distinguishes an unconfirmed turn from a history mismatch", () => {
    expect(
      continuityBanner({ status: "bootstrap_pending", reason: "flush_unconfirmed" }, true)
        ?.titleKey,
    ).toBe("continuity.pending.turnTitle");
    expect(
      continuityBanner({ status: "unverified", reason: "history_partial" }, true)
        ?.kind,
    ).toBe("unverified");
  });

  it("stays quiet for a brand-new chat before any prompt", () => {
    expect(
      continuityBanner({ status: "bootstrap_pending", reason: "no_prompt_yet" }, true),
    ).toBeNull();
    // 旧版 / 刚创建的 checkpoint 没有原因码，但已有历史时仍提示待核验。
    expect(
      continuityBanner({ status: "unverified", reason: null }, true)?.kind,
    ).toBe("pending");
  });

  it("suppresses pending warnings while a turn is already in flight", () => {
    expect(
      continuityBanner(
        { status: "bootstrap_pending", reason: "turn_unconfirmed" },
        true,
        true,
      ),
    ).toBeNull();
    expect(
      continuityBanner({ status: "verified", bootstrapIncluded: 2 }, true, true)
        ?.kind,
    ).toBe("restored");
  });
});
