# 输入框 Markdown 档（TipTap）· 粘贴与闭合记号

设置里可把输入框切到 **Markdown 档**（WYSIWYG）。存储态与发送内容始终是 Markdown
源码，编辑器里显示的是解析后的结构。这篇记录该档的粘贴规则，避免"闭合记号粘进来
只剩字面量 / 行尾多出一条空白行"。

## 源码

| 位置 | 作用 |
|------|------|
| `src/components/composer/tiptap/ComposerEditorTiptap.tsx` | 编辑器实例、文件 / 图片 / URL chip 的粘贴前置分支 |
| `src/components/composer/tiptap/composerExtensions.ts` | 扩展清单（内置档与 headless 测试共用） |
| `src/components/composer/tiptap/composerPaste.ts` | 粘贴归一化 + 纯文本包壳判定 |

## 粘贴判定

剪贴板通常同时带 `text/html` 与 `text/plain`。ProseMirror 只要看到 `text/html`
就走 HTML 解析，而 tiptap 的 paste rule 只识别**行内**记号（`**` / `` ` `` / `~~`），
块级记号（`#` / ```` ``` ```` / `- ` / `> `）不在其中。因此按下面的顺序判定：

| `text/html` | 处理 | 结果 |
|-------------|------|------|
| 不存在 | 由本扩展接管，按块级 Markdown 解析 `text/plain` | 标题、围栏、列表、行内记号都成立 |
| 只是纯文本包壳（只有 `div` / `p` / `br` / 无样式 `span`，且文本内容与 `text/plain` 一致） | 忽略 HTML，按 Markdown 解析 `text/plain` | 标题、围栏、列表、行内记号都成立 |
| 带语义标签（`strong` / `h1`-`h6` / `pre` / `code` / `a` / `table` / 带样式的 `span` …） | 保持 HTML 解析；纯文本本身解析出块级结构时改按 Markdown | 富文本不会被退回源码；浏览器把 ```` ```js ```` 包在行内 `code` 里时仍生成代码块 |

无 `text/html` 时同样接管：库自带的 `clipboardTextParser` 是**行内**解析，光标在已有
段落里时会把 `## ` / ```` ``` ```` 压平，标题与代码块退化成粗体 / 字面量。

带语义 HTML 的例外判据在 `markdownHtmlHasBlocks()`：用库自己的解析器解析纯文本，
结果里出现 `pre` / `h1`-`h6` / `ul` / `ol` / `blockquote` / `hr` / `table` 才接管，
因此粘贴浏览器粗体（解析结果只有 `p`）仍然保留 HTML 的粗体。

纯文本包壳的判据在 `clipboardHtmlIsPlainWrapper()`：
**标签无语义 + 文本一致**（比较时忽略一切空白，`<br>` / `<div>` 的换行不会造成误判）。

## 粘贴后的标记状态

粘贴内容以标记结尾时（例如从浏览器复制的粗体），光标落在标记范围内，`marks()`
仍返回该标记，继续输入会一直是粗体。`trailingMarksReset()` 把 `storedMarks` 置空，
粘贴后的第一下输入回到纯文本。它从两个入口调用：

- 本扩展自己插入后立即调用（这条路径没有 `paste` meta）；
- `appendTransaction` 里对带 `meta: "paste"` 的事务调用（ProseMirror 的 HTML 回退路径）。

## 首尾换行

`normalizePastedMarkdown()` 统一 CRLF，并去掉开头 / 结尾的空行（保留最后一行自身的
尾随空格——行内粘贴时它是正文的一部分）：

- 末尾换行是剪贴板的行终止符，不是用户想要的新行。`breaks: true` 下它会被解析成
  `hardBreak`，段落末尾多出一行；光标在行尾按右方向键会走进这条看不见的空行。
- 中间换行保留——`breaks: true` 会把它还原成软换行，序列化为 `\\\n`，草稿归一化后
  是普通 `\n`。
- 纯文本粘贴路径通过 `transformPastedText` 归一化；带 HTML 的包壳路径在接管前归一化。

## 例外

- **代码块内**粘贴不接管（选区两端都在 `spec.code` 节点内）：正文按字面量交给
  ProseMirror 的 `inCode` 分支。`transformPastedText` 对所有文本粘贴生效，因此代码块
  内的 CRLF 与首尾空行仍会被归一化。
- 文件 / 图片 / 整段 URL 的粘贴由 `ComposerEditorTiptap` 的 `editorProps.handlePaste`
  先处理；插件按"view props 先于插件 props"的顺序只看剩余情况。
- 语言代码块的语言栏是装饰器（`data-language`），不参与文档模型。

## 库边界（升级注意）

| 步骤 | 使用的原生能力 |
|------|----------------|
| 纯文本归一化 | ProseMirror `transformPastedText` 钩子 |
| Markdown → 文档 | tiptap-markdown 重写的 `editor.commands.insertContentAt`（内部用库自己的 parser） |
| 包壳 HTML 判定 | 本仓库策略（HTML 标签语义 + 文本一致） |

tiptap-markdown 0.9.0（当前最新）只有 `transformPastedText` 一个粘贴开关；
`clipboardTextParser` 只在剪贴板**没有** `text/html` 时触发，且按行内解析。若以后版本
提供（例如 `preferPastedText` 或块级文本解析），删除 `composerPaste.ts` 里的接管逻辑、
改用该开关即可。

解析器缺失时 `handlePaste` 返回 `false`，退回 ProseMirror 的 HTML 解析——不会把
Markdown 源码当正文插进去。库升级若改掉这些 API，`composerPaste.test.ts` 会直接失败
（包括"行中粘贴标题必须还是标题"这条块级回归）。

## 回归

`src/components/composer/tiptap/composerPaste.test.ts` 覆盖：包壳标题 / 围栏代码、
无 HTML 的块级粘贴、语义 HTML 不接管、粘贴后标记状态、尾随换行、多行中间换行、
行中粘贴不拆段、代码块内保持字面量。
