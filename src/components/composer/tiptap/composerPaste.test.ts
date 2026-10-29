/**
 * @vitest-environment jsdom
 *
 * 粘贴策略回归：
 * - 纯文本包壳 HTML 按 Markdown 解析（块级记号不再留字面量）；
 * - 带语义的 HTML 保持 HTML 解析；
 * - 尾随换行不再变成 hardBreak（行尾右方向键不会走进空白行）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import { Slice } from "@tiptap/pm/model";
import { buildComposerExtensions } from "@/components/composer/tiptap/composerExtensions";
import { normalizeSerializedMarkdown } from "@/lib/composerMarkdown";
import {
  clipboardHtmlIsPlainWrapper,
  markdownHtmlHasBlocks,
  normalizePastedMarkdown,
  shouldParsePastedMarkdown,
} from "@/components/composer/tiptap/composerPaste";

let editor: Editor | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

function makeEditor(content = ""): Editor {
  host = document.createElement("div");
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: buildComposerExtensions({ showPlaceholderWhenEditable: false }),
    content,
    editable: true,
  });
}

/** 最小剪贴板事件：只实现粘贴路径实际读取的两个 MIME。 */
function pasteEvent(plain: string, html?: string): ClipboardEvent {
  // jsdom 没有 ClipboardEvent；粘贴路径只读取 clipboardData，用 Event 承载即可。
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => {
        if (type === "text/plain") return plain;
        if (type === "text/html") return html ?? "";
        return "";
      },
    },
  });
  return event as unknown as ClipboardEvent;
}

function dispatchPaste(ed: Editor, plain: string, html?: string): boolean {
  const event = pasteEvent(plain, html);
  const handled = ed.view.someProp("handlePaste", (f) =>
    f(ed.view, event, Slice.empty),
  );
  return !!handled;
}

/** 走 ProseMirror 的完整粘贴管线：HTML 分支、库的 clipboardTextParser 都会被覆盖。 */
function dispatchRealPaste(ed: Editor, plain: string, html?: string): void {
  ed.view.dom.dispatchEvent(pasteEvent(plain, html));
}

function blockTypes(ed: Editor): string[] {
  const names: string[] = [];
  ed.state.doc.forEach((node) => names.push(node.type.name));
  return names;
}

function markdownOf(ed: Editor): string {
  const raw = (ed.storage as { markdown?: { getMarkdown?: () => unknown } })
    .markdown?.getMarkdown?.();
  return typeof raw === "string" ? raw : "";
}

function hasHardBreak(ed: Editor): boolean {
  let found = false;
  ed.state.doc.descendants((node) => {
    if (node.type.name === "hardBreak") found = true;
    return !found;
  });
  return found;
}

describe("normalizePastedMarkdown", () => {
  it("统一 CRLF 并去掉首尾空行", () => {
    expect(normalizePastedMarkdown("\n\n第一行\r\n第二行\r\n\n")).toBe(
      "第一行\n第二行",
    );
  });

  it("保留中间的换行与行尾空格", () => {
    expect(normalizePastedMarkdown("a  \nb\n")).toBe("a  \nb");
  });

  it("保留最后一行的尾随空格（行内粘贴的正文）", () => {
    expect(normalizePastedMarkdown("big ")).toBe("big ");
    expect(normalizePastedMarkdown("big \n")).toBe("big ");
  });

  it("全空白粘贴归一化为空串", () => {
    expect(normalizePastedMarkdown(" \n\t\n")).toBe("");
  });
});

describe("clipboardHtmlIsPlainWrapper", () => {
  it("div 包壳视为纯文本", () => {
    expect(clipboardHtmlIsPlainWrapper("<div>## 标题</div>", "## 标题\n")).toBe(
      true,
    );
  });

  it("br 分行的包壳仍视为纯文本", () => {
    expect(
      clipboardHtmlIsPlainWrapper("<div>a<br>b</div>", "a\nb\n"),
    ).toBe(true);
  });

  it("语义标签不算包壳", () => {
    expect(
      clipboardHtmlIsPlainWrapper("<div><strong>粗体</strong></div>", "粗体"),
    ).toBe(false);
    expect(clipboardHtmlIsPlainWrapper("<h2>标题</h2>", "标题")).toBe(false);
    expect(
      clipboardHtmlIsPlainWrapper("<pre><code>a</code></pre>", "a"),
    ).toBe(false);
  });

  it("带样式的 span 不算包壳", () => {
    expect(
      clipboardHtmlIsPlainWrapper(
        '<div><span style="color:red">红</span></div>',
        "红",
      ),
    ).toBe(false);
  });

  it("HTML 文本与纯文本不一致时不接管", () => {
    expect(clipboardHtmlIsPlainWrapper("<div>少了</div>", "少了 一段")).toBe(
      false,
    );
  });

  it("HTML 为空壳时以纯文本为准", () => {
    expect(
      clipboardHtmlIsPlainWrapper('<meta charset="utf-8">', "## 标题"),
    ).toBe(true);
  });

  it("纯空白 HTML 视为空壳", () => {
    expect(clipboardHtmlIsPlainWrapper("   ", "## 标题")).toBe(true);
  });
});

describe("markdownHtmlHasBlocks", () => {
  it("只识别块级结构", () => {
    expect(markdownHtmlHasBlocks("<p>纯文本</p>")).toBe(false);
    expect(markdownHtmlHasBlocks("<p><strong>粗体</strong></p>")).toBe(false);
    expect(markdownHtmlHasBlocks("<h2>标题</h2>")).toBe(true);
    expect(markdownHtmlHasBlocks("<pre><code>a</code></pre>")).toBe(true);
  });
});

describe("shouldParsePastedMarkdown", () => {
  it("无 HTML 时同样按 Markdown 接管", () => {
    expect(shouldParsePastedMarkdown("## 标题", null)).toBe(true);
  });

  it("纯文本包壳且内容非空时接管", () => {
    expect(
      shouldParsePastedMarkdown("## 标题\n", "<div>## 标题</div>"),
    ).toBe(true);
  });

  it("空粘贴不接管", () => {
    expect(shouldParsePastedMarkdown("\n\n", "<div></div>")).toBe(false);
  });
});

describe("粘贴行为", () => {
  it("行内代码末尾换行不留下 hardBreak", () => {
    // Arrange
    editor = makeEditor();

    // Act
    expect(
      dispatchPaste(editor, "`code`\n", "<div>`code`</div>"),
    ).toBe(true);

    // Assert —— 只有一个 code 文本节点，段落末尾没有多余空行
    expect(blockTypes(editor)).toEqual(["paragraph"]);
    expect(hasHardBreak(editor)).toBe(false);
    expect(markdownOf(editor)).toBe("`code`");
  });

  it("纯文本包壳的标题按 Markdown 解析", () => {
    // Arrange
    editor = makeEditor();

    // Act
    dispatchPaste(editor, "## **标题**\n", "<div>## **标题**</div>");

    // Assert
    expect(blockTypes(editor)[0]).toBe("heading");
    expect(markdownOf(editor)).toBe("## **标题**");
  });

  it("纯文本包壳的围栏代码按 Markdown 解析", () => {
    // Arrange
    editor = makeEditor();

    // Act
    dispatchPaste(
      editor,
      "```js\nconst a = 1;\n```\n",
      "<div>```js<br>const a = 1;<br>```</div>",
    );

    // Assert
    expect(blockTypes(editor)).toContain("codeBlock");
    expect(editor.state.doc.firstChild?.attrs.language).toBe("js");
  });

  it("带语义的 HTML 不接管，交给 ProseMirror 的 HTML 解析", () => {
    // Arrange
    editor = makeEditor();

    // Act —— handlePaste 返回 false 才会继续走 HTML 解析
    expect(dispatchPaste(editor, "标题", "<h2><strong>标题</strong></h2>")).toBe(
      false,
    );

    // Assert
    expect(markdownOf(editor)).toBe("");
  });

  it("多行纯文本只保留中间换行", () => {
    // Arrange
    editor = makeEditor();

    // Act
    dispatchPaste(editor, "第一行\n第二行\n", "<div>第一行\n第二行</div>");

    // Assert
    expect(markdownOf(editor)).toBe("第一行\\\n第二行");
    expect(editor.state.doc.textContent).toBe("第一行第二行");
  });

  it("在行中粘贴行内 Markdown 不会拆段", () => {
    // Arrange
    editor = makeEditor("hello world");
    editor.commands.setTextSelection(7);

    // Act
    dispatchPaste(editor, "`x`\n", "<div>`x`</div>");

    // Assert
    expect(blockTypes(editor)).toEqual(["paragraph"]);
    expect(markdownOf(editor)).toBe("hello `x`world");
  });

  it("在行中粘贴块级 Markdown 会拆段并保留标题", () => {
    // Arrange —— 不能用 replaceSelection 的拟合路径：它会把标题压成行内文本
    editor = makeEditor("hello world");
    editor.commands.setTextSelection(7);

    // Act
    dispatchPaste(editor, "## 标题\n", "<div>## 标题</div>");

    // Assert
    expect(blockTypes(editor)).toContain("heading");
    expect(editor.state.doc.textContent).toBe("hello 标题world");
  });

  it("代码块内不接管，保持字面量粘贴", () => {
    // Arrange
    editor = makeEditor("```\ncode\n```");
    editor.commands.setTextSelection(4);

    // Act —— 返回 false 后由 ProseMirror 的 inCode 分支原样插入
    expect(
      dispatchPaste(editor, "**not bold**\n", "<div>**not bold**</div>"),
    ).toBe(false);

    // Assert
    expect(markdownOf(editor)).toBe("```\ncode\n```");
  });

  it("跨代码块的选区不接管", () => {
    // Arrange —— 选区从正文段落反向跨进代码块
    editor = makeEditor("```\ncode\n```\n\nafter");
    editor.commands.setTextSelection({ from: 10, to: 3 });

    // Act
    expect(
      dispatchPaste(editor, "## 标题\n", "<div>## 标题</div>"),
    ).toBe(false);

    // Assert —— 文档保持原样，没有被插入标题
    expect(editor.state.doc.textContent).toBe("codeafter");
  });

  it("Markdown 解析器缺失时退回 HTML 解析，不插入源码", () => {
    // Arrange —— 模拟库升级后 storage.markdown.parser 被改名 / 移除
    editor = makeEditor();
    const storage = editor.storage as {
      markdown?: { parser?: unknown };
    };
    const saved = storage.markdown?.parser;
    storage.markdown!.parser = undefined;

    try {
      // Act
      const handled = dispatchPaste(
        editor,
        "## 标题\n",
        "<div>## 标题</div>",
      );

      // Assert
      expect(handled).toBe(false);
      expect(markdownOf(editor)).toBe("");
    } finally {
      storage.markdown!.parser = saved;
    }
  });
});

describe("真实粘贴管线", () => {
  it("段落内粘贴无 HTML 的标题时保留标题块", () => {
    // Arrange
    editor = makeEditor("hello");
    editor.commands.setTextSelection(6);

    // Act
    dispatchRealPaste(editor, "## **标题**\n");

    // Assert
    expect(blockTypes(editor)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(markdownOf(editor)).toContain("## **标题**");
  });

  it("粘贴标题后的草稿保留标题记号", () => {
    // Arrange —— 发送时 serializeDom 走的就是这条序列化 + 归一化链路
    editor = makeEditor("hello");
    editor.commands.setTextSelection(6);

    // Act
    dispatchRealPaste(editor, "## **标题**\n");

    // Assert
    expect(normalizeSerializedMarkdown(markdownOf(editor))).toBe(
      "hello\n\n## **标题**",
    );
  });

  it("标题后粘贴无 HTML 的围栏时生成代码块", () => {
    // Arrange
    editor = makeEditor("");
    dispatchRealPaste(editor, "## **标题**\n");

    // Act
    dispatchRealPaste(editor, "```js\nconst a = 1;\n```");

    // Assert
    expect(blockTypes(editor)).toEqual(["heading", "codeBlock", "paragraph"]);
    expect(editor.state.doc.child(1).attrs.language).toBe("js");
  });

  it("浏览器行内代码包壳里的围栏仍生成代码块", () => {
    // Arrange —— 浏览器把 Markdown 源码包在 <code> 里，纯文本才是真实内容
    editor = makeEditor("");

    // Act
    dispatchRealPaste(
      editor,
      "```js\nconst a = 1;\n```",
      "<code>```js<br>const a = 1;<br>```</code>",
    );

    // Assert
    expect(blockTypes(editor)).toContain("codeBlock");
    expect(markdownOf(editor)).toContain("```js");
  });

  it("粘贴 Markdown 粗体后继续输入是纯文本", () => {
    // Arrange
    editor = makeEditor("");
    dispatchRealPaste(editor, "**测试**", "<div>**测试**</div>");

    // Act —— 与输入法一致：显式 from / to
    const { from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.insertText("X", from, from));

    // Assert
    expect(markdownOf(editor)).toBe("**测试**X");
  });

  it("粘贴浏览器粗体后继续输入是纯文本", () => {
    // Arrange
    editor = makeEditor("hello");
    editor.commands.setTextSelection(6);
    dispatchRealPaste(editor, "粗体", "<b>粗体</b>");

    // Act —— 模拟粘贴后的第一下输入
    const { from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.insertText("X", from, from));

    // Assert
    const lastText = editor.state.doc.lastChild?.lastChild;
    expect(lastText?.text).toContain("X");
    expect(lastText?.marks ?? []).toEqual([]);
  });
});

describe("transformPastedText", () => {
  it("纯文本粘贴先去掉尾随换行", () => {
    // Arrange
    const ed = makeEditor();
    editor = ed;
    let text = "`code`\n";

    // Act
    ed.view.someProp("transformPastedText", (f) => {
      text = f(text, false, ed.view);
    });

    // Assert
    expect(text).toBe("`code`");
  });
});
