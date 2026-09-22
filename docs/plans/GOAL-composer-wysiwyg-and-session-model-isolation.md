# GOAL — Composer Markdown WYSIWYG + 会话级模型隔离

状态：调研与决策完成（grill-with-docs 流程，四轮问答）。两项优化拆为两个独立 PR 串行交付。

## 背景

用户提出两点优化：

1. **输入框支持 Markdown + 编辑中插入文件/链接**：像 Codex / Claude 桌面版那样，在输入位置插入文件、链接并内联渲染。
2. **会话级模型配置**：当前切换模型会波及其他会话（实证：用户在会话 B 切模型，会话 A 立即中断并提示"已停止 — 模型或供应商路由已切换"）。

## 调研结论（代码事实）

- Composer 输入框为自研 contenteditable：`ComposerEditor.tsx`，含 `[[skill:name]]` token 存储、skill chip、ZWSP 光标垫片、IME 处理、slash 调色板、@ 面板。
- `MarkdownBody` 为纯渲染组件（react-markdown + remark-gfm/math + KaTeX），仅面向已发送消息，无法直接做编辑器。
- 模型配置的存储与解析已存在：`SessionMeta` 有每会话 `model_id`/`effort`，`Project` 记录有 `model_id`/`effort`，后端 `resolve_composer_prefs` 已实现 settings → project → session 三级解析，`ComposerPrefsScope` 已含 `"session"`，`connect.rs` 会用 `session/set_model` 对齐。
- 会话列表已显示每会话模型徽标与思考等级，无需改动；选择器 UI 已清晰展示 effort，无需改动。
- 中断 bug 的根因指向：多个 App 会话共享同一个 agent 子进程/连接，模型变更作用在共享进程上（spawn flags 或软重启），导致其他会话被杀。

## 已确认的产品决策

1. **架构方向：每会话独立 agent 进程**（如多个终端 tab 的隔离模型）。接受内存与启动延迟代价。
2. **运行中任务的切换语义：排队到本轮结束**——允许随时改选择器，新模型在当前任务完成后生效；不再立即中断任务。
3. **模型/effort 选择器 UI、会话列表徽标维持现状**，只修隔离与排队语义。
4. **Composer 编辑模式：内联 WYSIWYG**（TipTap/ProseMirror 类编辑内核）。
5. **插入交互：不使用扩展面板**。用户输入"在 @文件 中找到 xxx 逻辑"时，@token 内联渲染为突出的文件名 chip（如"在 ｜文件名｜ 中找到…"），样式复用聊天中的既有 chip 样式。支持本地文件路径与 URL 两类引用。
6. **数据边界：最终发给 Grok Build CLI 的是 Markdown 源码**；渲染效果仅存在于客户端 UI（输入中与发送后展示均为渲染态）。
7. **交付方式：两个独立 PR 串行**——先做模型隔离（正确性问题），再做 composer 重构（体验增强）。

## PR-1：会话级模型隔离 + 切换排队

目标：切模型只影响目标会话；运行中任务不被中断，切换延迟到本轮结束。

工作项：
1. 拆除共享 agent 进程路径：每个 App 会话持有独立 CLI 子进程与连接（评估 `GROK_HOME` 锁、启动延迟、进程生命周期与清理）。
2. 模型切换改为"提交待生效偏好"：会话运行中仅写入目标 `model_id`/`effort`，本轮 turn 结束后应用；空闲会话立即应用。
3. 移除或收敛"已停止 — 模型或供应商路由已切换"的广播路径，使其只描述真正被终止的会话。
4. 回归验证：双会话并发运行，会话 B 切模型，会话 A 必须持续运行且输出不中断。

## PR-2：Composer 内联 WYSIWYG

目标：输入框支持 Markdown 所见即所得编辑，@ 文件 / URL 引用内联渲染为 chip，最终发送 Markdown 源码。

工作项：
1. 引入 TipTap（ProseMirror）编辑内核，替换 `ComposerEditor.tsx` 的自研 contenteditable，迁移现有能力：IME、ZWSP/光标处理、slash 调色板、`[[skill:name]]` token（改为 ProseMirror node/mark）。
2. @ 引用内联渲染：输入 @ 触发现有的文件补全，选中后成为原子节点，显示为文件名 chip（本地路径）或链接 chip（URL），样式复用聊天消息中的 chip 样式。
3. Markdown 源码 ↔ 编辑文档的双向序列化：文档态为 ProseMirror 模型，提交给 CLI 时序列化为 Markdown 源码；历史消息编辑/继续会话时从源码反解析。
4. 发送后的消息渲染继续走 `MarkdownBody`，保证 chip/代码块等视觉一致。
5. 遵守项目约束：不新增 `App.tsx` / `AppWorkbench.tsx` 状态（落地在 `src/components/` / `src/hooks/`）；全 UI 字符串走 `src/i18n/`；无系统默认控件；新增依赖前评估体积与维护状态。

## 风险

- TipTap/ProseMirror 是较大的新依赖，与现有 token 存储、IME 逻辑存在迁移成本；需要保证 `[[skill]]` 消息向后兼容（旧会话继续可渲染、可继续）。
- 每会话独立进程增加内存占用与冷启动延迟；空闲进程需有回收策略。
- CLI 对每会话多进程的行为（锁、agent home、配额）需要实测确认。
