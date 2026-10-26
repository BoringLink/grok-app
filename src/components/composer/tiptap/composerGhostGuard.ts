/**
 * Markdown（TipTap）输入框的光标垫片防护。
 *
 * 与内置编辑器同一类问题：WebKit 在光标越过文档首尾时会把 ZWSP / U+FFFC
 * 等垫片写进 contenteditable。ProseMirror 的 DOM 观察器会把它当成真实文本
 * 收进文档，于是输入框里留下一个渲染不出来的方块。
 *
 * 两层防护：
 * 1. 文档首尾的方向键不交给 WebKit（`addKeyboardShortcuts`）；
 * 2. 万一垫片已经进了文档（硬件键盘 / IME 路径），`appendTransaction`
 *    在文档变更后立刻把它删掉。
 */

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { isWebkitCaretGhostCode } from "@/lib/composerGhostChars";

export const composerGhostGuardKey = new PluginKey("composerGhostGuard");

/** 光标是否停在文档最末端（再按右方向键只会让 WebKit 写垫片）。 */
export function isCaretAtDocEnd(state: EditorState): boolean {
  const selection = state.selection;
  return selection.empty && selection.from === state.doc.content.size - 1;
}

/** 光标是否停在文档最开头（向左越界同理）。 */
export function isCaretAtDocStart(state: EditorState): boolean {
  const selection = state.selection;
  return selection.empty && selection.from === 1;
}

/**
 * 把文档里所有 WebKit 光标垫片删掉的 transaction；没有垫片时返回 null。
 *
 * 先把要删的区间收集完再统一删除，避免边遍历边改位置。
 */
export function removeGhostCharsTransaction(
  state: EditorState,
): Transaction | null {
  const ranges: Array<{ from: number; to: number }> = [];

  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? "";
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ghost = isWebkitCaretGhostCode(text.charCodeAt(i));
      if (ghost && start < 0) start = i;
      if (!ghost && start >= 0) {
        ranges.push({ from: pos + start, to: pos + i });
        start = -1;
      }
    }
    if (start >= 0) {
      ranges.push({ from: pos + start, to: pos + text.length });
    }
    return true;
  });

  if (ranges.length === 0) return null;
  const tr = state.tr;
  // 从后往前删：前面的区间不会被前面的删除影响。
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const range = ranges[i]!;
    tr.delete(range.from, range.to);
  }
  return tr;
}

const ghostCleanupPlugin = new Plugin({
  key: composerGhostGuardKey,
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    return removeGhostCharsTransaction(newState);
  },
});

export const ComposerGhostGuard = Extension.create({
  name: "composerGhostGuard",

  addKeyboardShortcuts() {
    return {
      ArrowRight: () => isCaretAtDocEnd(this.editor.state),
      ArrowLeft: () => isCaretAtDocStart(this.editor.state),
    };
  },

  addProseMirrorPlugins() {
    return [ghostCleanupPlugin];
  },
});
