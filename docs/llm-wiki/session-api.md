# Local session API（列表 + 续跑 + 新建 + 状态）

#626 第一刀：给**同一台机器上的外部应用**列 Grok App 会话，再用 **App session id + 提示词**续跑**同一条**。

#1356 第二刀（核心）：在**已经存在且已信任**的项目里新建一条 App 会话并开第一轮，以及按 id 查询这一条的阶段。不是 Remote IM。不自动把文件夹加进项目，不绕过信任门。

## 范围（做了 / 不做）

| 做 | 不做 |
|----|------|
| 列出 App 会话（磁盘 `sessions_index`） | 打断正在进行的一轮 |
| `session id + prompt` 续跑同一条 | 无鉴权 / 监听非 loopback |
| `POST /v1/sessions` 在已信任项目里新建并开第一轮 | 项目不存在时自动 `add_project`，或绕过信任门 |
| `GET /v1/sessions/{id}` 返回阶段 + 末条助手预览 | 非空 `worktreePath`（直接 400，不建 worktree 会话） |
| `source` 写入会话记录（≤32 个 `[a-z0-9_-]`） | `source` 的侧栏 / Kanban badge 与过滤 |
| 回环 HTTP + 同路径 CLI（含 `--session-new`） | 应用退出后排队落盘再补发 |
| 发送需要 App 或托盘在跑 | 把会话 `mode` 当成 mock 传给 `connect` |
| 该会话正在跑一轮（绘画 / 工具 / 流式）→ **入跟进队列**，GUI 队列条同步 | 新造 token / cost 统计（Host 没有现成的会话级持久聚合，响应里不带） |

## 身份

- **session id** = Grok App session id（侧栏「复制会话 ID」）。默认**不是** CLI agent session id。见 [session-continuity.md](./session-continuity.md)。
- 列表字段：`id` · `title` · `projectId` · `projectName` · `updatedAt` · `archived` · `pinned`。

## HTTP（仅 127.0.0.1，token 门）

App 启动后 Host 绑定 `127.0.0.1:0`，把 `{url, token, pid}` 写到：

`{app_data}/session-api.json`（unix `0600`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/health` | 探活。JSON：`{ ok, connectLockBusy }`。`connectLockBusy: true` 表示会话通道卡住，App 仍在跑 |
| GET | `/v1/sessions?include_archived=` | 列表 |
| POST | `/v1/sessions` | 新建并开第一轮。body：`{ "projectPath" \| "projectId", "title"?, "prompt", "idempotencyKey"?, "source"? }`。成功：`{ sessionId, status: "turn_started", ok: true }`（与续跑同一 `TurnResult` 形状） |
| GET | `/v1/sessions/{id}` | 单条状态。见下表 |
| POST | `/v1/sessions/{id}/turns` | 续跑。body：`{ "prompt", "idempotencyKey"? }` |

鉴权：`Authorization: Bearer <token>` 或 `x-grok-token`。设置页**永不展示 token**，只给「打开令牌文件位置」。

续跑结果 `status`：

| status | HTTP | 含义 |
|--------|------|------|
| `turn_started` | 200 | 已 `connect` + `send_message`，同一条 App session |
| `queued` | 202 | 该会话正在跑一轮（绘画 / 工具 / 流式）。提示词**落盘**并由 Host 在本轮结束后 drain；主窗口若在则发 `session://send_queue` 给队列条展示。**不打断**当前轮 |
| `busy` | 409 | 保留：无法入队时的冲突（正常路径走 `queued`） |
| `not_found` | 404 | 没有这条 App session |
| `app_not_running` | 503 | **CLI 侧**：连不上 loopback（没有在跑的 Host）。HTTP 超时 / 5xx **不是**这个状态 |
| `retry_later` | 503 | Host 忙于 connect（15s 内没派出去）。请稍后重试；App 仍在跑 |
| `error` | 400 | 空 prompt / 项目未信任 / 连接失败等；CLI 把 HTTP 超时也映射成 `error` |

`idempotencyKey` 命中则回放上次结果（磁盘 cap 200，续跑与新建共用同一个文件）。新建的 key 在文件里带 `session-new:` 前缀，避免和某次续跑的 key 互相回放。校验失败（空 prompt、`source` 非法、项目找不到 / 未信任 / 路径缺失、带了 `worktreePath`）**不写入**幂等记录，修好后可以用同一个 key 再试。会话行一旦写进 `sessions_index`，结果就会记住（含第一轮 `retry_later` 或连接失败），同 key 再请求不会再开第二条。

新建走和侧栏第一条消息相同的 Host 函数：`store::create_session` + `bind_default_workspace_if_unbound`，然后 `prepare_send` + `dispatch_turn`（`connect` 的 `mock_mode` 仍是 `None`，不把会话 `mode` 当 mock）。`source` 写在会话索引行上。HTTP 列表不带它；`GET /v1/sessions/{id}` 带。界面本刀不展示。

`GET /v1/sessions/{id}` 成功体：

| 字段 | 含义 |
|------|------|
| `id` `title` `projectId` `projectName` `updatedAt` | 索引行 |
| `source` | 有则返回 |
| `status` | `running`（连接中 / 流式 / 工具仍开）· `needs_input`（权限、提问、计划门；优先于 running）· `error`（Host `last_error`，或空闲时最后一条助手是错误）· `idle`（含「幽灵 Streaming」：FSM 停在 Streaming 但没有 prompt / 工具 / 门） |
| `lastAssistantMessage` | 最后一条非 marker 助手正文，最多 2000 个字符，超出末尾加 `…` |

没有这条会话 → 404 `not_found`。

## CLI（不抢焦点）

必须在 `tauri::Builder` **之前**拦截，避免 `single-instance` 把主窗口拉到前台。

```text
grok-app --sessions
grok-app --sessions --include-archived
grok-app --session-send <session-id> --prompt "…"
grok-app --session-send <session-id> --prompt-file ./note.md
grok-app --session-send <session-id> --prompt "…" --idempotency-key k1
grok-app --session-new --project <path> --title "…" --prompt-file ./job.md
grok-app --session-new --project <path> --prompt-file ./job.md --idempotency-key k1 --source grok-bot
```

- `--sessions`：优先打回环；没有 App 则读磁盘索引。
- `--session-send` / `--session-new`：必须有正在跑的 App（或托盘）。**连不上端口** → `app_not_running`，exit 2。**HTTP 超时 / 5xx** → `error`（带原始信息），exit 1；不要把它当成 App 没开。正在跑一轮时回 `queued`（exit 0），不抢窗口、不打断。`--session-new` 只接受已信任项目的路径（`--project`）；HTTP 另外可以用 `projectId`。
- 二进制名随安装变化（macOS `.app` 内可执行文件 / Windows exe）。设置 → 运行时 → 连接 可把用户级命令装到 `~/.local/bin/grok-app`（指向当前正在跑的二进制）。

## Host 路径

`src-tauri/src/session_api.rs`

1. `prepare_send`：会话必须已在索引里；绑定项目须 `trusted` + `path_ok`；cwd 优先 `worktree_path`。
2. `dispatch_turn`：若 `session_turn_busy`（含绘画 / 工具 / `prompt_in_flight`）→ `enqueue_while_busy`（落盘 + 可选 GUI 事件），**不** `connect` 抢槽。空闲才 `connect` + `send_message`。HTTP 层 **15s** 超时回 `retry_later`。
3. 发送竞态仍 `still running` / `task_already_running` → 同样入队，不回硬 `busy`。
4. 主窗口 `useSendQueue(acceptExternal)` 把事件 merge 进现有跟进队列（`source: external`，**只展示**；Host drain 真正发送）。副窗口不听，避免双发。

## Settings

**运行时 → 连接** · `runtime.sessionApi` · 锚点 `settings-anchor-sessionApi`。

只读状态 + 令牌文件路径 + 打开位置。**安装终端命令**写到 `~/.local/bin/grok-app`（Unix symlink；Windows 为带标记的 `.cmd` shim），目标是 `current_exe`。不 sudo、不改 `~/.zshrc`。已有非本应用文件则拒绝覆盖。新终端仍需自行保证 `~/.local/bin` 在 `PATH`。

新条目必须进 `settingsCatalog`。

## 故障排查

### `app_not_running` 的真实含义

| 现象 | 含义 | 怎么处理 |
|------|------|----------|
| 没有 `session-api.json` / 连不上 127.0.0.1 端口 | App 确实没在跑（或托盘已退出） | 启动 App 或留在托盘 |
| CLI 报 `app_not_running` 但探活其实 200 | **旧 CLI 把任何 HTTP 错误（含超时）都映射成这个报文** | 升级 App；看 JSON `status` 字段，不要只看这句话 |
| `POST /turns` 超时 / `retry_later` | Host 正在 connect，或 `connect_lock` 被卡住的握手占住 | 等 ≤90s 或看 `/v1/health` 的 `connectLockBusy`；不要立刻连发重试（会堆僵尸 `grok.exe`） |
| `/v1/health` 的 `connectLockBusy: true` | App 活着，会话通道卡住 | 等 wall-clock abort 放锁；一直 busy 则重启 App |
| `/v1/health` 自己也超时 | 多半是调用方超时（CLI 默认 8s）或 runtime 被阻塞 IO 卡死 | 先确认 token；若 lockBusy 探活都 >1s，属于另一类 bug |

### Windows 代理

Grok App **启动时**读系统代理，子进程继承 App 环境。命令行派活的 CLI **自身**不读系统代理设置。若子进程连不上上游（握手 wedge）：

1. 把 `HTTPS_PROXY` / `HTTP_PROXY` 设成**用户级/系统级环境变量**
2. **彻底退出再启动** Grok App（托盘右键退出，不是关窗口）

### 派活建议

- 串行：上一轮 `turn_started` 且本轮结束后再发下一条
- 收到超时不要立刻重试轰炸

## 后续（本切片不做）

- `worktreePath`、侧栏 / Kanban 的 `source` badge 与过滤
- headless `grok` 导入、sub-agent 分组
- interrupt 模式
- 回执 / 完整 transcript 拉取
- token / cost 的新聚合
