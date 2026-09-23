/**
 * BOR-53：内联引用 token 的语法约束。
 *
 * 这些不变量决定了 draft 能否无损往返：只要转义/解析不对称，引用就会在下次
 * 加载时退化成乱码文本，而那是静默的数据损坏。
 */
import { describe, expect, it } from "vitest";
import {
  escapeRefValue,
  isTokenizableRefValue,
  matchRefTokenAt,
  refAgentText,
  refDisplayLabel,
  refTokenText,
  unescapeRefValue,
  REF_TOKEN_RE,
} from "./composerRefToken";

describe("ref token escaping", () => {
  it("leaves ordinary paths untouched so drafts stay readable", () => {
    // Arrange / Act / Assert
    expect(escapeRefValue("/repo/src/a b.ts")).toBe("/repo/src/a b.ts");
    expect(escapeRefValue("C:\\Users\\me\\a.ts")).toBe("C:\\Users\\me\\a.ts");
  });

  it("escapes only the two characters that break the grammar", () => {
    // Arrange / Act / Assert — `]` 会提前闭合 token，`%` 是转义符本身
    expect(escapeRefValue("/repo/a]b.ts")).toBe("/repo/a%5Db.ts");
    expect(escapeRefValue("/repo/100%.ts")).toBe("/repo/100%25.ts");
    expect(unescapeRefValue("/repo/100%25.ts")).toBe("/repo/100%.ts");
  });

  it("round-trips every escaped value", () => {
    // Arrange
    const cases = [
      "/repo/a.ts",
      "/repo/my dir/a b.ts",
      "/repo/a]b.ts",
      "/repo/50% off/a].ts",
      "https://example.com/a?b=1&c=2",
    ];

    // Act / Assert
    for (const value of cases) {
      expect(unescapeRefValue(escapeRefValue(value))).toBe(value);
    }
  });

  it("refuses values that cannot live inside an inline token", () => {
    // Arrange / Act / Assert — 换行会跨段落，写进 token 就再也解析不回来
    expect(isTokenizableRefValue("/repo/a.ts")).toBe(true);
    expect(isTokenizableRefValue("")).toBe(false);
    expect(isTokenizableRefValue("/repo/a\nb.ts")).toBe(false);
  });
});

describe("ref token text", () => {
  it("builds one token per kind", () => {
    expect(refTokenText("file", "/a.ts")).toBe("[[file:/a.ts]]");
    expect(refTokenText("dir", "/a")).toBe("[[dir:/a]]");
    expect(refTokenText("url", "https://x.y")).toBe("[[url:https://x.y]]");
  });

  it("parses back exactly what it wrote", () => {
    // Arrange
    const cases: Array<["file" | "dir" | "url", string]> = [
      ["file", "/repo/a b.ts"],
      ["file", "/repo/a]b.ts"],
      ["dir", "/repo/src"],
      ["url", "https://example.com/x?y=1"],
    ];

    // Act / Assert
    for (const [kind, value] of cases) {
      const text = refTokenText(kind, value);
      expect(matchRefTokenAt(text, 0)).toEqual({
        kind,
        value,
        length: text.length,
      });
    }
  });

  it("matches a token only at the requested position", () => {
    // Arrange
    const text = "before [[file:/a.ts]] after";

    // Act / Assert
    expect(matchRefTokenAt(text, 0)).toBeNull();
    expect(matchRefTokenAt(text, 7)).toEqual({
      kind: "file",
      value: "/a.ts",
      length: "[[file:/a.ts]]".length,
    });
  });

  it("does not match malformed or unknown-kind tokens", () => {
    // Arrange / Act / Assert
    expect(matchRefTokenAt("[[file:/a.ts", 0)).toBeNull();
    expect(matchRefTokenAt("[[thing:/a.ts]]", 0)).toBeNull();
    expect(matchRefTokenAt("[[skill:review]]", 0)).toBeNull();
  });

  it("keeps the global regex usable across calls", () => {
    // Arrange — 共享的 `g` 正则若 lastIndex 未被规则重置，第二次匹配会失败
    const text = "[[file:/a.ts]] [[dir:/b]]";

    // Act
    const first = REF_TOKEN_RE.exec(text);
    const second = REF_TOKEN_RE.exec(text);

    // Assert
    expect(first?.[1]).toBe("file");
    expect(second?.[1]).toBe("dir");
  });
});

describe("ref agent form and label", () => {
  it("sends files and dirs with the CLI @ syntax, URLs as-is", () => {
    // Arrange / Act / Assert — 与 buildAgentPrompt 的附件写法一致，CLI 无需改动
    expect(refAgentText("file", "/a.ts")).toBe("@/a.ts");
    expect(refAgentText("dir", "/a")).toBe("@/a");
    expect(refAgentText("url", "https://x.y/z")).toBe("https://x.y/z");
  });

  it("labels an inline chip with the trailing name", () => {
    // Arrange / Act / Assert
    expect(refDisplayLabel("file", "/repo/src/a.ts")).toBe("a.ts");
    expect(refDisplayLabel("dir", "/repo/src/components")).toBe("components");
    expect(refDisplayLabel("dir", "/repo/src/")).toBe("src");
    expect(refDisplayLabel("url", "https://example.com/a/b")).toBe(
      "example.com",
    );
  });
});
