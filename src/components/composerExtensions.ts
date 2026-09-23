/**
 * Composer 的 ProseMirror 扩展集（BOR-53）。
 *
 * 抽成工厂函数是为了让 `ComposerEditor` 与 headless 测试用**同一份**扩展清单：
 * 之前测试里另抄了一份，新增节点（如引用 token）时两边会静默漂移——测试通过
 * 但真实编辑器不认这个节点，或反之。
 */

import { Extension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { SkillTokenNode } from "@/components/composerSkillNode";
import { RefTokenNode } from "@/components/composerRefNode";

/**
 * 列表项内的换行语义。
 *
 * 本应用把 Enter 绑成了「发送」（`composerSendKey` 默认 `enter`），所以在列表里
 * **唯一还能用的换行手势就是 Shift+Enter**；而 StarterKit 的 HardBreak 只会插入
 * 一个软换行——光标仍停在同一项里，第二项既拿不到编号也走不出去。
 *
 * 因此在列表项内部把 Shift+Enter 改成「新起一个同级列表项」；列表外保持原有的
 * 硬换行。代价是列表项内做不出「同一项内的软换行」，这是 Enter 发送前提下的取舍。
 */
const ListLineBreak = Extension.create({
  name: "listLineBreak",
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => {
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          if ($from.node(depth).type.name === "listItem") {
            // 空项时 splitListItem 会返回 false —— 让它落到 HardBreak，
            // 不要在这里吞掉按键。
            return this.editor.commands.splitListItem("listItem");
          }
        }
        return false;
      },
    };
  },
});

export type ComposerExtensionOptions = {
  /** 空文档时显示的占位符。 */
  placeholder?: string;
  /** 是否在可编辑时显示占位符（测试用 headless 编辑器通常为 false）。 */
  showPlaceholderWhenEditable?: boolean;
};

/** 构建 composer 使用的扩展数组。 */
export function buildComposerExtensions(opts: ComposerExtensionOptions = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: false },
    }),
    SkillTokenNode,
    RefTokenNode,
    ListLineBreak,
    Placeholder.configure({
      placeholder: opts.placeholder ?? "",
      showOnlyWhenEditable: opts.showPlaceholderWhenEditable ?? true,
    }),
    Markdown.configure({
      html: false,
      // breaks: 保证 Shift+Enter 硬换行在 "line1\nline2" 序列化下可回解析。
      breaks: true,
      linkify: false,
      transformPastedText: true,
      transformCopiedText: false,
    }),
  ];
}
