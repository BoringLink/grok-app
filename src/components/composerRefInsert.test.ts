/**
 * @vitest-environment jsdom
 *
 * 回归：`@` 面板插入文件引用后，chip 落在 `@query` 原位置、光标紧随其后。
 *
 * ADR 0003 后插入走一次 transaction：区间来自 {@link queryRangeBeforeCaret}
 * 的文档位置，不再做「Markdown 里重新定位 + 文本偏移换算」。断言的是文档
 * 选区与序列化 Markdown，不是 DOM 位置。
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { buildComposerExtensions } from "@/components/composerExtensions";
import { insertRefAtomInto, removeRangeInto } from "@/components/composerRefInsert";
import { queryRangeBeforeCaret } from "@/lib/composerQuery";
import { normalizeSerializedMarkdown } from "@/lib/composerMarkdown";

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: buildComposerExtensions({ showPlaceholderWhenEditable: false }),
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

/** 首个文本块内容的末端 PM position。 */
function textblockEnd(doc: ProseMirrorNode): number {
  let end = 0;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      end = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  return end;
}

describe("insertRefAtomInto", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("列表项末尾：chip 落在 @ 处，光标紧随其后，正文不丢字", () => {
    // Arrange
    editor = makeEditor("- 第一个文件 @");
    const range = queryRangeBeforeCaret(editor.state.doc, textblockEnd(editor.state.doc), "@");
    expect(range).not.toBeNull();

    // Act
    const ok = insertRefAtomInto(editor, {
      from: range!.from,
      to: range!.to,
      kind: "file",
      value: "/repo/a.ts",
    });

    // Assert —— chip 落在 @ 原位置（前缀 "- 第一个文件 " 一个字符都不能少）；
    // @ 位于块末，后面没有空白，所以补一个分隔空格，光标在 chip + 空格之后。
    expect(ok).toBe(true);
    const md = markdownOf(editor);
    expect(md.startsWith("- 第一个文件 [[file:/repo/a.ts]]")).toBe(true);
    expect(md.includes("@")).toBe(false);
    expect(editor.state.selection.from).toBe(range!.from + 2);
  });

  it("列表项句中：既有空格不再补，chip 之后的光标紧贴 chip", () => {
    // Arrange —— 光标停在 "atF" 之后（PM 位置 9），后面已是空格
    editor = makeEditor("- 在 @atF 里找");
    const range = queryRangeBeforeCaret(editor.state.doc, 9, "@");
    expect(range).toEqual({ from: 5, to: 9, query: "atF" });

    // Act
    insertRefAtomInto(editor, {
      from: range!.from,
      to: range!.to,
      kind: "file",
      value: "/repo/a.ts",
    });

    // Assert
    expect(markdownOf(editor)).toBe("- 在 [[file:/repo/a.ts]] 里找");
    expect(editor.state.selection.from).toBe(range!.from + 1);
  });

  it("普通段落末尾：领先一个分隔空格，光标在 chip 之后", () => {
    // Arrange
    editor = makeEditor("看 @");
    const range = queryRangeBeforeCaret(editor.state.doc, textblockEnd(editor.state.doc), "@");

    // Act
    insertRefAtomInto(editor, {
      from: range!.from,
      to: range!.to,
      kind: "file",
      value: "/repo/a.ts",
    });

    // Assert
    expect(markdownOf(editor).startsWith("看 [[file:/repo/a.ts]]")).toBe(true);
    expect(editor.state.selection.from).toBe(range!.from + 2);
  });

  it("已有 chip 之前：新 chip 落在光标处，而不是文末", () => {
    // Arrange —— 用户把光标放在既有 chip 前再打 @atF：`@atF` 后面紧跟 token
    editor = makeEditor("在 @atF[[file:/repo/old.ts]] 后");
    const caret = 7; // "在 @atF" 的末端（PM 文档位置）
    const range = queryRangeBeforeCaret(editor.state.doc, caret, "@");
    expect(range).toEqual({ from: 3, to: 7, query: "atF" });

    // Act
    insertRefAtomInto(editor, {
      from: range!.from,
      to: range!.to,
      kind: "file",
      value: "/repo/a.ts",
    });

    // Assert —— 新 chip 落在原位置，旧 chip 完整保留，光标紧随新 chip
    expect(markdownOf(editor)).toBe(
      "在 [[file:/repo/a.ts]] [[file:/repo/old.ts]] 后",
    );
    expect(editor.state.selection.from).toBe(5);
  });

  it("区间失效时退回当前选区，不误删正文", () => {
    // Arrange —— 面板由别处触发 / 文档在检测后变化
    editor = makeEditor("abc");

    // Act
    insertRefAtomInto(editor, { from: 999, to: 1000, kind: "dir", value: "/x" });

    // Assert —— 正文仍在，只是多了一个 chip
    expect(markdownOf(editor)).toContain("abc");
    expect(markdownOf(editor)).toContain("[[dir:/x]]");
  });
});

describe("removeRangeInto", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("删掉 @query 那段而保留其余正文", () => {
    // Arrange —— 回退附件时用；"hello @x!" 里 @ 在 PM 位置 7
    editor = makeEditor("hello @x!");

    // Act
    const ok = removeRangeInto(editor, 7, 9);

    // Assert
    expect(ok).toBe(true);
    expect(markdownOf(editor)).toBe("hello !");
  });

  it("非法区间不改动文档", () => {
    // Arrange
    editor = makeEditor("abc");

    // Act / Assert
    expect(removeRangeInto(editor, 3, 1)).toBe(false);
    expect(removeRangeInto(editor, 0, 99)).toBe(false);
    expect(markdownOf(editor)).toBe("abc");
  });
});
