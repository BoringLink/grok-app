import { describe, expect, it } from "vitest";
import { STICK_MIN_VIEWPORT_HEIGHT_PX } from "@/lib/stickToBottom";
import {
  CHAT_VIEWPORT_OCCLUSION_EVENT,
  assessViewportOcclusion,
  parseHostOcclusionPayload,
  shouldRestoreAfterOcclusion,
} from "./chatViewportOcclusion";

const available = { hidden: false, covered: false, clientHeight: 600 };

describe("assessViewportOcclusion", () => {
  it("reports an available viewport with no cause", () => {
    // Arrange + Act
    const result = assessViewportOcclusion(available);

    // Assert
    expect(result).toEqual({ occluded: false, cause: null });
  });

  it("marks a hidden window occluded with the page-visibility cause", () => {
    // Arrange + Act
    const result = assessViewportOcclusion({ ...available, hidden: true });

    // Assert
    expect(result).toEqual({ occluded: true, cause: "hidden" });
  });

  it("marks a host-covered window occluded with the covered cause", () => {
    // Arrange + Act
    const result = assessViewportOcclusion({ ...available, covered: true });

    // Assert
    expect(result).toEqual({ occluded: true, cause: "covered" });
  });

  it("marks a collapsed scroller occluded with a collapsed cause", () => {
    // Arrange + Act
    const atFloor = assessViewportOcclusion({
      ...available,
      clientHeight: STICK_MIN_VIEWPORT_HEIGHT_PX - 1,
    });
    const nonFinite = assessViewportOcclusion({
      ...available,
      clientHeight: Number.NaN,
    });

    // Assert
    expect(atFloor).toEqual({ occluded: true, cause: "collapsed" });
    expect(nonFinite).toEqual({ occluded: true, cause: "collapsed" });
  });

  it("names the strongest signal when several apply", () => {
    // Arrange + Act
    const hiddenAndCovered = assessViewportOcclusion({
      hidden: true,
      covered: true,
      clientHeight: 0,
    });
    const coveredAndCollapsed = assessViewportOcclusion({
      hidden: false,
      covered: true,
      clientHeight: 0,
    });

    // Assert
    expect(hiddenAndCovered).toEqual({ occluded: true, cause: "hidden" });
    expect(coveredAndCollapsed).toEqual({ occluded: true, cause: "covered" });
  });
});

describe("parseHostOcclusionPayload", () => {
  it("accepts a strict boolean report", () => {
    // Arrange + Act + Assert
    expect(parseHostOcclusionPayload({ occluded: true })).toBe(true);
    expect(parseHostOcclusionPayload({ occluded: false })).toBe(false);
  });

  it("rejects anything that is not a boolean report", () => {
    // Arrange — the payload crosses a process boundary, so it is untrusted.
    const rejected: unknown[] = [
      null,
      undefined,
      "occluded",
      1,
      { occluded: "true" },
      { occluded: 1 },
      {},
      [],
    ];

    // Act + Assert
    for (const payload of rejected) {
      expect(parseHostOcclusionPayload(payload)).toBeNull();
    }
  });
});

describe("CHAT_VIEWPORT_OCCLUSION_EVENT", () => {
  it("names the host event the controller listens for", () => {
    expect(CHAT_VIEWPORT_OCCLUSION_EVENT).toBe("chat-viewport://occlusion");
  });
});

describe("shouldRestoreAfterOcclusion", () => {
  it("restores on the frame the occlusion ends", () => {
    // Arrange + Act
    const restore = shouldRestoreAfterOcclusion({
      wasOccluded: true,
      occluded: false,
      regainedFocus: false,
    });

    // Assert
    expect(restore).toBe(true);
  });

  it("restores on a focus regain, because occlusion while blurred is invisible", () => {
    // Arrange + Act
    const restore = shouldRestoreAfterOcclusion({
      wasOccluded: false,
      occluded: false,
      regainedFocus: true,
    });

    // Assert
    expect(restore).toBe(true);
  });

  it("does not restore while the viewport is still occluded", () => {
    // Arrange — positioning a collapsed/hidden scroller would write a wrong top.
    for (const wasOccluded of [true, false]) {
      const restore = shouldRestoreAfterOcclusion({
        wasOccluded,
        occluded: true,
        regainedFocus: true,
      });
      expect(restore).toBe(false);
    }
  });

  it("does not restore on an ordinary frame with no boundary", () => {
    // Arrange + Act
    const restore = shouldRestoreAfterOcclusion({
      wasOccluded: false,
      occluded: false,
      regainedFocus: false,
    });

    // Assert
    expect(restore).toBe(false);
  });
});
