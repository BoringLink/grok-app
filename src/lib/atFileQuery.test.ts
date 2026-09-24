import { describe, expect, it } from "vitest";
import {
  detectAtQuery,
  detectAtQueryOnStored,
  insertAtTokenAsRef,
  rankAtFileHits,
  removeAtTokenFromDraft,
  scoreAtFileHit,
} from "./atFileQuery";

describe("detectAtQuery", () => {
  it("detects bare @", () => {
    expect(detectAtQuery("@")).toEqual({ start: 0, query: "" });
  });

  it("detects @query at end", () => {
    expect(detectAtQuery("see @packa")).toEqual({ start: 4, query: "packa" });
  });

  it("ignores mid-token email-like (no whitespace before @)", () => {
    // letter immediately before @ is not allowed by our trigger rule
    expect(detectAtQuery("user@host")).toBeNull();
  });

  it("allows @ after newline", () => {
    expect(detectAtQuery("line1\n@src")).toEqual({ start: 6, query: "src" });
  });

  it("@ 后接空白即终止补全（验收 C9）", () => {
    // Arrange / Act / Assert —— "今天 @ 某人" 这类普通文本不能常驻补全面板
    expect(detectAtQuery("@ ")).toBeNull();
    expect(detectAtQuery("@a ")).toBeNull();
    expect(detectAtQuery("说 @某人 ")).toBeNull();
    expect(detectAtQuery("@\u00a0")).toBeNull();
  });

  it("刚打出的 @ 仍然打开面板", () => {
    // Arrange / Act / Assert
    expect(detectAtQuery("@")).toEqual({ start: 0, query: "" });
    expect(detectAtQuery("说 @")).toEqual({ start: 2, query: "" });
  });
});

describe("detectAtQueryOnStored", () => {
  it("returns stored-form indices including exclusive end", () => {
    expect(detectAtQueryOnStored("see @packa")).toEqual({
      start: 4,
      query: "packa",
      end: 10,
    });
  });

  it("uses the caret prefix, not a later @ in the rest of the draft", () => {
    expect(detectAtQueryOnStored("hello ")).toBeNull();
  });
});


describe("rankAtFileHits", () => {
  const hits = [
    { path: "/p/a/package.json", name: "package.json", relativePath: "a/package.json", mtimeMs: 1 },
    { path: "/p/package-lock.json", name: "package-lock.json", relativePath: "package-lock.json", mtimeMs: 2 },
    { path: "/p/README.md", name: "README.md", relativePath: "README.md", mtimeMs: 9 },
  ];

  it("ranks package.json first for packa", () => {
    const ranked = rankAtFileHits(hits, "packa");
    expect(ranked[0]!.name).toBe("package.json");
  });

  it("empty query keeps recent first", () => {
    const ranked = rankAtFileHits(hits, "");
    expect(ranked[0]!.name).toBe("README.md");
  });
});

describe("scoreAtFileHit", () => {
  it("exact name beats prefix", () => {
    const exact = scoreAtFileHit(
      { path: "/x", name: "foo", relativePath: "foo" },
      "foo",
    );
    const prefix = scoreAtFileHit(
      { path: "/x", name: "foobar", relativePath: "foobar" },
      "foo",
    );
    expect(exact).toBeGreaterThan(prefix);
  });
});

describe("removeAtTokenFromDraft", () => {
  it("strips @token range", () => {
    expect(removeAtTokenFromDraft("see @packa now", 4, 10)).toBe("see  now");
  });
});

// ── BOR-53：`@` 选中后插入内联引用 chip ────────────────────────────────────

describe("insertAtTokenAsRef (BOR-53)", () => {
  it("replaces the @query span in place and keeps the rest of the sentence", () => {
    // Arrange — "在 @atF 中找到" 里 `@atF` 占 [2, 6)，后面已有一个空格
    const draft = "在 @atF 中找到";

    // Act
    const out = insertAtTokenAsRef(draft, { start: 2, end: 6 }, "[[file:/a.ts]]");

    // Assert — 不补第二个空格，否则正文与发给 CLI 的 prompt 都会出现双空格
    expect(out.draft).toBe("在 [[file:/a.ts]] 中找到");
    expect(out.caret).toBe(2 + "[[file:/a.ts]]".length);
  });

  it("adds a separating space when the query sits at the end of the draft", () => {
    // Arrange
    const draft = "看 @atF";

    // Act
    const out = insertAtTokenAsRef(draft, { start: 2, end: 6 }, "[[file:/a.ts]]");

    // Assert
    expect(out.draft).toBe("看 [[file:/a.ts]] ");
    expect(out.caret).toBe(out.draft.length);
  });

  it("appends with a separating space when there is no @query range", () => {
    // Arrange / Act
    const out = insertAtTokenAsRef("看这里", null, "[[dir:/a]]");

    // Assert
    expect(out.draft).toBe("看这里 [[dir:/a]] ");
    expect(out.caret).toBe(out.draft.length);
  });

  it("does not double the space when the draft already ends in whitespace", () => {
    // Arrange / Act
    const out = insertAtTokenAsRef("看这里 ", null, "[[dir:/a]]");

    // Assert
    expect(out.draft).toBe("看这里 [[dir:/a]] ");
  });

  it("appends into an empty draft without a leading space", () => {
    // Arrange / Act
    const out = insertAtTokenAsRef("", null, "[[file:/a.ts]]");

    // Assert
    expect(out.draft).toBe("[[file:/a.ts]] ");
  });

  it("falls back to appending when the range is out of bounds", () => {
    // Arrange — 面板可能由别处触发，此时 live range 已经失效
    const draft = "abc";

    // Act
    const bad = insertAtTokenAsRef(draft, { start: 2, end: 99 }, "[[file:/a]]");
    const reversed = insertAtTokenAsRef(draft, { start: 3, end: 1 }, "[[file:/a]]");

    // Assert
    expect(bad.draft).toBe("abc [[file:/a]] ");
    expect(reversed.draft).toBe("abc [[file:/a]] ");
  });
});
