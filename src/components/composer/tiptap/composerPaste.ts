/**
 * Markdown（TipTap）输入框的粘贴策略。
 *
 * 剪贴板带 `text/html` 时 ProseMirror 一律走 HTML 解析：纯文本包壳里的块级记号
 * （`#` / ```` ``` ```` / `- `）会退化成字面量。库自带的纯文本路径是行内解析，
 * 同样压平块级记号。本扩展把包壳 HTML 与纯文本都交给块级 Markdown 解析，并统一
 * 归一化首尾空行、清掉粘贴后残留的标记状态。
 *
 * 判定规则、例外与所用库 API 见 docs/llm-wiki/composer-markdown.md。
 */

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** `doc.body` 内不携带语义的标签。 */
const NEUTRAL_TAGS = new Set(["META", "TITLE", "DIV", "P", "BR", "SPAN"]);

/** 比较用文本：忽略一切空白差异。 */
function comparableText(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 统一 CRLF，并去掉剪贴板自带的首尾空行；全空白粘贴归一化为空串。 */
export function normalizePastedMarkdown(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\n(?:[ \t]*\n)*[ \t]*$/, "");
  return normalized.trim() ? normalized : "";
}

/**
 * `text/html` 是否只是 `text/plain` 的包壳。
 *
 * 标签无语义、且文本内容与纯文本一致才算包壳；判据细节见
 * docs/llm-wiki/composer-markdown.md。
 */
export function clipboardHtmlIsPlainWrapper(html: string, plain: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const elements = Array.from(doc.body.querySelectorAll("*"));
  const hasSemantics = elements.some(
    (el) =>
      !NEUTRAL_TAGS.has(el.tagName) ||
      (el.tagName === "SPAN" &&
        (el.hasAttribute("style") || el.hasAttribute("class"))),
  );
  if (hasSemantics) return false;
  const htmlText = comparableText(doc.body.textContent ?? "");
  if (!htmlText) return comparableText(plain).length > 0;
  return htmlText === comparableText(plain);
}

/** Markdown 解析结果里出现的块级标签。 */
const MARKDOWN_BLOCK_TAGS = new Set([
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "HR",
  "TABLE",
]);

/** 解析后的 HTML 是否产生了块级结构（标题 / 围栏 / 列表 / 引用 / 分隔线 / 表格）。 */
export function markdownHtmlHasBlocks(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.body.children).some((el) =>
    MARKDOWN_BLOCK_TAGS.has(el.tagName),
  );
}

/**
 * 这次粘贴是否应接管：按块级 Markdown 解析 `text/plain`。
 *
 * 无 `text/html` 时同样接管——库自带的 `clipboardTextParser` 是行内解析，
 * 光标在段落内时会把 `#` / ```` ``` ```` 这类块标记压平，标题与代码块因此丢失。
 */
export function shouldParsePastedMarkdown(
  plain: string,
  html: string | null,
): boolean {
  const normalized = normalizePastedMarkdown(plain);
  if (!normalized) return false;
  if (!html) return true;
  return clipboardHtmlIsPlainWrapper(html, plain);
}

/** tiptap-markdown 在运行时挂到 `storage.markdown` 上的解析器（只取用到的部分）。 */
type MarkdownParserStorage = {
  markdown?: {
    parser?: { parse?: (markdown: string) => unknown };
  };
};

/**
 * 粘贴内容以标记结尾时，光标落在标记范围内，`marks()` 仍是粗体 / 斜体。
 * 返回清空 `storedMarks` 的事务，让粘贴后的输入回到纯文本。
 */
function trailingMarksReset(state: EditorState): Transaction | null {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || !$from.marks().length) return null;
  return state.tr.setStoredMarks([]);
}

/** 剪贴板粘贴：纯文本包壳按 Markdown 解析；所有纯文本粘贴先归一化。 */
export const ComposerMarkdownPaste = Extension.create({
  name: "composerMarkdownPaste",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("composerMarkdownPaste"),
        appendTransaction(transactions, _oldState, newState) {
          // 只有 ProseMirror 自己处理的粘贴（HTML 回退路径）带 `paste` meta。
          if (!transactions.some((tr) => tr.getMeta("paste"))) return null;
          return trailingMarksReset(newState);
        },
        props: {
          transformPastedText(text: string) {
            return normalizePastedMarkdown(text);
          },
          handlePaste(view: EditorView, event: ClipboardEvent) {
            const { selection } = view.state;
            if (
              selection.$from.parent.type.spec.code ||
              selection.$to.parent.type.spec.code
            ) {
              return false;
            }
            const data = event.clipboardData;
            if (!data) return false;
            const plain = data.getData("text/plain");
            const html = data.getData("text/html");

            const parser = (editor.storage as MarkdownParserStorage).markdown
              ?.parser;
            if (!parser?.parse) return false;
            const markdown = normalizePastedMarkdown(plain);
            if (!markdown) return false;

            // 带语义的 HTML 通常保持 HTML 解析；但若纯文本本身是块级 Markdown
            // （浏览器把 `` ```js `` 这类源码包在行内 code 里），仍以 Markdown 为准。
            const takeover =
              shouldParsePastedMarkdown(plain, html) ||
              markdownHtmlHasBlocks(String(parser.parse(markdown)));
            if (!takeover) return false;

            const { from, to } = selection;
            if (!editor.commands.insertContentAt({ from, to }, markdown)) {
              return false;
            }
            const reset = trailingMarksReset(editor.state);
            if (reset) editor.view.dispatch(reset);
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
