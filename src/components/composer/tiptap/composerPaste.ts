/**
 * Markdown（TipTap）输入框的粘贴策略。
 *
 * 剪贴板带 `text/html` 时 ProseMirror 一律走 HTML 解析：纯文本包壳里的块级记号
 * （`#` / ```` ``` ```` / `- `）会退化成字面量。库自带的纯文本路径是行内解析，
 * 同样压平块级记号。
 *
 * 本扩展按"来源像不像 Markdown 源码"分三档处理，普通文字保持原样：
 * - `block`：`code` / `pre` 包壳，或多行且含块级记号，按块级 Markdown 解析；
 * - `inline`：其余包壳 / 无 HTML 文本，只解析行内记号，块级记号保持字面量；
 * - `none`：本编辑器自己的 slice 与带语义的富文本 HTML，交给 ProseMirror 解析。
 *
 * 判定规则、例外与所用库 API 见 docs/llm-wiki/composer-markdown.md。
 */

import { Extension } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** `doc.body` 内不携带语义的标签。 */
const NEUTRAL_TAGS = new Set(["META", "TITLE", "DIV", "P", "BR", "SPAN"]);

/** Markdown 源码包壳：浏览器把源码包在行内 `code` 或 `pre` 里。 */
const SOURCE_TAGS = new Set(["PRE", "CODE"]);

/** 行内记号在 HTML 里对应的标签；它们都算"有标记覆盖"。 */
const MARK_TAGS = "strong,em,code,s,del,a,mark,u";

/** 行内解析结果里出现的块级标签，说明 markdown-it 已把文本提升成块。 */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "HR",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TD",
  "TH",
]);

/**
 * 行首的块级记号。命中任意一条即视为 Markdown 块级源码。
 *
 * 单行 `# 话题` / `- 一句话` 与普通句子无法区分，因此只在多行内容里生效。
 */
const BLOCK_START_PATTERNS = [
  /^ {0,3}#{1,6}(?:[ \t]|$)/, // ATX 标题
  /^ {0,3}(?:```|~~~)/, // 围栏
  /^ {0,3}>/, // 引用
  /^ {0,3}[-*+][ \t]/, // 无序列表
  /^ {0,3}\d{1,9}[.)][ \t]/, // 有序列表
  /^ {0,3}\|/, // 表格行
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/, // 分隔线
  /^ {0,3}=+[ \t]*$/, // setext 下划线
];

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

/**
 * 本编辑器复制时会在首个元素写 `data-pm-slice`，ProseMirror 靠它恢复完整 slice
 * （列表项、代码块等）。返回 `true` 表示这次粘贴归 ProseMirror 自己处理。
 */
export function clipboardHtmlIsOwnSlice(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.querySelector("[data-pm-slice]") !== null;
}

/**
 * `text/html` 是否只是 Markdown 源码的 `code` / `pre` 包壳。
 *
 * 浏览器把 Markdown 源码渲染成行内 `code` 时，`text/plain` 才是用户复制的原文；
 * 代码高亮器会在 `code` 里塞 `span`，因此外观标签不算语义。要求包壳内的文本与
 * 纯文本完全一致，页面里"正文 + 行内代码"不会被误判成源码。
 */
export function clipboardHtmlIsMarkdownSource(
  html: string,
  plain: string,
): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const elements = Array.from(doc.body.querySelectorAll("*"));
  const hasSemantics = elements.some(
    (el) =>
      !NEUTRAL_TAGS.has(el.tagName) &&
      el.tagName !== "SPAN" &&
      !SOURCE_TAGS.has(el.tagName),
  );
  if (hasSemantics) return false;
  const sourceText = comparableText(plain);
  return elements.some(
    (el) =>
      SOURCE_TAGS.has(el.tagName) &&
      comparableText(el.textContent ?? "") === sourceText,
  );
}

/**
 * 纯文本是否像一段 Markdown 块级源码：至少两行，且有一行以块级记号开头。
 *
 * 多行普通段落（例如网页上的两句话）不含块级记号，仍按行内处理。
 */
export function looksLikeMarkdownBlockSource(markdown: string): boolean {
  const lines = markdown.split("\n");
  if (lines.length < 2) return false;
  return lines.some((line) =>
    BLOCK_START_PATTERNS.some((pattern) => pattern.test(line)),
  );
}

/** 这次粘贴按哪种粒度解析 `text/plain`。 */
export type ComposerPastePlan = "block" | "inline" | "none";

/**
 * 决定粘贴的解析粒度。
 *
 * 顺序即优先级：`data-pm-slice`（本编辑器的内容）→ `code` / `pre` 源码包壳 →
 * 无语义包壳 → 带语义的富文本。块级提升只发生在明确的 Markdown 源码上。
 */
export function planPastedMarkdown(
  plain: string,
  html: string | null,
): ComposerPastePlan {
  const markdown = normalizePastedMarkdown(plain);
  if (!markdown) return "none";
  if (html) {
    if (clipboardHtmlIsOwnSlice(html)) return "none";
    if (clipboardHtmlIsMarkdownSource(html, plain)) return "block";
    if (!clipboardHtmlIsPlainWrapper(html, plain)) return "none";
  }
  return looksLikeMarkdownBlockSource(markdown) ? "block" : "inline";
}

/** tiptap-markdown 在运行时挂到 `storage.markdown` 上的解析器（只取用到的部分）。 */
type MarkdownParserStorage = {
  markdown?: {
    parser?: {
      parse?: (
        markdown: string,
        options?: { inline?: boolean },
      ) => string;
    };
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

/** 行内解析结果里是否出现块级标签。 */
function containsBlockTags(container: HTMLElement): boolean {
  return Array.from(container.querySelectorAll("*")).some((el) =>
    BLOCK_TAGS.has(el.tagName),
  );
}

/**
 * 行内解析结果是否整段都带标记（例如 `**测试**`、`` `code` ``）。
 *
 * 混在普通句子里的 `_斜体_` / `**粗体**` 说明这是正文而不是 Markdown 源码，
 * 保持字面量，避免"粘贴网页文字后下划线消失"。
 */
function isFullyMarked(container: HTMLElement): boolean {
  const all = comparableText(container.textContent ?? "");
  if (!all) return false;
  const outermost = Array.from(container.querySelectorAll(MARK_TAGS)).filter(
    (el) => el.parentElement?.closest(MARK_TAGS) === null,
  );
  const marked = comparableText(
    outermost.map((el) => el.textContent ?? "").join(""),
  );
  return marked === all;
}

/** 按字面量插入纯文本，不继承光标处的标记。 */
function insertPlainText(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  editor.view.dispatch(
    editor.state.tr.replaceWith(from, to, editor.schema.text(text)),
  );
  return true;
}

/**
 * 行内 Markdown 插入：解析成行内 HTML，再用 schema 转成 slice 替换选区。
 *
 * 不能走 `insertContentAt`：库会把它再次当作 Markdown 解析，而本编辑器关闭了
 * `html`，标签会变成字面量。这里与库的 `clipboardTextParser` 使用同一套 API。
 * 解析结果出现块级结构或单行内容混有正文时，退回字面量。
 */
function insertInlineMarkdown(editor: Editor, markdown: string): boolean {
  const parser = (editor.storage as MarkdownParserStorage).markdown?.parser;
  if (!parser?.parse) return false;
  const inlineHtml = parser.parse(markdown, { inline: true });
  const container = new DOMParser().parseFromString(inlineHtml, "text/html")
    .body;
  if (
    containsBlockTags(container) ||
    (!markdown.includes("\n") && !isFullyMarked(container))
  ) {
    return insertPlainText(editor, markdown);
  }
  const { $from } = editor.state.selection;
  const slice = ProseMirrorDOMParser.fromSchema(editor.schema).parseSlice(
    container,
    { preserveWhitespace: true, context: $from },
  );
  if (!slice.content.size) return false;
  editor.view.dispatch(editor.state.tr.replaceSelection(slice));
  return true;
}

/** 剪贴板粘贴：按来源决定解析粒度；所有纯文本粘贴先归一化。 */
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
            const plan = planPastedMarkdown(plain, html);
            if (plan === "none") return false;

            const parser = (editor.storage as MarkdownParserStorage).markdown
              ?.parser;
            if (!parser?.parse) return false;
            const markdown = normalizePastedMarkdown(plain);
            const inserted =
              plan === "block"
                ? editor.commands.insertContentAt(
                    { from: selection.from, to: selection.to },
                    markdown,
                  )
                : insertInlineMarkdown(editor, markdown);
            if (!inserted) return false;

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
