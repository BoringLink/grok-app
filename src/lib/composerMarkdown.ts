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
