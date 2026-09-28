/**
 * Composer 的 ProseMirror 扩展集（BOR-53）。
 *
 * 抽成工厂函数是为了让 `ComposerEditor` 与 headless 测试用**同一份**扩展清单：
 * 之前测试里另抄了一份，新增节点（如引用 token）时两边会静默漂移——测试通过
 * 但真实编辑器不认这个节点，或反之。
 */

import { Extension, InputRule } from "@tiptap/react";
import { findWrapping } from "@tiptap/pm/transform";
import { TextSelection } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { SkillTokenNode } from "@/components/composer/tiptap/composerSkillNode";
import { RefTokenNode } from "@/components/composer/tiptap/composerRefNode";

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

/**
 * 硬换行之后直接敲列表标记（`- ` / `1. `）也要起列表。
 *
 * ProseMirror 的列表输入规则锚在**段落开头**（`^\s*([-+*])\s$`），而 Shift+Enter
 * 只插入一个 `hardBreak` 叶子节点（在规则眼里是占位字符 `\uFFFC`），光标仍停在
 * 同一段里——于是「换行后敲标记」永远匹配不上，列表起不来。
 *
 * 本应用 Enter 被绑成发送，Shift+Enter 是**唯一**的换行手势，所以先插文件引用、
 * 再换行写清单这种常见路径会彻底卡住（BOR-73 验收发现）。
 *
 * 处理方式：识别「硬换行 + 行首空白 + 标记」这一串，删掉换行与刚敲下的标记，
 * 在原位裂块，再把新块包成列表——等价于用户在一段新段落里敲下标记。
 */
/**
 * 叶子节点在 ProseMirror 的 `textBetween` 里写作 `\uFFFC`（用它反算硬换行的文档
 * 位置：文本块内每个文本字符与每个叶子恰好各占 1 个位置）。
 *
 * 注意**不要**用正则后顾去匹配硬换行：输入规则看到的是 tiptap 另拼的一份文本
 * （`getTextContentFromNodes`，硬换行在那里是 `"\n"`），而且后顾语法在旧版
 * WebKit（Linux 的 WebKitGTK）上会让整个正则字面量报错。所以统一在 handler 里拿
 * 这份 `\uFFFC` 文本自己判断「标记是否落在行首」。
 */
/** 硬换行在下面这份文本里的占位符。 */
const DOC_LEAF = "\uFFFC";
/** 其它叶子（引用 chip、技能 chip 等）：同样占 1 个位置，但不能当成换行。 */
const DOC_LEAF_OTHER = "\uFFFD";

/** 叶子节点按类型给占位符：位置换算 1:1，同时能区分「换行」与「chip」。 */
function leafPlaceholder(node: { type: { name: string } }): string {
  return node.type.name === "hardBreak" ? DOC_LEAF : DOC_LEAF_OTHER;
}
function listAfterBreakRules() {
  const rule = (
    listName: "bulletList" | "orderedList",
    marker: string,
  ): InputRule =>
    new InputRule({
      // 先按「标记 + 一个空白」匹配，是否真的在行首由 handler 判定（见上）
      find: new RegExp(`${marker}[ \\t]$`),
      handler: ({ state, range, match }) => {
        const listType = state.schema.nodes[listName];
        if (!listType) return null;
        // 光标之前（不含刚敲下的标记）的这份文本里，每个文本字符与每个叶子都恰好
        // 占 1 个位置，所以「末尾非空白字符是硬换行」等价于「标记落在行首」。
        const $from = state.doc.resolve(range.from);
        const before = $from.parent.textBetween(
          0,
          $from.parentOffset,
          null,
          leafPlaceholder,
        );
        const trimmed = before.replace(/[ \t]+$/, "");
        if (!trimmed.endsWith(DOC_LEAF)) return null;
        const breakPos = $from.start() + trimmed.length - 1;
        // 再用文档本身确认一次：正文里手打的 U+FFFC 不该被当成换行
        if (state.doc.nodeAt(breakPos)?.type.name !== "hardBreak") return null;

        const tr = state.tr;
        tr.delete(breakPos, range.to); // 去掉硬换行与刚敲下的标记
        tr.split(breakPos); // 在原位裂块：标记所在的那一行成为新段落
        // 裂块后 breakPos 是两个段落之间的边界：+1 是段落的开标记，+2 才是内容起点
        const $pos = tr.doc.resolve(breakPos + 2);
        const blockRange = $pos.blockRange();
        const wrapping =
          blockRange &&
          findWrapping(blockRange, listType, {
            ...(listName === "orderedList"
              ? { start: Number(match[1]) || 1 }
              : {}),
          });
        if (!blockRange || !wrapping) return null;
        tr.wrap(blockRange, wrapping);
        tr.setSelection(
          TextSelection.near(tr.doc.resolve(tr.mapping.map(breakPos + 2))),
        );
        // 不必返回 transaction：tiptap 检查上面这个 tr 的 steps 后统一 dispatch
      },
    });
  return [rule("bulletList", "[-+*]"), rule("orderedList", "(\\d+)\\.")];
}

const ListAfterBreak = Extension.create({
  name: "listAfterBreak",
  addInputRules() {
    return listAfterBreakRules();
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
    ListAfterBreak,
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
