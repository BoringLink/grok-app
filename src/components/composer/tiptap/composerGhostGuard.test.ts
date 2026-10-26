/**
 * @vitest-environment jsdom
 *
 * 回归：macOS WebKit 在文档首尾按方向键会把 ZWSP / U+FFFC 垫片写进
 * contenteditable。Markdown（TipTap）档必须阻止它进入 ProseMirror 文档。
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import { buildComposerExtensions } from "@/components/composer/tiptap/composerExtensions";
import {
  isCaretAtDocEnd,
  isCaretAtDocStart,
} from "@/components/composer/tiptap/composerGhostGuard";

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: buildComposerExtensions({ showPlaceholderWhenEditable: false }),
    content,
    editable: false,
  });
}

describe("composerGhostGuard", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("外部回填的 U+FFFC / ZWSP 会在同一轮事务里清掉", () => {
    // Arrange
    editor = makeEditor("hello");
    // Act —— 恢复草稿 / 历史回填都走 setContent
    editor.commands.setContent("hello\uFFFC\u200B");
    // Assert
    expect(editor.getText()).toBe("hello");
    expect(editor.state.doc.textContent).toBe("hello");
  });

  it("后续插入垫片不会留在文档里", () => {
    // Arrange
    editor = makeEditor("hello");
    // Act
    editor.commands.insertContent("\uFFFC");
    // Assert
    expect(editor.getText()).toBe("hello");
  });

  it("不误删 emoji 序列里的 ZWJ", () => {
    // Arrange
    const family = "👨\u200D👩\u200D👧";
    // Act
    editor = makeEditor(family);
    // Assert
    expect(editor.state.doc.textContent).toBe(family);
  });
});

describe("caret edge detection", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("文档末尾的折叠光标被识别为末尾", () => {
    // Arrange
    editor = makeEditor("hello");
    const end = editor.state.doc.content.size - 1;
    // Act
    editor.commands.setTextSelection(end);
    // Assert
    expect(isCaretAtDocEnd(editor.state)).toBe(true);
    expect(isCaretAtDocStart(editor.state)).toBe(false);
  });

  it("文档开头的折叠光标被识别为开头", () => {
    // Arrange
    editor = makeEditor("hello");
    // Act
    editor.commands.setTextSelection(1);
    // Assert
    expect(isCaretAtDocStart(editor.state)).toBe(true);
    expect(isCaretAtDocEnd(editor.state)).toBe(false);
  });

  it("文档中间的折叠光标不触发边界防护", () => {
    // Arrange
    editor = makeEditor("hello");
    // Act
    editor.commands.setTextSelection(3);
    // Assert
    expect(isCaretAtDocStart(editor.state)).toBe(false);
    expect(isCaretAtDocEnd(editor.state)).toBe(false);
  });
});
