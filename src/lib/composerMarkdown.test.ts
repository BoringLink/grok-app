/**
 * @vitest-environment jsdom
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { SkillTokenNode } from "@/components/composerSkillNode";
import {
  docPosForEditorTextOffset,
  editorTextBeforePos,
  editorTextOffsetForDocPos,
  isStoredMarkdownEmpty,
  locateSlashRangeInMarkdown,
  normalizeSerializedMarkdown,
} from "./composerMarkdown";

/** 构建与 ComposerEditor 相同扩展集的 headless 编辑器（AAA 的 Arrange）。 */
function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      SkillTokenNode,
      Markdown.configure({
        html: false,
        breaks: true,
        linkify: false,
      }),
    ],
    content,
    editable: false,
  });
}

function markdownOf(editor: {
  // tiptap-markdown augments storage at runtime; Storage type stays empty.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storage: any;
}): string {
  const raw = editor.storage?.markdown?.getMarkdown?.();
  return normalizeSerializedMarkdown(typeof raw === "string" ? raw : "");
}

describe("Markdown serialization (TipTap composer)", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("round-trips headings, bold, code blocks and lists", () => {
    // Arrange
    const source = "# Title\n\nplain **bold** text\n\n```js\nconst a = 1;\n```\n\n- one\n- two";
    // Act
    editor = makeEditor(source);
    const out = markdownOf(editor);
    // Assert
    expect(out).toBe(source);
  });

  it("keeps soft lines via hard breaks (breaks: true)", () => {
    // Arrange
    const source = "line1\nline2";
    // Act
    editor = makeEditor(source);
    const out = markdownOf(editor);
    // Assert：反解析后仍是两行
    expect(out).toBe(source);
  });

  it("parses legacy [[skill:name]] tokens into the doc and serializes them back", () => {
    // Arrange：旧会话 draft 格式（纯文本 + token）
    const legacy = "[[skill:review]]\n请检查这段逻辑";
    // Act
    editor = makeEditor(legacy);
    const doc = editor.state.doc;
    const tokens: Array<{ kind: string; name: string }> = [];
    doc.descendants((node: { type: { name: string }; attrs: Record<string, unknown> }) => {
      if (node.type.name === "skillToken") {
        tokens.push({
          kind: String(node.attrs.kind),
          name: String(node.attrs.name),
        });
      }
    });
    const out = markdownOf(editor);
    // Assert
    expect(tokens).toEqual([{ kind: "skill", name: "review" }]);
    expect(out).toBe(legacy);
  });

  it("round-trips plugin tokens inline with text", () => {
    // Arrange
    const stored = "before [[plugin:deploy]] after";
    // Act
    editor = makeEditor(stored);
    const out = markdownOf(editor);
    // Assert
    expect(out).toBe(stored);
  });

  it("keeps malformed token-looking text as plain text", () => {
    // Arrange：名字含空格 → 不构成合法 token，必须保持字面文本
    const stored = "look at [[skill:bro ken]]";
    // Act
    editor = makeEditor(stored);
    const out = markdownOf(editor);
    // Assert
    expect(out).toBe(stored);
  });
});

describe("editor-text space mapping", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  beforeEach(() => {
    // Arrange：两段文本 + 一个 skill token
    editor = makeEditor("one two\n\n[[skill:foo]] tail");
  });

  it("maps offsets to doc positions (text and token lengths)", () => {
    // Act / Assert
    const doc = editor!.state.doc;
    // offset 0 → 首段文本起点（PM position 1：0 在首块之前）
    expect(docPosForEditorTextOffset(doc, 0)).toBe(1);
    // "one two" 末尾（7 个字符，文本起点为 1 → 终点为 8）
    expect(docPosForEditorTextOffset(doc, 7)).toBe(8);
    // token 起点在编辑器文本空间位于 "\n\n" 之后（7 + 2 = 9）
    expect(docPosForEditorTextOffset(doc, 9)).toBe(10);
    expect(docPosForEditorTextOffset(doc, 999)).toBe(doc.content.size);
  });

  it("maps doc positions back to editor-text offsets", () => {
    // Act / Assert
    const doc = editor!.state.doc;
    expect(editorTextOffsetForDocPos(doc, 1)).toBe(0);
    expect(editorTextOffsetForDocPos(doc, 8)).toBe(7);
    expect(editorTextOffsetForDocPos(doc, doc.content.size)).toBe(
      7 + 2 + "[[skill:foo]]".length + 1 + "tail".length,
    );
  });

  it("builds the caret prefix for slash detection", () => {
    // Act
    const doc = editor!.state.doc;
    const prefix = editorTextBeforePos(doc, doc.content.size);
    // Assert：token 以存储形式出现，段落间为空行
    expect(prefix).toBe("one two\n\n[[skill:foo]] tail");
  });
});

describe("locateSlashRangeInMarkdown", () => {
  it("finds the trailing slash query after whitespace", () => {
    expect(locateSlashRangeInMarkdown("do it /rev", "rev")).toEqual({
      start: 6,
      end: 10,
    });
  });

  it("finds mid-document queries only at token boundaries", () => {
    expect(locateSlashRangeInMarkdown("a /rev b", "rev")).toEqual({
      start: 2,
      end: 6,
    });
    // "a/rev"：/ 前不是空白 → 不是 slash token
    expect(locateSlashRangeInMarkdown("a/rev", "rev")).toBeNull();
  });

  it("returns null when the query is absent", () => {
    expect(locateSlashRangeInMarkdown("plain text", "rev")).toBeNull();
  });
});

describe("isStoredMarkdownEmpty", () => {
  it("treats whitespace-only drafts as empty but keeps tokens non-empty", () => {
    expect(isStoredMarkdownEmpty("")).toBe(true);
    expect(isStoredMarkdownEmpty(" \n \n")).toBe(true);
    expect(isStoredMarkdownEmpty("[[skill:a]]")).toBe(false);
    expect(isStoredMarkdownEmpty("hi")).toBe(false);
  });
});
