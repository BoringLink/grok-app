import { describe, expect, it } from "vitest";
import {
  isWebkitCaretGhostCode,
  stripComposerGhostChars,
} from "@/lib/composerGhostChars";

describe("stripComposerGhostChars", () => {
  it("删除草稿边界上的全部光标垫片", () => {
    // Arrange
    const raw = "你\u200B好\uFFFC，\uFEFF世界\u2060";

    // Act
    const cleaned = stripComposerGhostChars(raw);

    // Assert
    expect(cleaned).toBe("你好，世界");
  });

  it("保留普通文本、换行与 emoji 里的 ZWJ", () => {
    // Arrange
    const raw = "line 1\nline 2 👨\u200D👩\u200D👧";

    // Act / Assert
    expect(stripComposerGhostChars(raw)).toBe(raw);
  });
});

describe("isWebkitCaretGhostCode", () => {
  it("识别 WebKit 移动光标时注入的码点", () => {
    // Arrange / Act / Assert
    expect(isWebkitCaretGhostCode(0x200b)).toBe(true);
    expect(isWebkitCaretGhostCode(0xfeff)).toBe(true);
    expect(isWebkitCaretGhostCode(0x2060)).toBe(true);
    expect(isWebkitCaretGhostCode(0xfffc)).toBe(true);
  });

  it("不把 emoji 里的 ZWJ / ZWNJ 当垫片", () => {
    // Arrange / Act / Assert
    expect(isWebkitCaretGhostCode(0x200c)).toBe(false);
    expect(isWebkitCaretGhostCode(0x200d)).toBe(false);
    expect(isWebkitCaretGhostCode("a".charCodeAt(0))).toBe(false);
  });
});
