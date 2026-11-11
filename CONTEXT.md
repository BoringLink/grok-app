# Grok App

Grok Build CLI 的桌面客户端外壳。这里只记录产品与领域语言，不记录实现细节。

## 领域语言

**MCP 服务器（MCP Server）**：
通过 Model Context Protocol 向 agent 提供工具、资源或提示词的服务，在设置 → 扩展 → MCP 中列出并启停。
_Avoid_：MCP 插件、MCP 工具

**MCP Target**：
MCP 服务器的连接目标。远程服务器是 URL（可能带路径和查询参数），本地服务器是启动命令。
_Avoid_：MCP 地址、MCP 端点

**厂商标识（Vendor Icon）**：
设置 → 扩展中代表 MCP 服务器所属厂商的方形图标，来源是该厂商自己的站点。
_Avoid_：favicon、logo、头像

**注册域（Registrable Domain）**：
从 MCP Target 的主机名剥到可注册的域名（例如 `mcp.context7.com` → `context7.com`），用于定位厂商站点。
_Avoid_：主域名、根域名

**字母徽标（Monogram）**：
拿不到厂商标识时，用服务器名首字母加固定配色生成的替身图标。
_Avoid_：占位图、默认图标

## 输入框（Composer）

用户写消息的编辑区。两套实现并存（ADR 0004），由 `AppSettings.composerEditor` 选择：

- **内置档（legacy）** — 上游的 contenteditable：纯文本 + `<br>` + 不可编辑的 skill / plugin
  chip。默认档。
- **Markdown 档（TipTap / WYSIWYG）** — ProseMirror 文档模型，显示解析后的结构，存储态与发送
  内容始终是 Markdown 源码。

## Markdown 档的文档形态

- **硬换行（hardBreak）** — 段内换行，Shift+Enter 产生；序列化为 `\\\n`。发送前
  `normalizeSerializedMarkdown()` 会给它后面的行补行首转义。
- **草稿（draft）** — 输入框落盘 / 回读的 Markdown 源码；再解析回编辑器与用户气泡都依赖它。
- **用户气泡（user bubble）** — 聊天里用户消息，按 Markdown 渲染，转义字段还原为字面量。

## 粘贴

- **粘贴判定（paste plan）** — `block` / `inline` / `none` 三档，决定 `text/plain` 按块级
  Markdown、只按行内记号、还是交给 ProseMirror 的 HTML 解析。规则见
  `docs/llm-wiki/composer-markdown.md`。
- **纯文本粘贴（literal paste）** — 把剪贴板文本按字面量放进文档：不解析 Markdown 记号，不
  继承光标处的标记；多行按硬换行落位。与"普通粘贴"是两种手势，不是两种判定。
- **源码包壳（source wrapper）** — 浏览器把 Markdown 源码包进 `code` / `pre` 时形成的
  `text/html`；判定为 Markdown 源码的依据之一。
- **超大粘贴（huge paste）** — Windows 上超过阈值的长文本改挂 `.txt` 附件，避免编辑器卡死。

## 相关

- 引用 token（ref token）、skill token：见 ADR 0003 与 `docs/llm-wiki/composer-markdown.md`。
