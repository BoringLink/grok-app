import { describe, expect, it } from "vitest";
import { estimateChatRowHeight, shouldCommitRowHeight } from "./chatRowHeight";

describe("estimateChatRowHeight", () => {
  it("grows with long assistant bodies (org-chart style answers)", () => {
    const short = estimateChatRowHeight({ contentLength: 80, role: "assistant" });
    const long = estimateChatRowHeight({ contentLength: 7300, role: "assistant" });
    expect(long).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(1500);
  });

  it("user bubbles stay relatively compact", () => {
    const h = estimateChatRowHeight({ contentLength: 40, role: "user" });
    expect(h).toBeLessThan(200);
  });

  it("collapsed / empty tool rows estimate 0 (no blank tail)", () => {
    expect(estimateChatRowHeight({ role: "tool", collapsed: true })).toBe(0);
    expect(estimateChatRowHeight({ role: "tool", contentLength: 0 })).toBe(0);
    expect(
      estimateChatRowHeight({ role: "tool", contentLength: 20 }),
    ).toBeLessThan(50);
  });

  it("collapsed thinking does not inflate the first-paint estimate", () => {
    const bodyOnly = estimateChatRowHeight({
      contentLength: 240,
      role: "assistant",
    });
    const withCollapsedThought = estimateChatRowHeight({
      contentLength: 240,
      thoughtLength: 1800,
      role: "assistant",
    });
    // Default UI collapses thinking when the turn is done. Counting the CoT
    // made estimates hundreds of px taller than the measured row.
    expect(withCollapsedThought - bodyOnly).toBeLessThan(48);
    const expanded = estimateChatRowHeight({
      contentLength: 240,
      thoughtLength: 1800,
      thoughtExpanded: true,
      role: "assistant",
    });
    expect(expanded).toBeGreaterThan(withCollapsedThought + 200);
  });

  it("image cards boost height more than 36px chips", () => {
    const chips = estimateChatRowHeight({
      contentLength: 80,
      role: "assistant",
      attachmentCount: 6,
    });
    const images = estimateChatRowHeight({
      contentLength: 80,
      role: "assistant",
      imageCardCount: 6,
    });
    expect(images).toBeGreaterThan(chips);
    // 6 cards → 2 rows × ~160px
    expect(images - chips).toBeGreaterThanOrEqual(200);
  });

  it("folded failed tools add excerpt height under Worked-for chrome", () => {
    const base = estimateChatRowHeight({
      contentLength: 80,
      role: "assistant",
      toolCount: 4,
    });
    const withErrors = estimateChatRowHeight({
      contentLength: 80,
      role: "assistant",
      toolCount: 4,
      failedToolCount: 2,
    });
    expect(withErrors - base).toBe(72);
    const capped = estimateChatRowHeight({
      contentLength: 80,
      role: "assistant",
      toolCount: 20,
      failedToolCount: 8,
    });
    expect(capped - base).toBe(216);
  });
});

describe("shouldCommitRowHeight", () => {
  it("accepts first measure and real growth", () => {
    expect(shouldCommitRowHeight(undefined, 400)).toBe(true);
    expect(shouldCommitRowHeight(120, 3000)).toBe(true);
  });

  it("commits zero height for inlined tool rows (not phantom shell space)", () => {
    expect(shouldCommitRowHeight(undefined, 0)).toBe(true);
    expect(shouldCommitRowHeight(40, 0)).toBe(true);
    expect(shouldCommitRowHeight(0, 0)).toBe(false);
  });

  it("rejects negative heights", () => {
    expect(shouldCommitRowHeight(undefined, -1)).toBe(false);
  });

  it("ignores tiny flicker and small shrink thrash", () => {
    expect(shouldCommitRowHeight(400, 401)).toBe(false);
    expect(shouldCommitRowHeight(400, 403)).toBe(false); // <4px floor
    expect(shouldCommitRowHeight(400, 390)).toBe(false);
    expect(shouldCommitRowHeight(400, 405)).toBe(true); // ≥4px growth
  });

  it("commits a real collapse so the shell height follows", () => {
    expect(shouldCommitRowHeight(400, 60)).toBe(true);
  });
});
