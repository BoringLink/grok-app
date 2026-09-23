/**
 * Composer 的 ProseMirror 扩展集（BOR-53）。
 *
 * 抽成工厂函数是为了让 `ComposerEditor` 与 headless 测试用**同一份**扩展清单：
 * 之前测试里另抄了一份，新增节点（如引用 token）时两边会静默漂移——测试通过
 * 但真实编辑器不认这个节点，或反之。
 */

import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { SkillTokenNode } from "@/components/composerSkillNode";
import { RefTokenNode } from "@/components/composerRefNode";

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
