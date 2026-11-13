# Grok Build 对齐：模型 / 推理 / 权限 / 模式

源码：`src/lib/grokCatalog.ts`（静态兜底）、`src-tauri/src/models_catalog.rs`、`src-tauri/src/agent_prefs.rs`。

## 模型

**UI 只展示官方真正可用的模型。服务商是 Composer 模型菜单里的按会话选择，不存在全局启用路由。**

| 来源 | 说明 |
|------|------|
| `models_cache.json` | CLI 官方目录 |
| 静态兜底 | `grok-4.7`（默认）+ `grok-4.7-build-fast` + `grok-4.6` + `grok-4.5` |

探测：`scripts/probe-models.sh`。Host：`models_list_available`。

## 上下文窗口

CLI `models_cache.json` 的 `info.context_window` 是目录默认值（Grok 4.7 / Fast / 4.6 / 4.5 当前为 **256000**）。可选长度在 `info.context_windows`（当前 `[256000, 500000]`）。静态兜底与此相同。`initialize` 的 live 覆盖只改默认值，不抹掉列表。

列表多于一项时，Composer 高级菜单列出这些长度。选中后对**当前 live 会话**发 `session/set_model`，只带 `_meta.contextWindow`（正整数 token 数），不带 `reasoningEffort`，CLI 因此保持当前推理档。不改已保存的模型偏好。

`/context-window` 与 Grok Build pager 相同：接受 `256k` / `1m`（大小写不敏感）或原始 token 数；空参数给出用法和当前值；不在列表里则报未知。新对话还没有 `session/new` 时，选择会记在 composer 上并在第一次建会话的 `session/set_model` 里带上 `_meta.contextWindow`，菜单立刻显示新长度。只有一个或没有可选窗口时命令说明该模型不能选。缩到比当前用量更小的窗口时，自动压缩由 CLI 自己做。

自定义提供商的上下文窗口在提供商设置 → 模型齿轮里按模型编辑（写入 `app_models` 与通道配置，不走这条 ACP）。API 未提供时使用 **1M** 默认；用户显式值优先于 `/models` 元数据。

`/context` 读取 live 会话的 `x.ai/session/info`（先 `_x.ai/session/info`）。用量菜单按 pager 拆成系统提示、消息、推理/开销、空闲，工具定义、技能、工作流、MCP 标成已经算进上面的行。自动压缩阈值和剩余 token 用快照里的 `autoCompactThresholdPercent`。没有活动会话时命令报错，不把这行发给模型。会话信息拿不到时，菜单仍用原来的角色估算。

Spawn 顺序（CLI 0.2.x）：

```text
grok --permission-mode <mode> agent --model <id> --reasoning-effort <e> [--always-approve] stdio
```

Flags **必须在** `stdio` 之前。连接后 `session/set_model` 再对齐一次。

## 推理强度（effort）

Composer 按**当前会话解析出的 provider / model** 读取该模型自己的推理档位，直接展示模型提供的原始 id 与顺序；不同模型不再折叠映射到统一四级滑杆。

解析顺序（真实可选值）：

1. **当前会话的官方模型** → CLI `models_cache.json` 的 `info.reasoning_efforts: [{id,value,label,description,default}]`（Host 经 `AvailableModel.reasoningEfforts` 下发，`isDefault` 标记默认档）。
2. **当前会话的自定义 provider 模型行** → `models[].efforts`（`app_models`）。模型行没有档位时回退该提供商的通道 `efforts`（`app_efforts`）。
3. 仍无档位时：自定义模型使用 `low` · `medium` · `high` · `xhigh`（默认 `medium`）；官方静态兜底见 `src/lib/grokCatalog.ts`。

选择与恢复：

- 有 `isDefault` → 用它；否则 `medium` 存在时用 `medium`；否则第一个。见 `src/lib/sessionEffort.ts` 的 `pickSessionEffort` / `src/lib/grokCatalog.ts` 的 `pickDefaultEffort`。
- 切换模型 / provider / 会话时，新模型仍提供同一原始 id 就保留；否则落到新模型的默认档。仅在**该模型支持推理**时把这个默认档写回会话，避免下一条消息沿用失效 id；不支持推理的模型保留原来的 stored id，但不展示、不写回、也不作为该模型的 effort 下发。**不做**跨模型阶梯映射（不再把 DeepSeek `high` 映射成官方 `medium` 之类）。
- 原始 id 直接透传：session effort resolution **不**复用任何 preset 对齐（`max` 保持 `max`，vendor 的 `minimal` / `balanced` / `ultra` 也原样保留）。
- 模型行 `supportsReasoningEffort = false` → Composer 不展示该模型的档位，并显示本地化的不可用说明；不借用通道或其它模型行。Host 按该会话的 provider + model 解析有效 effort，并在 spawn 时省略 `--reasoning-effort`；进程复用、parked/unpark 和 `session/load` 的 state 同样按有效 effort 对齐。切回支持推理的模型时，之前保留的 stored id 会重新成为候选。
- `none` 表示关闭思考：只有该模型自己的 catalog 明确列出 `none`（官方 live cache，或自定义模型/通道档位）且模型支持推理时才展示、保存和下发。`supportsReasoningEffort = true` 不能推断所有模型都可关闭；`none` 也不会伪装成最低档。官方资料没有把 `none` 列为 ACP 默认可用值，因此未广告时不出现。
- 展示标签：已知 id（`low` / `medium` / `high` / `xhigh` / `max` / `none`）走 i18n（`effort.*`）；其它 id 用 catalog 的 name/label，再回退原始 id。

Spawn / 应用：`--reasoning-effort <raw id>`。Host 透传 catalog / 模型 id（含 `max`、`none` 与自定义 id），不硬白名单仅 low/medium/high；模型不支持推理时完全省略该 flag，`none` 仍是真实参数值而不是 Rust `None`。当前 Host 没有 `session/set_effort` RPC；若以后接入 ACP `session/set_config_option`（`configId=reasoning_effort`），必须使用同一原始 id。Composer 菜单与手机工具面板共用同一档位列表；自动默认 reconciliation 与用户选档走同一个按会话串行的写入队列，慢保存不会覆盖后到的用户选择。

**Live 语义**：更改档位后，live agent 在**回合结束后** soft-respawn，正在运行的回合不会被中断；空闲会话写 prefs，下一条消息 / 下次连接生效。保存或 API 失败时 Composer 选中态保持不变，并按 `classifyModelEffortError` 分类显示本地化提示。

**产品默认（4.7）：** 官方冷启动与未设 prefs 时 model = **grok-4.7**、effort = **xhigh**。`grok-4.7-build-fast`（Grok 4.7 Fast）在官方菜单里可选，价格约为标准 4.7 的两倍，不进中转预设。CLI cache 可能同时把 `xhigh` 和 `high` 标成 default，Host/前端归一为 **xhigh**。用户可在 Composer 降为 high/medium/low 以缩短 TTFT。旧安装若全局 model 仍为历史产品默认 `grok-4.5`，先一次性抬到 `grok-4.6`；若 CLI `models_cache` 已列出 `grok-4.7`，再把空值或 `grok-4.6` 抬到 `grok-4.7`（显式 `grok-4.5`、Fast、自定义 id 不动；缓存还没有 4.7 时不抬，下次启动再试）。官方路由上旧 effort `high` 一次性抬到 `xhigh`（显式 low/medium/max 不动）。**存量会话 / 项目行**在 `official_effort_xhigh_rows_migrated` 下把 `effort: high` 且 model 为空或 `grok-4.6` 的行抬到 `xhigh`；`grok-4.5` 与自定义 id 不动。切到无 xhigh 的 catalog 时 resolve 层钳到该模型最高档。旧 effort `medium` 仍一次性抬到 high（3 档兜底）。

**Apply honesty（UI）**：纯 helper `src/lib/modelEffortApply.ts`。Composer 改模型 / 推理后 toast + 菜单 footer 说明生效路径：

| 控制 | 无 live Agent | Live Agent |
|------|---------------|------------|
| 模型 | `next_message`（下条消息 spawn） | `session/set_model` → `immediate_rpc`；不支持则 `soft_respawn` |
| 推理 | `next_message` | `soft_respawn`（回合结束后；无 set_effort） |

不得静默失败：prefs / set_model 错误经 `classifyModelEffortError` 分类 toast。

### 连接加速（Host）

| 手段 | 说明 |
|------|------|
| （非默认压 effort） | CLI 1.0 默认 **high**；要更快请用户在 Composer 选 medium/low，不要用产品默认偷偷降档 |
| `grok --no-auto-update agent … stdio` | 跳过启动时更新检查 |
| 进程复用 | 同 cwd + effort + YOLO 标志时，切会话只 `session/load\|new`，不 respawn CLI |
| 打开会话预热 | `openSession` 后台 `session_connect`，首发跳过冷启动 |

## 会话模式（mode）— 产品态

| App | 作用 |
|-----|------|
| `agent` | 默认编码 agent |
| `plan` | 计划模式（ACP `session/set_mode`） |
| `ask` | 询问 / 偏只读协作 |

实现：

1. 连接成功后 `session/set_mode`（尝试 `plan` / `ask` / `agent` 等候选 modeId）。  
2. 中途切换：优先 `set_mode`；失败则 soft-respawn。  
3. 按 `composerPrefsScope` 记忆。

## 后台等待（headless，CLI 0.2.117+）

首轮 agent turn 结束后，无头 `grok -p` 默认可等待后台 bash/monitor 与后台子代理完成。

| App 设置 | Spawn | 说明 |
|----------|-------|------|
| `backgroundWaitPolicy: "wait"`（默认） | 省略 flag | CLI 默认等待（自带超时） |
| `backgroundWaitPolicy: "no_wait"` | top-level `--no-wait-for-background` | 首轮结束即退出 |
| `backgroundWaitPolicy: "timeout"` + `backgroundWaitTimeoutSec` | top-level `--background-wait-timeout N` | N 钳制 **1–3600**（默认 600） |

- 纯 helper：`src/lib/backgroundWaitPolicy.ts`；Host：`acp_client::background_wait_spawn_flags*`。
- **Soft-fail**：CLI &lt; 0.2.117 或版本不可解析时省略非默认 flag（避免 clap 拒识导致 AGENT_CRASHED）。
- 生效路径：Remote IM headless、壁纸搜索 headless、ACP `agent stdio` 顶层（效果仍以 headless 语义为主；stdio 下 flag 可接受但主要无操作）。
- 更改后 soft-respawn（`settings_spawn`）。设置：Settings → General → Agent。
## 部分流式事件（headless，CLI 0.2.117+）

`--include-partial-messages` 仅在 `--output-format streaming-messages-json` 时生效，输出增量 `stream_event`（text/thinking delta）。

| App 设置 | Spawn | 说明 |
|----------|-------|------|
| `includePartialMessages: false`（默认） | 省略 flag；Remote IM 用 `streaming-json` | CLI 默认整消息 |
| `includePartialMessages: true` | `--output-format streaming-messages-json` + `--include-partial-messages` | 仅 CLI ≥ 0.2.117；更旧 soft-fail（保持 streaming-json、省略 flag） |

- 纯 helper：`src/lib/partialStream.ts`；Host：`acp_client::include_partial_messages_spawn_flags*` / `resolve_headless_stream_for_partial`。
- **Apply-path honesty**：`src/lib/partialStreamHonesty.ts` — `resolvePartialStreamApplyEffect` → `active` | `soft_omit` | `idle_off` | `host_only`；Settings 开关下按 CLI 版本显示 soft-omit / active 提示（应用内 ACP 聊天不发明 token 流）。
- **Soft-fail**：CLI &lt; 0.2.117 或版本不可解析时省略 flag，不切换 format。
- 生效路径：Remote IM headless（`grok -p`）；壁纸等仍用 `json` 时不会发 flag（纯 helper 按 format 门控）。
- 设置：Settings → Runtime → Pool。

## 内置工具 allowlist / denylist

| App 设置 | Spawn | 说明 |
|----------|-------|------|
| `disableWebSearch` | top-level `--disable-web-search` | 移除 `web_search` / `web_fetch` |
| `allowedTools: string[]` | top-level `--tools a,b` | 逗号分隔 tool id **allowlist**；空 = 省略（CLI 默认全部） |
| `disallowedTools: string[]` | top-level `--disallowed-tools a,b` | 逗号分隔 tool id **denylist** |

**并存规则：**

- 两者皆空 + 未关网页搜索 → CLI 默认（全部工具）。
- `allowedTools` 非空 → 仅允许列出的工具；`disallowedTools` 若也非空仍会从该集合中移除。
- 网页开关不写入 `disallowedTools` 数组，但 UI 把 web 工具视为已覆盖；纯 helper `effectiveDisallowedTools` 可合并展示。

常见芯片：`web_search` · `web_fetch` · `run_terminal_command`（caution）· `search_replace` · `write` · `Agent` · `spawn_subagent`；另支持 freeform 逗号列表。

更改后 soft-respawn（`settings_spawn`）。源码：`src/lib/allowedTools.ts`、`src/lib/disallowedTools.ts`、Host `AppSettings.allowed_tools` / `disallowed_tools`、`acp_client::allowed_tools_spawn_flags` / `disallowed_tools_spawn_flags`。

## 权限（含 YOLO）与 CLI `--permission-mode`

CLI enum（`grok --help`）：`default | acceptEdits | auto | dontAsk | bypassPermissions | plan`。

纯映射：`src/lib/permissionModeMap.ts`（前端）与 `src-tauri/src/acp_client.rs`（`cli_permission_mode` / `resolve_cli_permission_mode`）。

| App ID | CLI `--permission-mode` | Agent 配置 `[ui] permission_mode` | Claude `defaultMode` | 额外 Spawn |
|--------|-------------------------|-----------------------------------|----------------------|------------|
| `ask` | `default` | `default` | `default` | `--permission-mode default` |
| `accept_edits` | `acceptEdits` | `acceptEdits` | `acceptEdits` | `--permission-mode acceptEdits` |
| `allow_for_session` | `default`（Host 会话缓存；「会话内允许」按**工具族**记住，不是单条命令） | `default` | `default` | `--permission-mode default` |
| `auto` | `auto` | `auto` | `auto` | `--permission-mode auto` |
| `dont_ask` | `dontAsk` | `dontAsk` | `dontAsk` | `--permission-mode dontAsk` |
| `always_approve` | `bypassPermissions` | `always-approve` + `yolo=true` | `bypassPermissions` | `--permission-mode bypassPermissions` + `--always-approve` |
| （产品 mode=`plan`） | `plan`（YOLO 优先） | 不变 | 不变 | `--permission-mode plan` |

**优先级**：YOLO / `always_approve` → `bypassPermissions`；否则产品会话 mode=`plan` → `plan`；否则策略表。

### Workflow 实时日志 + Goal 会话指示（1.0 GUI）

| 面 | 行为 |
|----|------|
| Workflows Settings smoke/run | Host 边跑边 emit `workflows://run-progress` → **live** log + 已用时；若仅有最终 blob → 诚实标 **batch log**（不假 live）；空日志 / CLI 缺失 / shared 不改写 `~/.grok` 有 soft-fail 说明；可复制日志 |
| Goal 会话 chip | 有 `goal_updated` 时显示阶段/进度/摘要；Composer `/goal` 已开但无事件 → **waiting** 虚线 chip（不发明进度） |

### CLI 版本芯片与 binary skew（1.0）


| 项 | 说明 |
|----|------|
| 硬门槛 | `≥ 0.2.112`（`versionSupported`）；更旧 → setup/Doctor fail |
| 推荐线 | **`≥ 1.0.0`**（`meetsRecommended`）；更旧仍可用，Runtime · CLI 软提示升级 |
| 探测 | Host `probe_cli` → `CliProbeResult`（含 `recommendedVersion` / `agentBinarySkew`） |
| `agent` sidecar | App **只 spawn `grok`**；若 `~/.grok/bin/agent` 版本与 grok 不一致 → Doctor warn + Settings「将 agent 对齐到 grok」（`cli_repair_agent_sidecar`） |

Spawn（CLI **1.0** / 兼容 0.2.112+）示例：

```text
grok --no-auto-update --permission-mode <mode> agent [--model <id>] [--reasoning-effort <e>] [--always-approve] … stdio
```

`--permission-mode` 为 **top-level**；`--always-approve` 为 **agent** option。

**Shared 模式**（默认）：使用 `~/.grok` 作为 `GROK_HOME`，与终端 Grok Build 同一会话/配置树；App **不**改写用户 `~/.grok/config.toml`；Host 策略 + spawn flags（含 `--permission-mode` / YOLO 时的 `--always-approve`）。

**Independent 模式**：写入 `~/.grok-app/agent-home/config.toml` 与 `agent-home/.claude/settings.json`，agent 进程侧真正按策略执行；与 CLI `~/.grok` 隔离。

中途改权限：同步配置 + soft-respawn（含 YOLO 降级）。**回合进行中**不会立刻杀进程（CLI 仍带 spawn 时的 `--always-approve`）；Host 记下待 respawn，本轮结束后或下次 connect 时再重生。Host 在收到 `session/request_permission` 时仍按 live policy 自动放行/拒绝。

**会话内允许（permission bar）**：按钮始终展示。write / image 的 CLI 档是 `allow-always`（不是反序的 `always-allow`）；空列表时 Host 按工具族回退。若列表里**没有** session 档，wire 用已发布的 `allow-once`（Host 仍缓存 scope）。发送列表里没有的 id 会被 CLI 当成 `unknown permission option` 并取消回合。策略为 `allow_for_session` 或 `auto` 时，点「会话内允许」会缓存 `tool:*`（同工具其它命令不再弹）；`ask` 仍按单条 scope。Shell 的 Execute 标题里的 Windows `\` 路径**不是** outside-project 判定（#1241）。

注意：读工具与部分只读 shell 在 agent 内建白名单下仍可能不弹窗（Grok Build 设计）。

**下载默认放行（Host）**：`curl -o/-O`、`wget`、`aria2c` 等把资源写到**项目目录内**的 shell，Host 在非 `dont_ask`/`deny` 策略下自动批准，避免生图后 `curl` 落盘卡在权限弹窗直至 600s 超时。项目外路径仍须审批（仅 `always_approve` 例外）。

## 偏好记忆范围

`composerPrefsScope` = `global` | `project` | `session`。

覆盖 model / effort / mode / permission。切换 chip → `composer_prefs_set` / `session_set_policy` / `session_set_model`。

## 服务商

自定义提供商 = 渠道路由。Composer **模型菜单**会聚合：

1. **官方**分组：catalog 模型（`availableModels`）
2. **每个已配置提供商**一组：列出该提供商 catalog 中的全部请求模型（`models[]`，每项含 **展示名称** + model id），**不**在菜单里拉远程 `/v1/models`

选择一条模型只写入这条对话（`composer_prefs_set` 的 `provider_id` / `modelId`）。没有全局激活路由，也不改 `[models].default`；其他会话的 provider / 进程不受影响。没有适用偏好的会话使用官方路由。

芯片文案：官方用 catalog label；自定义路由用 **当前选中模型的展示名称**（`models[].name`，空则回退 model id）。

Settings 提供商表单：去掉「设为默认」；支持添加多个模型（手动输入 id + 展示名称，或从「拉取模型」列表点选）。
