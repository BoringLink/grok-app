# 子代理实时文本活动

## 行为

- Agent 任务面板的子代理行单击展开精简身份详情；child session ID 以纯文本显示，显示可用描述、模型和运行统计，不提供复制按钮，不重复显示行上已有的子代理类型，也不显示 `agentAddress`。详情以 grid 对齐字段，标签与值基线对齐；标签列最小宽度适配最长标签，值列占用剩余宽度；模型若为 `provider__model` 则只显示 `model`。最终输出只在右侧查看器展示。行内“查看子代理”按钮与双击进入右侧“子代理”栏目并选中同一子代理，按钮不触发行内展开。
- 右侧栏目只列出当前 App 会话的子代理。首次选择优先运行中的任务，否则选择最新任务；用户选择按 App 会话保留在当前进程内，切换会话后切回会恢复。
- 输出面板不重复显示任务行标题、状态或身份 metadata，也不显示主 Agent 派发给 child 的提示词；任务行展开区仍可显示 lifecycle 提供的简短 description。输出内容从 thought、assistant、tool 活动及可用 final output 开始。
- Output viewer 不展示 child ACP session 的 `user_message_chunk` 提示词，只展示思考文本、助手文本和工具调用/更新。思考与助手 chunk 优先按 `messageId` 合并；无 ID 时合并连续同类 chunk，metadata-only 更新不会成为边界，工具调用及后续更新都会切断无 ID 文本聚合。工具更新边界不重复显示。
- 助手消息复用主聊天的 `ChatItem` / `MarkdownChat`；thought/tool 序列经 `buildAssistantTimeline` 投影为主聊天 `TimelinePhaseBlock` 的“工作了”折叠阶段。进入新 thought 阶段时，先前 work phase 收纳到该折叠组，阶段内已完成的 tool step 默认折叠；与主聊天一致，相邻无正文 phase 合并，阶段完成后整体自动折叠。独立 thought/tool 使用主聊天 `Thinking` / `TimelineToolRow` 样式和交互。工具输入/输出由现有工具详情组件作为纯文本展示。工具活动保留 CLI 提供的标题、状态、输入和输出；稀疏更新按 tool call ID 合并，缺失、null 或空字段不覆盖已收到的值。Lifecycle 最终 output 仅在没有实时助手 chunk 时作为回退显示；不显示兼容性警告或伪造事件。
- 没有活动时显示本地化空态。

## 路由与生命周期

父 ACP lifecycle 通知提供 `subagent_id` 与 `child_session_id`，以及可能存在的 `subagent_type`、`description`、`model`、`agentAddress` 和状态/统计字段；缺失值保持缺失，不推断 `agent.name`。Host 只在收到父会话的 lifecycle 通知后，登记以 ACP process 和 child session 为键的路由。thought、assistant 和 tool 更新经该路由映射到所属 App 会话并写入进程内活动 store。Child `user_message_chunk` 由 Host 消费以避免进入父 transcript，但不转发或保存在子代理活动 store。未知 child session 不会创建活动记录。该映射不依赖父 `session/prompt` 是否仍在等待，因此父 turn 完成后，child 更新仍可继续显示。

Host lifecycle 事件进入 app-level store；事件与选中状态按 App session / `subagent_id` 隔离，只存在当前进程的内存，不写入会话 transcript 或磁盘。

## 内存界限

活动保留最近内容；移除旧内容时，右侧栏目显示本地化截断标记。

Host 在转发 child tool 活动前，最多遍历 6 层、16 个 JSON 项，并限制最终展示的 input/output 序列化文本合计为 512 UTF-8 字节；tool title/status/toolCallId 各最多 256 UTF-8 字节，JSON 键最多 24 UTF-8 字节。字段、键及结构超限会添加截断标记。前端每个活动统一限制 text、title、status、input、output 合计为 16,000 Unicode code points 且 32 KiB UTF-8；活动更新合并后再次执行同一限制。session、child、message 和 tool-call ID 最多 512 Unicode code points，并计入 parent 会话文本/字节预算。

| 界限 | 上限 |
|---|---:|
| 单条活动（text、tool title/status/input/output 合计）/聚合消息 | 16,000 Unicode code points 且 32 KiB UTF-8 |
| 单个 child 活动 | 200 条、128,000 code points、256 KiB UTF-8 |
| 单个 parent App 会话 | 100 个 child、512,000 code points、1 MiB UTF-8（包含 ID）|
| 当前进程 parent 会话 | 32 个 |
| 尚未消费的查看请求 | 32 个 |
| Host lifecycle-confirmed child routes | 1,024 条 |

超过任一活动预算时保留较新的活动，并把受影响 child 标记为已截断。超出会话数量上限时优先保留最近活跃会话。

## 维护与验证

- ACP 解码、Host process/session 路由：`src-tauri/src/acp_client.rs`、`src-tauri/src/session_manager/events.rs` 与相邻测试/fixtures。
- 内存缓冲、订阅及行内入口：`src/lib/subagentLiveStore.ts`、`src/hooks/useSubagentLive.ts`、`src/components/AgentTasksPanelSubagents.tsx`。
- 右侧活动视图：`src/components/side-workbench/SubagentActivityTab.tsx`。
- 新增可见文案必须同步所有 locale 的 `tasks.ts` / `sidebar.ts`。
