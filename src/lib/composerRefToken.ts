/**
 * 内联引用 token 的语法与取值（BOR-53）。
 *
 * 存储态用不与正文撞车的专用 token，而不是直接把 `@路径` 写进 draft：
 * 否则「用户手打的 `@/goal`」与「真的文件引用」在编辑回填时无法区分。
 * 发送给 CLI 时才由 {@link refAgentText} 转成 `@绝对路径`。
 *
 * 与 skill token（`[[skill:name]]`）同族，但字符集必须容纳带 `/` 与空格的
 * 路径，因此单独定义。路径里只有两个字符会破坏该语法（`%` 与 `]`），按
 * URL 习惯做百分号转义——不含这两个字符的路径保持完全可读。
 */

/** 引用类型。`url` 由 BOR-57 引入，语法先在此固定。 */
export type RefKind = "file" | "dir" | "url";

const REF_KINDS: readonly RefKind[] = ["file", "dir", "url"];

/** token 前缀 → 类型；未知前缀一律不认。 */
const PREFIX: Record<RefKind, string> = {
  file: "file",
  dir: "dir",
  url: "url",
};

/**
 * 转义会破坏 `[[kind:value]]` 语法的字符。
 *
 * 只转义 `%`（转义符本身）与 `]`（会提前闭合 token）。换行由调用方拒绝，
 * 见 {@link isTokenizableRefValue}。
 */
export function escapeRefValue(value: string): string {
  return value.replace(/%/g, "%25").replace(/]/g, "%5D");
}

/** {@link escapeRefValue} 的逆操作。 */
export function unescapeRefValue(value: string): string {
  return value.replace(/%5D/gi, "]").replace(/%25/gi, "%");
}

/**
 * 该值能否安全地放进 token。换行会跨段落、破坏 inline 结构，因此拒绝；
 * 拒绝时调用方应退回纯文本，而不是写出一个解析不回来的 token。
 */
export function isTokenizableRefValue(value: string): boolean {
  return value.length > 0 && !/[\r\n]/.test(value);
}

/** token 文本形式（draft / 消息历史的存储态）。 */
export function refTokenText(kind: RefKind, value: string): string {
  return `[[${PREFIX[kind]}:${escapeRefValue(value)}]]`;
}

/** 匹配单个 token；`g` 标志，调用方需自行管理 `lastIndex`。 */
export const REF_TOKEN_RE = new RegExp(
  `\\[\\[(file|dir|url):((?:[^\\]\\r\\n])*)\\]\\]`,
  "g",
);

/** 解析一段文本开头的 token（markdown-it inline 规则用，锚定 pos）。 */
export function matchRefTokenAt(
  src: string,
  pos: number,
): { kind: RefKind; value: string; length: number } | null {
  if (src.charCodeAt(pos) !== 0x5b) return null;
  REF_TOKEN_RE.lastIndex = pos;
  const m = REF_TOKEN_RE.exec(src);
  if (!m || m.index !== pos) return null;
  const kind = m[1] as RefKind;
  if (!REF_KINDS.includes(kind)) return null;
  return { kind, value: unescapeRefValue(m[2] ?? ""), length: m[0].length };
}

/**
 * token 在**发送给 CLI 的 Markdown 源码**里的形态。
 *
 * 文件与目录沿用 CLI 既有的 `@路径` 引用语法（与 `buildAgentPrompt` 的附件
 * 写法一致，CLI 侧无需改动）；URL 就是链接本身。
 */
export function refAgentText(kind: RefKind, value: string): string {
  return kind === "url" ? value : `@${value}`;
}

/** 路径的最后一段（chip 显示的短标签）。 */
export function refDisplayLabel(kind: RefKind, value: string): string {
  if (kind === "url") {
    // 只取主机名：完整 URL 会在输入框里撑得很宽。
    const host = value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
    return host || value;
  }
  const trimmed = value.replace(/[/\\]+$/, "");
  const last = trimmed.split(/[/\\]/).pop();
  return last || value;
}
