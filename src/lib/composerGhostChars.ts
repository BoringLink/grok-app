/**
 * WebKit（内容可编辑区）在光标越过文本边界时会注入的“垫片”字符。
 *
 * 这些字符不可见，却会进入草稿、序列化成真实字符，或在编辑器里渲染成缺字
 * 方块（豆腐块）。内置编辑器序列化时一直会剔除它们；Markdown（TipTap）档
 * 此前没有对应逻辑，按右方向键越过行尾后就会留下方块。
 *
 * 只收 WebKit 真正注入的四个码点：ZWSP、BOM、word joiner、对象替换符。
 * ZWNJ / ZWJ 可能属于 emoji 序列，Markdown 档必须保留。
 */

/** WebKit 移动光标时注入的垫片字符。 */
export const WEBKIT_CARET_GHOST_CHARS_RE = /[\u200B\uFEFF\u2060\uFFFC]/g;

/** 从任意字符串里剔除光标垫片（用于草稿 / 序列化边界）。 */
export function stripComposerGhostChars(text: string): string {
  return text.replace(WEBKIT_CARET_GHOST_CHARS_RE, "");
}

/**
 * 该 UTF-16 码元是否是 WebKit 光标移动留下的垫片。
 *
 * 与 {@link WEBKIT_CARET_GHOST_CHARS_RE} 保持同一集合。
 */
export function isWebkitCaretGhostCode(code: number): boolean {
  return (
    code === 0x200b || code === 0xfeff || code === 0x2060 || code === 0xfffc
  );
}
