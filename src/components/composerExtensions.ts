/**
 * Composer 的 ProseMirror 扩展集（BOR-53）。
 *
 * 抽成工厂函数是为了让 `ComposerEditor` 与 headless 测试用**同一份**扩展清单：
 * 之前测试里另抄了一份，新增节点（如引用 token）时两边会静默漂移——测试通过
 * 但真实编辑器不认这个节点，或反之。
 */

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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

/**
 * 光标所在块是否是一个**空白**列表项。
 *
 * 「空白」= 该项只有一个空文本块（`listItem > paragraph`，段落内容为空）。
 * 不能拿 `listItem.content.size` 判空——里面那个空段落本身也有 nodeSize。
 */
function isEmptyListItem(node: { childCount: number; firstChild: { content: { size: number }; isTextblock: boolean } | null }): boolean {
  return (
    node.childCount === 1 &&
    !!node.firstChild &&
    node.firstChild.isTextblock &&
    node.firstChild.content.size === 0
  );
}

const ListLineBreak = Extension.create({
  name: "listLineBreak",
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => {
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const node = $from.node(depth);
          if (node.type.name !== "listItem") continue;
          // 空白列表项再换行 = 离开列表、回到普通文本行（Word/Notion 同款）。
          // 若在这里调 splitListItem：它对空项返回 false，按键会落到 HardBreak，
          // 结果是「项里多了一个软换行、缩进还在、没有新项」——再按一次才因为该项
          // 不再为空而裂出新项，正是用户报的那个别扭行为。
          if (isEmptyListItem(node)) {
            return this.editor.commands.liftListItem("listItem");
          }
          return this.editor.commands.splitListItem("listItem");
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

/**
 * 代码块的语言栏数据源：把节点的 `language` 镜像成 DOM 上的 `data-language`。
 *
 * 用装饰器加**属性**，而不是自定义 NodeView：编辑器的存储态序列化会遍历 DOM
 * （`draftDoc.serializeEditorDomWalk`），NodeView 里多出来的语言栏元素会被当成
 * 正文；装饰器不进文档模型，markdown 往返、光标坐标都不受影响。
 *
 * 语言文本本身已由 tiptap 的 codeBlock 渲染成 `<code class="language-js">`，
 * 这里只是让 CSS 能用 `content: attr(data-language)` 把它显示出来
 * （对齐聊天侧 `.chat-code__lang`，输入框不提供复制按钮）。
 */
const CodeBlockLanguageLabel = Extension.create({
  name: "codeBlockLanguageLabel",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("codeBlockLanguageLabel"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "codeBlock") return;
              const language = String(node.attrs.language ?? "").trim();
              if (!language) return;
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  "data-language": language,
                }),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

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
    CodeBlockLanguageLabel,
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
