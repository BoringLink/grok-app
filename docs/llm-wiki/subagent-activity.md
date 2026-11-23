# 子代理实时文本活动

## 行为

- Agent 任务面板的子代理行通过“查看子代理”按钮或双击进入右侧“子代理”栏目；两种入口选择同一子代理。既有行内单击展开完成结果的行为保持不变。
- 右侧栏目只列出当前 App 会话的子代理。首次选择优先运行中的任务，否则选择最新任务；用户选择按 App 会话保留在当前进程内，切换会话后切回会恢复。
- 活动流展示 child ACP session 收到的任务文本、思考文本和助手文本，使用 `MarkdownBody` 安全渲染。没有活动时显示本地化空态。
- 子代理工具调用的详情不在此文本活动视图展示；没有对应文本事件时不合成活动或兼容性提示。

## 路由与生命周期

父 ACP lifecycle 通知提供 `subagent_id` 与 `child_session_id`。Host 只在收到父会话的 lifecycle 通知后，登记以 ACP process 和 child session 为键的路由。child session 的 `user_message_chunk`、`agent_thought_chunk` 和 `agent_message_chunk` 经该路由映射到拥有它的 App 会话及子代理行。未知 child session 不会创建活动记录。该映射不依赖父 `session/prompt` 是否仍在等待，因此父 turn 完成后，child 更新仍可继续显示。

Host lifecycle 事件进入 app-level store；事件与选中状态按 App session / `subagent_id` 隔离，只存在当前进程的内存，不写入会话 transcript 或磁盘。

## 内存界限

活动保留最近内容；移除旧内容时，右侧栏目显示本地化截断标记。

| 界限 | 上限 |
|---|---:|
| 单条文本 | 16,000 Unicode code points 且 32 KiB UTF-8 |
| 单个 child 活动 | 200 条、128,000 code points、256 KiB UTF-8 |
| 单个 parent App 会话 | 100 个 child、512,000 code points、1 MiB UTF-8 |
| 当前进程 parent 会话 | 32 个 |
| 尚未消费的查看请求 | 32 个 |
| Host lifecycle-confirmed child routes | 1,024 条 |

超过任一活动预算时保留较新的活动，并把受影响 child 标记为已截断。超出会话数量上限时优先保留最近活跃会话。

## 维护与验证

- ACP 解码、Host process/session 路由：`src-tauri/src/acp_client.rs`、`src-tauri/src/session_manager/events.rs` 与相邻测试/fixtures。
- 内存缓冲、订阅及行内入口：`src/lib/subagentLiveStore.ts`、`src/hooks/useSubagentLive.ts`、`src/components/AgentTasksPanelSubagents.tsx`。
- 右侧活动视图：`src/components/side-workbench/SubagentActivityTab.tsx`。
- 新增可见文案必须同步所有 locale 的 `tasks.ts` / `sidebar.ts`。
