/**
 * Composer Markdown 序列化辅助：ProseMirror 文档 ↔ 编辑器文本空间换算。
 *
 * 存在两个坐标空间：
 * - **存储空间**：发给 CLI / 存入 draft 的 Markdown 源码（含 `[[skill:…]]` token）。
 * - **编辑器文本空间**：文档的"可见文本"近似——token 等长于其存储形式，
 *   块之间按段落分隔符（`\n\n`）计数。用于 caret 位置换算。
 *
 * Markdown 语法字符（`**`、`#` 等）在编辑器文本空间中不存在，因此换算在
 * 纯文本 / token 场景下精确，格式化内容场景下为近似值（会向文档末端收敛）。
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { startsWithStoredToken } from "@/lib/draftDoc";
import { skillTokenStoredText } from "@/components/composerSkillNode";
import { refTokenStoredText } from "@/components/composerRefNode";

/**
 * 内联原子节点的 token 文本（存储空间 = 编辑器文本空间）。
 *
 * 每种 token 节点都要在这里被认出来：未被识别的 leaf atom 会在
 * {@link collectSegments} 里被整段跳过，导致 caret 换算系统性偏移、slash / `@`
 * 检测丢掉 token 文本。新增原子节点时**必须**在此登记。
 */
export function atomTokenStoredText(node: ProseMirrorNode): string | null {
  return skillTokenStoredText(node) ?? refTokenStoredText(node);
}

type SegKind = "text" | "atom" | "sep";

type Seg = {
  /** 该段在文档中的起始 PM position。 */
  pos: number;
  /** 编辑器文本空间中的长度。 */
  len: number;
  kind: SegKind;
  /** text/atom 段的文本内容（atom 为 token 存储形式）。 */
  text: string;
};

/** 块子节点之间的编辑器文本分隔符长度。 */
function blockSepLen(parent: ProseMirrorNode): number {
  if (parent.type.name === "doc") return 2; // 段落间空行
  return 1;
}

/**
 * 按文档顺序收集编辑器文本空间分段。
 * 每个分段携带其起始 PM position，使双向换算只需一次遍历。
 */
function collectSegments(doc: ProseMirrorNode): Seg[] {
  const out: Seg[] = [];

  const walkInline = (parent: ProseMirrorNode, contentStart: number) => {
    parent.forEach((child, off) => {
      const childPos = contentStart + off;
      if (child.isText) {
        const text = child.text ?? "";
        if (text) out.push({ pos: childPos, len: text.length, kind: "text", text });
        return;
      }
      const tokenText = atomTokenStoredText(child);
      if (tokenText != null) {
        out.push({
          pos: childPos,
          len: tokenText.length,
          kind: "atom",
          text: tokenText,
        });
        return;
      }
      if (child.type.name === "hardBreak") {
        out.push({ pos: childPos, len: 1, kind: "text", text: "\n" });
        return;
      }
      if (child.isLeaf) return;
      // 嵌套 inline 容器（罕见）：递归展开。
      walkInline(child, childPos + 1);
    });
  };

  const walkBlock = (node: ProseMirrorNode, contentStart: number) => {
    if (node.isTextblock) {
      walkInline(node, contentStart);
      return;
    }
    if (node.isLeaf) return;
    const sep = blockSepLen(node);
    let first = true;
    node.forEach((child, off) => {
      const childStart = contentStart + off;
      if (!first) {
        out.push({
          pos: childStart,
          len: sep,
          kind: "sep",
          text: "\n".repeat(sep),
        });
      }
      first = false;
      walkBlock(child, child.isLeaf ? childStart : childStart + 1);
    });
  };

  walkBlock(doc, 0);
  return out;
}

/** 编辑器文本空间的偏移 → PM position（超出文本长度时收敛到文档末端）。 */
export function docPosForEditorTextOffset(
  doc: ProseMirrorNode,
  offset: number,
): number {
  const target = Math.max(0, offset);
  let acc = 0;
  for (const seg of collectSegments(doc)) {
    if (target <= acc + seg.len) {
      const into = target - acc;
      if (seg.kind === "atom") {
        // 原子节点 nodeSize 为 1：只在完全跨过时落到其后面。
        return seg.pos + (into >= seg.len ? 1 : 0);
      }
      if (seg.kind === "sep") {
        // 分隔是块边界：未跨完收敛到边界起点，跨完落到后一块内容起点。
        return seg.pos + (into >= seg.len ? 1 : 0);
      }
      return seg.pos + into;
    }
    acc += seg.len;
  }
  return doc.content.size;
}

/** PM position → 编辑器文本空间偏移（position 在文档之外时返回总长度）。 */
export function editorTextOffsetForDocPos(
  doc: ProseMirrorNode,
  pos: number,
): number {
  let acc = 0;
  for (const seg of collectSegments(doc)) {
    if (pos <= seg.pos) return acc;
    if (seg.kind === "text" && pos < seg.pos + seg.len) {
      return acc + (pos - seg.pos);
    }
    // text 段整段越过 / atom、sep 到达即计满（atom 在位置空间只占 1）。
    acc += seg.len;
  }
  return acc;
}

/** 文档起点到 `toPos` 之间的编辑器文本（用于 slash 检测的 caret 前缀）。 */
export function editorTextBeforePos(
  doc: ProseMirrorNode,
  toPos: number,
): string {
  const parts: string[] = [];
  for (const seg of collectSegments(doc)) {
    if (seg.pos >= toPos) break;
    if (seg.kind === "text" && seg.pos + seg.len > toPos) {
      parts.push(seg.text.slice(0, Math.max(0, toPos - seg.pos)));
      break;
    }
    parts.push(seg.text);
  }
  return parts.join("");
}

/**
 * 在 Markdown 源码中定位 `/query` 的范围（存储空间坐标）。
 * 要求 `/` 位于行首或空白之后，且匹配是文档中最后一个合法出现。
 */
export function locateSlashRangeInMarkdown(
  md: string,
  query: string,
): { start: number; end: number } | null {
  const needle = `/${query}`;
  let idx = md.lastIndexOf(needle);
  const isBoundary = (c: string | undefined) =>
    c === undefined || /\s/.test(c);
  while (idx >= 0) {
    const before = idx === 0 ? undefined : md[idx - 1];
    const after = md[idx + needle.length];
    if (isBoundary(before) && isBoundary(after)) {
      return { start: idx, end: idx + needle.length };
    }
    idx = md.lastIndexOf(needle, idx - 1);
  }
  return null;
}

/**
 * 在 Markdown 源码中定位 `@query` 的范围（存储空间坐标）。
 *
 * 为什么必须在这里重新定位，而不是直接用 `@` 检测给出的偏移：
 * `detectAtQueryFromEditor` 走的是 **DOM 文本**（`getStoredTextBeforeCaret` 把
 * 光标前的 DOM 片段交给手写的 walk），而那个 walk **不产出 Markdown 语法**——
 * 列表项在 Markdown 里是 `- 第一项`，DOM 文本里只有 `第一项`。把 DOM 偏移套到
 * draft 上，在列表/引用/标题里就会整体左移若干个字符，替换掉光标前的正文并
 * 把 `@query` 留在原地。
 *
 * 边界与 `detectAtQuery` 一致：`@` 必须位于行首或空白之后，query 内不含空白。
 * 取文档中最后一个合法出现（用户刚敲下的那个）。
 */
export function locateAtRangeInMarkdown(
  md: string,
  query: string,
): { start: number; end: number } | null {
  const needle = `@${query}`;
  const isBoundary = (c: string | undefined) =>
    c === undefined || /\s/.test(c);
  /**
   * `@query` 后面紧跟**已有引用 token** 也算合法收尾：用户把光标放在已有 chip 前
   * 再打 `@` 选下一个文件时，正文长成 `@atF[[file:…]]`。只看空白边界会把这种情况
   * 判成「找不到」，调用方于是退化成把新 chip 追加到文末、`@query` 留成纯文本。
   */
  const endsAtToken = (rest: string) => startsWithStoredToken(rest);
  let idx = md.lastIndexOf(needle);
  while (idx >= 0) {
    const before = idx === 0 ? undefined : md[idx - 1];
    const rest = md.slice(idx + needle.length);
    if (isBoundary(before) && (isBoundary(rest[0]) || endsAtToken(rest))) {
      return { start: idx, end: idx + needle.length };
    }
    idx = md.lastIndexOf(needle, idx - 1);
  }
  return null;
}

/**
 * `@` 文件引用插入后，chip 之后的光标在**编辑器文本空间**的偏移。
 *
 * `insertAtTokenAsRef` 返回的 caret 是 Markdown 源码（存储空间）偏移，而
 * `requestComposerStoredCaret` 收的是编辑器文本空间偏移。两个空间只差块语法
 * 前缀——列表项在 Markdown 里是 `- 第一个文件`、编辑器文本里只有 `第一个文件`，
 * 标题、引用同理。直接套用存储空间偏移会在这些块里整体右移若干个字符。
 *
 * 换算方式：在编辑器文本里重新定位 `@query`，用它的下标当作 chip 起点，再加 token
 * 的长度（token 在两个空间等长）。插入时补的分隔空格不必另外计入——它总落在
 * 所在块的末尾，被 ProseMirror 当作尾部空白丢弃；`locateAtRangeInMarkdown` 的
 * 边界规则保证 `@query` 后面只可能是空白、结尾，或一个已有的存储态 token
 * （光标放在既有 chip 前再插入一个引用时的形态）。
 *
 * `editorText` 为 null（编辑器未挂载）或定位失败时退回存储空间 caret，由调用方的
 * 落点逻辑夹到文档范围内。
 */
export function refCaretInEditorText(params: {
  /** 整篇草稿的编辑器文本（见 `getComposerEditorText`）；null = 编辑器不可用。 */
  editorText: string | null;
  /** 用户输入中的 `@` 查询（不含 `@`）。 */
  query: string;
  /** `insertAtTokenAsRef` 在 Markdown 源码里定位到的 `@query` 区间。 */
  range: { start: number; end: number } | null;
  /** 插入的 token 文本（`[[file:…]]`）。 */
  token: string;
  /** `insertAtTokenAsRef` 返回的存储空间 caret。 */
  storedCaret: number;
}): number {
  if (!params.range || params.editorText == null) return params.storedCaret;
  const at = locateAtRangeInMarkdown(params.editorText, params.query);
  return at ? at.start + params.token.length : params.storedCaret;
}

/**
 * 归一化 tiptap-markdown 序列化输出：
 * - hard break 被序列化为 `\\\n`（Markdown 转义换行），还原为普通 `\n`
 *   （`breaks: true` 下 `\n` 反解析回硬换行，draft 保持旧格式的纯换行约定）；
 * - 反向转义 prosemirror-markdown 对 `` ` * _ [ ] ~ `` 的防御性转义——
 *   这些转义只会污染 draft 存储（用户字面文本应原样保留），此处还原后
 *   再解析仍是字面文本，round-trip 稳定；
 * - 去掉尾随换行（draft 存储约定）。
 */
export function normalizeSerializedMarkdown(md: string): string {
  return md
    .replace(/\\([\\`*_[\]~])/g, "$1")
    .replace(/\\\n/g, "\n")
    .replace(/\n+$/, "");
}

/** draft（Markdown 源码 + token）是否为空（仅空白且无 token）。 */
export function isStoredMarkdownEmpty(stored: string): boolean {
  // 只有 token（没有正文字符）不算空——skill 与引用 token 都是可发送内容。
  if (/\[\[(?:skill|plugin|file|dir|url):/.test(stored)) return false;
  return stored.replace(/\n/g, "").trim() === "";
}
