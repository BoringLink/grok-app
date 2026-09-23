# BOR-55 — SubAgent 监视设计与实测结论

状态：实测完成，契约冻结，进入实现。

## 实测（2026-09-23，真实 CLI 抓帧）

用 `grok agent --always-approve stdio` 跑一次双子代理任务，抓取原始 ACP 帧
（探针：`acp_subagent_probe.py`，样帧：`docs/plans/` 同级说明见下）。

### 结论：CLI **有**完整的子代理遥测，客户端当前全部丢弃

CLI 在扩展通知通道 `_x.ai/session_notification` 上发出三类 update：

```jsonc
// 1. 派发
{"sessionUpdate":"subagent_spawned",
 "subagent_id":"01a0cc3b-…","attempt_id":"at1.…",
 "parent_session_id":"01a0cc3b-…","parent_prompt_id":"57190991-…",
 "child_session_id":"01a0cc3b-…","subagent_type":"general-purpose",
 "description":"统计当前目录文件数量",
 "effective_context_source":"new","model":"claude-sonnet-5",
 "agentAddress":"aa1.…"}

// 2. 进度（周期性）
{"sessionUpdate":"subagent_progress",
 "subagent_id":"…","attempt_id":"…","parent_session_id":"…","child_session_id":"…",
 "duration_ms":7016,"turn_count":1,"tool_call_count":1,
 "tokens_used":24863,"context_window_tokens":1000000,"context_usage_pct":2,
 "tools_used":["run_terminal_command"],"error_count":0}

// 3. 结束
{"sessionUpdate":"subagent_finished",
 "subagent_id":"…","attempt_id":"…","child_session_id":"…",
 "status":"completed","tool_calls":1,"turns":1,"duration_ms":9336,
 "tokens_used":25178,"output":"当前目录下共有 3 个文件。","will_wake":false}
```

链路事实：

- `_x.ai/session_notification` 已经进了 `handle_session_update` → `decode_session_update`
  （`acp_client.rs:1471`），但这三个 `sessionUpdate` 值落进 `match` 的兜底分支被丢弃。
- 派发工具 `spawn_subagent` 的 `tool_call._meta` 只有 `{x.ai/tool:{kind:"task"}, subagentBackground:true}`，
  **不含** subagent id；`tool_call_update` 的结果文本里才出现
  `subagent_id: <id>`（配合 `get_command_or_subagent_output` 的 `task_ids`）。
- 因此父级链接**不靠推断**：`subagent_spawned.subagent_id` 是权威 id，
  `parent_session_id` 是主会话 id，`description` 与派发工具 `rawInput.description` 对齐。

## 契约（冻结）

后端新增 `AcpEvent::Subagent(SubagentUpdate)`，并广播 Tauri 事件 `session://subagent`：

```jsonc
{
  "sessionId": "<App 会话 id>",   // 路由后填入，前端按会话分组
  "phase": "spawned" | "progress" | "finished",
  "subagentId": "01a0cc3b-…",
  "parentSessionId": "01a0cc3b-…",
  "childSessionId": "01a0cc3b-…",
  "parentPromptId": "…",
  "attemptId": "…",
  "subagentType": "general-purpose",
  "description": "统计当前目录文件数量",
  "model": "claude-sonnet-5",
  "status": "completed",           // finished 时才有
  "durationMs": 7016,
  "turnCount": 1,
  "toolCallCount": 1,
  "tokensUsed": 24863,
  "contextWindowTokens": 1000000,
  "contextUsagePct": 2,
  "toolsUsed": ["run_terminal_command"],
  "errorCount": 0,
  "output": "…",                    // finished 时才有
  "willWake": false
}
```

缺失字段一律 `null` / `[]`，不臆造。

## 实现切片

1. **后端解析 + 广播**：`acp_client.rs` 解码三个 kind；`session_manager` 两条事件泵
   （live `events.rs` / background `events_bg.rs`）都广播 `session://subagent`。
   附 fixture 与 golden 断言。
2. **前端 store + 订阅**：`src/lib/session/subagents.ts` 按 `sessionId → subagentId` 归并，
   `useSessionHostEvents.ts` 订阅 `session://subagent`。
3. **UI**：`AgentTasksPanel` 增加「子代理」区，逐个子代理显示类型、描述、状态、
   turn/tool 计数、tokens、耗时；结束后展示 output。派发工具行与子代理行按
   `subagent_id` 关联（从 `spawn_subagent` 结果文本解析）。

## 不做

- 不新增独立「子代理会话」路由：子代理没有独立 ACP 连接，其内部工具帧（`run_terminal_command` 等）
  与主会话混在同一 `sessionId` 流里，无法可靠归属到具体子代理。
  当前只展示子代理自身的进度计数与最终 output，不虚构其工具明细。
- 不改动现有 `buildTaskTree` 的推断路径：它是既有 best-effort，本次只做「有权威数据时优先用权威数据」。
