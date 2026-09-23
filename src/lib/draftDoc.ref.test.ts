/**
 * BOR-53：引用 segment 在 draft 模型里的行为。
 *
 * 重点是无损与「说到哪就是哪」：引用必须留在正文中说到的位置，而不是像
 * skill 那样被提到最前；漏改 `serializeForAgent` 会把 `[[file:…]]` 字面
 * 发给 CLI。
 */
import { describe, expect, it } from "vitest";
import {
  isDraftEmpty,
  parseStoredContent,
  previewStoredAsSlash,
  serializeForAgent,
  serializeStored,
} from "./draftDoc";

describe("parseStoredContent with references", () => {
  it("splits a sentence around an inline reference", () => {
    // Arrange
    const stored = "在 [[file:/repo/src/a.ts]] 中找到 xxx 逻辑";

    // Act
    const segs = parseStoredContent(stored);

    // Assert
    expect(segs).toEqual([
      { type: "text", text: "在 " },
      { type: "ref", kind: "file", value: "/repo/src/a.ts" },
      { type: "text", text: " 中找到 xxx 逻辑" },
    ]);
  });

  it("restores escaped values and keeps kinds apart", () => {
    // Arrange — 路径里的 `]` 必须以 `%5D` 存储，否则会提前闭合 token
    const stored = "[[dir:/repo/a%5Db]] [[url:https://x.y/z]]";

    // Act
    const segs = parseStoredContent(stored);

    // Assert
    expect(segs).toEqual([
      { type: "ref", kind: "dir", value: "/repo/a]b" },
      { type: "text", text: " " },
      { type: "ref", kind: "url", value: "https://x.y/z" },
    ]);
  });

  it("keeps a malformed token as text", () => {
    // Arrange — 未闭合的 token 不是引用，不能凭空造出一个 segment
    const stored = "[[file:/repo/a.ts";

    // Act / Assert
    expect(parseStoredContent(stored)).toEqual([
      { type: "text", text: stored },
    ]);
  });

  it("round-trips through serializeStored", () => {
    // Arrange
    const stored = "看 [[file:/repo/my dir/a b.ts]] 和 [[dir:/repo/src]] 与 [[skill:review]]";

    // Act / Assert
    expect(serializeStored(parseStoredContent(stored))).toBe(stored);
  });
});

describe("serializeForAgent with references", () => {
  it("sends a reference in place as the CLI @ form", () => {
    // Arrange
    const segs = parseStoredContent("在 [[file:/repo/a.ts]] 中找到 xxx 逻辑");

    // Act
    const out = serializeForAgent(segs);

    // Assert
    expect(out).toBe("在 @/repo/a.ts 中找到 xxx 逻辑");
  });

  it("keeps the reference inline while skills still hoist to the front", () => {
    // Arrange — skill 提到最前是既有行为；引用不能被一起提走，否则句子会散
    const segs = parseStoredContent("[[skill:review]] 看 [[file:/repo/a.ts]] 这里的逻辑");

    // Act
    const out = serializeForAgent(segs);

    // Assert
    expect(out).toBe("/review\n看 @/repo/a.ts 这里的逻辑");
  });

  it("sends a URL reference as the URL itself", () => {
    // Arrange / Act
    const out = serializeForAgent(
      parseStoredContent("see [[url:https://x.y/z]]"),
    );

    // Assert
    expect(out).toBe("see https://x.y/z");
  });

  it("sends a lone reference without surrounding text", () => {
    // Arrange / Act / Assert
    expect(serializeForAgent(parseStoredContent("[[dir:/repo/src]]"))).toBe(
      "@/repo/src",
    );
  });
});

describe("draft emptiness and previews with references", () => {
  it("treats a reference-only draft as sendable", () => {
    // Arrange / Act / Assert
    expect(isDraftEmpty(parseStoredContent("[[file:/a.ts]]"))).toBe(false);
    expect(isDraftEmpty(parseStoredContent("[[dir:/a]]"))).toBe(false);
    expect(isDraftEmpty(parseStoredContent("  \n "))).toBe(true);
  });

  it("never leaks a raw token into one-line previews", () => {
    // Arrange / Act / Assert
    expect(previewStoredAsSlash("看 [[file:/repo/a.ts]] 这里")).toBe(
      "看 @/repo/a.ts 这里",
    );
    expect(previewStoredAsSlash("[[dir:/repo/src]]")).toBe("@/repo/src");
  });
});
