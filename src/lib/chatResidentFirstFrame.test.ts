import { describe, expect, it } from "vitest";
import { createLayoutLedger, type LayoutRowHeight } from "./chatViewportLedger";
import { residentTailBand } from "./chatResidentBand";
import { estimateChatRowHeight } from "./chatRowHeight";

/**
 * Guards the order of magnitude of the first-frame work the resident list does
 * before it paints a long conversation: seed a 10k-row ledger's estimate tier
 * and decide the first band. It is not the full first frame — React mount and
 * DOM insertion dominate that — but it is the part that scales with the row
 * count, so a quadratic regression here shows up as a multi-second number.
 *
 * The full first painted frame is measured by
 * `scripts/measure-chat-first-frame.mjs` against headless Chrome: it renders
 * 10k resident rows with the real `useChatResidentList` and reports ~31ms at
 * 10k rows on the development machine (the rows are a lightweight stand-in for
 * the app's memoized row component, so the packaged macOS client will be
 * higher; a real in-app number needs WKWebView).
 */
describe("resident list first-frame model work", () => {
  it("seeds a 10k-row ledger and bands it inside the frame budget", () => {
    // Arrange
    const count = 10_000;

    // Act
    const start = performance.now();
    const ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
    ledger.setCount(count);
    const changes: LayoutRowHeight[] = [];
    for (let i = 0; i < count; i++) {
      changes.push({
        index: i,
        height: estimateChatRowHeight({ contentLength: 120, role: "assistant" }),
        source: "estimate",
      });
    }
    ledger.applyRowHeights(changes);
    const band = residentTailBand(ledger, 800);
    const elapsed = performance.now() - start;

    // Assert
    expect(ledger.rowCount()).toBe(count);
    expect(band).toEqual({ start: expect.any(Number), end: count });
    expect(band.end).toBe(count);
    // Order of magnitude, not a brittle exact figure: the work is a few ms.
    expect(elapsed).toBeLessThan(200);
  });
});
