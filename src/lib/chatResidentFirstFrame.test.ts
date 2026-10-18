import { describe, expect, it } from "vitest";
import { createLayoutLedger } from "./chatViewportLedger";
import {
  seedResidentLedger,
  type ResidentLedgerSeed,
} from "@/hooks/useChatResidentList";

const ROWS = 10_000;

/**
 * Guards the first-frame work the resident list does before it paints a long
 * conversation: grow the ledger to every row and write each row's content
 * estimate once. It calls the real {@link seedResidentLedger}, so a regression
 * inside the seeding loop fails here.
 *
 * The full first painted frame (ledger + React mount of 10k resident rows) is
 * measured by `scripts/measure-chat-first-frame.mjs` against headless Chrome:
 * ~27–33ms at 10k rows across runs on the development machine. The rows there
 * are a lightweight stand-in, so a real in-app number still needs the packaged
 * macOS client (WKWebView); this test asserts the seeding's shape, not a clock.
 */
describe("seedResidentLedger", () => {
  it("seeds every row's estimate once and then does no work", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
    const seed: ResidentLedgerSeed = { ledger: null, count: 0, resetKey: "chat" };
    const estimate = (index: number) => (index % 2 === 0 ? 60 : 90);

    // Act
    seedResidentLedger({ ledger, seed, itemCount: ROWS, estimate });

    // Assert: one estimate per row, total = sum of the estimates.
    expect(ledger.rowCount()).toBe(ROWS);
    expect(ledger.sourceOf(0)).toBe("estimate");
    expect(ledger.sourceOf(1)).toBe("estimate");
    expect(ledger.heightOf(0)).toBe(60);
    expect(ledger.heightOf(1)).toBe(90);
    expect(ledger.totalHeight()).toBe((ROWS / 2) * 60 + (ROWS / 2) * 90);

    // A repeat call is a no-op: no rebuild, no height write.
    const afterFirst = ledger.stats();
    seedResidentLedger({ ledger, seed, itemCount: ROWS, estimate });
    expect(ledger.stats()).toEqual(afterFirst);

    // Growth seeds only the appended rows.
    seedResidentLedger({ ledger, seed, itemCount: ROWS + 1, estimate });
    expect(ledger.rowCount()).toBe(ROWS + 1);
    expect(ledger.stats().rebuiltRows).toBeGreaterThan(afterFirst.rebuiltRows);
  });

  it("re-seeds a row that was dropped and re-grown", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
    const seed: ResidentLedgerSeed = { ledger: null, count: 0, resetKey: "chat" };

    // Act: grow, shrink (rows dropped), grow again.
    seedResidentLedger({ ledger, seed, itemCount: 4, estimate: () => 50 });
    seedResidentLedger({ ledger, seed, itemCount: 2, estimate: () => 50 });
    seedResidentLedger({ ledger, seed, itemCount: 3, estimate: () => 70 });

    // Assert: the re-grown row carries the current estimate, not the stale one.
    expect(ledger.heightOf(2)).toBe(70);
  });

  it("does not overwrite a measured row with a later estimate", () => {
    // Arrange
    const ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
    const seed: ResidentLedgerSeed = { ledger: null, count: 0, resetKey: "chat" };
    seedResidentLedger({ ledger, seed, itemCount: 3, estimate: () => 50 });
    ledger.setRowHeight(1, 400, "measured");

    // Act
    seedResidentLedger({ ledger, seed, itemCount: 3, estimate: () => 50 });

    // Assert
    expect(ledger.sourceOf(1)).toBe("measured");
    expect(ledger.heightOf(1)).toBe(400);
  });
});
