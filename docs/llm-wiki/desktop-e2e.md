# 桌面端 E2E：agent-desktop

Agent 通过 macOS 辅助功能树（AX）观察并操作运行中的 Grok App，补齐 Tauri 桌面端的端到端验证。纯逻辑由 Vitest 覆盖，本流程验证真实窗口、菜单、弹窗和持久化结果。

## 安装与自检

```bash
npm install -g agent-desktop
agent-desktop version     # 确认命令可用
agent-desktop status      # 平台、权限、supported_surfaces
```

`postinstall` 被包管理器拦截时，命令仍可运行，但每次调用会先启动 Node。放行并重装：

```bash
npm install -g --allow-scripts=agent-desktop agent-desktop
```

## 权限（macOS）

权限授予**启动 agent-desktop 的宿主 App**（Grok Build、终端或 IDE），与 shell 无关。

1. `agent-desktop permissions` — 只读，不弹窗。
2. 任一权限为 `denied` 时运行 `agent-desktop permissions --guide`，按面板提示把宿主 App 加入 **系统设置 → 隐私与安全性 → 辅助功能** 并打开开关。
3. `screenshot` 和 `session start --screenshots` 还需要 **屏幕录制** 权限；不看截图时可以不授。
4. 再次运行 `agent-desktop permissions` 确认 `granted`，宿主 App 无需重启。

## 首次使用先加载技能

```bash
agent-desktop skills get desktop    # snapshot/ref 循环、验证与重试规则
agent-desktop skills get platform   # 本机 macOS 差异
```

技能编译在二进制内，始终与安装版本一致。不要复制成静态文件，升级后会过期。

## 日常循环

先启动 dev 应用（不要裸跑 `tauri dev`，会撞正式版单实例锁）：

```bash
pnpm dev    # tauri dev --config src-tauri/tauri.dev.conf.json，窗口标题为 Grok Dev
```

```bash
agent-desktop list-apps                                              # 确认 "Grok Dev" 在运行
agent-desktop snapshot --app "Grok Dev" --skeleton -i --compact      # 1. 浅层地图
agent-desktop snapshot --root <ref> -i --compact                     # 2. 钻取一个区域
agent-desktop click <ref>                                            # 3. 操作
agent-desktop wait --element <ref> --predicate value --value <期望值>  # 4. 验证
```

- 正式构建的应用名是 `Grok`，dev 构建是 `Grok Dev`；`--app` 也接受 bundle id（`com.grokapp.desktop.dev`）。
- ref 形如 `@<snapshot_id>:e12`，只在生成它的那次 snapshot 内有效。UI 变化后重新 snapshot 或重新钻取。
- 动作成功不代表界面已变化，必须用 `get`、`is`、`wait` 或新的 snapshot 复核。
- 默认无头（headless）：走语义化 AX 调用，不抢焦点、不移动光标。`double-click`、`triple-click`、`hover`、`drag` 以及物理指针操作需要 `--headed`；仅在用户明确同意物理输入时使用，且不要用 `--headed` 兜底无头失败。
- 菜单、sheet、alert、popover 打开时，先 `snapshot --surface menu|sheet|alert` 再取 ref；背后的窗口树是错误目标。

## 选择验证路径

- 应用内可见行为（按钮、菜单、弹窗、设置页、会话流程）：用 agent-desktop 跑真实窗口。
- 纯函数、状态机、i18n 目录：用 `pnpm test`。
- 网页内容（浏览器内）：用 agent-browser；agent-desktop 只负责桌面 App。

## 常见错误

| 错误 | 处理 |
|------|------|
| `PERM_DENIED` / 权限 `denied` | 按上面的权限步骤授权宿主的辅助功能（截图另需屏幕录制） |
| `WINDOW_NOT_FOUND` | 应用未开窗；`agent-desktop launch --activate "Grok Dev"` 后 `list-windows` |
| `STALE_REF` | 元素已消失；重新 snapshot 取新 ref |
| `SNAPSHOT_NOT_FOUND` | snapshot 已过期；重新 snapshot |
| `APP_UNRESPONSIVE` + `retry: unsafe` | 不要重试，改用 `snapshot --surface menu` 观察当前状态 |

命令全集与参数：`agent-desktop <command> --help`、`agent-desktop skills get desktop <reference>`。
