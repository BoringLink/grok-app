# 菜单与窗口生命周期

覆盖 `pnpm dev` 起来之后的三件事：系统菜单结构、把主窗口关掉会隐藏到托盘而不是退出、以及隐藏后如何把窗口拿回来。这三件都只在真实窗口里成立，Vitest 证明不了。

## 为什么必须真窗口

- `src-tauri/src/app_menu.rs` 用自建菜单替换了系统默认的 ⌘W。默认 ⌘W 由操作系统直接关窗，自建版先发 `app://close-tab-or-window` 给前端（有侧边 tab 时先关 tab），前端再调 `window.close()`。菜单本身存在与否、绑定给谁，只有真实菜单栏能验证。
- `WindowEvent::CloseRequested` 上，`settings.closeToTray` 为 `true` 时走 `api.prevent_close()` + `tray::hide_to_tray()`：窗口消失、进程留在托盘、正在跑的 agent 会话不受影响。这是产品承诺，不是实现细节。
- 恢复窗口走 `tray::show_main_window()`，托盘 Open 与「第二次启动进程」共用这条路径（`tauri-plugin-single-instance` 回调）。

## 前置条件

```bash
pnpm dev                      # 首次编译几分钟；起来后会有一个 grok-app 窗口
agent-desktop status          # accessibility 必须 granted；本流程不需要屏幕录制
```

- **Stage Manager 要关**（`defaults read com.apple.WindowManager GloballyEnabled` 应为 `0`）。开着时失去焦点的窗口会被挪进侧边条并缩成小窗，`list-windows` 会给出负坐标的几十像素 bounds，断言全部失真，`focus-window` 还可能 TIMEOUT。
- **`closeToTray` 必须为 `true`**（默认值）。注意 dev 与正式版共用数据目录 `~/Library/Application Support/com.grokapp.grok-app/`，`settings.json`、语言、皮肤预设都是同一份——为了跑流程改设置会改到用户正式版。
- 菜单文本跟随系统语言：本文同时给出中文（`关闭`）与英文（`Close`）标签；About 项标签是系统标签加上可执行名。
- 不要在正在生成回复的会话上执行第 3 步（关闭会先关侧边 tab）。

## 标识符（本机实测，2026-11-19，agent-desktop 1.3.1）

| 目标 | 值 |
|---|---|
| `--app` 选择器 | `grok-app` |
| `list-windows` 的 title | `grok-app` |
| `snapshot` 里的 window 名称 | `Grok` |
| About 面板标题 | `Grok Dev` |
| About 菜单项标签 | `About grok-app` |
| 版本 | `package.json` 的 `version`（本次 `0.2.55`） |
| bundle id | dev `com.grokapp.desktop.dev`，正式版 `com.grokapp.desktop` |

**不要用 `--app "Grok Dev"`**：`productName` 是 `Grok Dev`，但 dev 跑的是未打包的 `target/debug/grok-app`，辅助功能里的进程名是 `grok-app`，按 `Grok Dev` 查询返回 `APP_NOT_FOUND`。

## 步骤

### 1. 基线：一个窗口

```bash
agent-desktop list-windows --app "grok-app"
```

期望：恰好一个窗口，`title: "grok-app"`，`visible: true`。记下 `id`（形如 `w-181`），后续步骤会多出面板窗口。

### 2. 菜单结构

```bash
agent-desktop find --app "grok-app" --surface menubar --role menu
```

期望的顶层菜单（顺序固定）：`Apple`、`Grok Dev`、`File`、`Edit`、`View`、`Window`、`Help`。

逐项断言：

| 菜单 | 期望内容 |
|---|---|
| `Grok Dev` | `About grok-app`、`Services`、`Hide grok-app`、`Hide Others`、`Quit grok-app` |
| `File` | 只有一项：`关闭` / `Close`（⌘W） |
| `Edit` | `Undo`、`Redo`、`Cut`、`Copy`、`Paste`、`Select All` 等系统项 |
| `View` | 只有 `Toggle Full Screen`（仅 macOS 有这一项） |
| `Window` | `Minimize`、`Zoom`、`Move & Resize`…，以及 app 自有的 `关闭` 和 `Grok`（点它把主窗口提到最前） |
| `Help` | 空的（macOS 的 About 在 app 菜单里） |

`File` 只有一项是关键断言：如果这里出现系统默认的 `Close`（由操作系统直接关窗、不给前端机会），说明 `app_menu::install` 没生效。

### 3. About 面板

```bash
agent-desktop find --app "grok-app" --surface menubar --role menuitem --name "About grok-app" --exact --first
agent-desktop click @<snapshot_id>:e1
agent-desktop list-windows --app "grok-app"          # 变成两个窗口
agent-desktop snapshot --app "grok-app" --window-id <新窗口 id> --compact
```

期望：多出一个约 284×170 的窗口，`role: dialog`，含两个静态文本——产品名 `Grok Dev` 与版本 `Version 0.2.55 (0.2.55)`，外加 `Close` 按钮。版本号必须与 `package.json` 一致。

点 `Close` 后 `list-windows` 回到一个窗口，且主窗口重新可聚焦。

注意菜单项标签是 `About grok-app`（`package_info().name` = 可执行名），面板里显示的却是产品名 `Grok Dev`，两者不同是正常的。

### 4. 关闭主窗口 = 隐藏到托盘

```bash
agent-desktop find --app "grok-app" --surface menubar --role menuitem --name "关闭" --exact --first
agent-desktop click @<snapshot_id>:e1
agent-desktop list-windows --app "grok-app"          # 期望 data: []
agent-desktop list-apps --app "grok-app"             # 期望 pid 仍在
```

期望：

- `list-windows` 返回空数组——窗口真的不见了，不是最小化（最小化会留在列表里）。
- `list-apps --app "grok-app"` 仍返回 `pid` 与 `presentation: foreground`，`ps -p <pid>` 仍在。
- dev 日志出现 `main window focused transition focused=false app_active=false`。

若窗口仍在列表里、或进程直接退出，说明 `closeToTray` 分支被改坏。

### 5. 恢复窗口

```bash
cd <repo> && ./src-tauri/target/debug/grok-app
```

期望：第二个进程立即退出（`exit=0`），主进程窗口回到隐藏前的 bounds（本次 `1400×900 @ (68, 82)`），`list-windows` 重新出现窗口。

托盘图标（菜单栏额外项）不暴露给辅助功能树：`snapshot --surface menu-bar-extras` 只列出电池、时钟、Wi-Fi、控制中心，app 自己的状态项不在其中。因此恢复统一走「再启动一次二进制」，它和点托盘里的 Open 走同一个 `tray::show_main_window`。

隐藏之后用 `osascript` 把进程设成 frontmost **不会**恢复窗口：隐藏时应用切成了 accessory，激活不触发 Reopen。别在这条路径上浪费时间。

## 断言汇总

| # | 断言 | 命令 | 通过标准 |
|---|---|---|---|
| 1 | 主窗口存在 | `list-windows --app grok-app` | 一个窗口，title `grok-app` |
| 2 | 菜单为 app 持有 | `find --surface menubar --role menu` | 顶层含 `File`/`Edit`/`View`/`Window`/`Help` |
| 3 | ⌘W 归 app 所有 | `find --surface menubar --name 关闭 --exact --first` | 命中，且 `File` 下只有这一项 |
| 4 | About 显示产品名与版本 | `snapshot --window-id <面板>` | `Grok Dev` + 与 `package.json` 一致的版本 |
| 5 | 关闭是隐藏不是退出 | `list-windows` / `list-apps` | 窗口空、进程在 |
| 6 | 可恢复 | 再次执行 dev 二进制 | 窗口回来、bounds 不变 |

## 已知限制

- **WebView 内容区读不到**：对 `main` / `webarea` 做 `snapshot --root` 或按 `role` `find` composer 时，可能返回 `APP_UNRESPONSIVE … kAXErrorInvalidUIElement`。重试一次仍然失败就停在窗口级断言，不要为此改用 `--headed` 或物理点击。
- **窗口级 skeleton 只到 `webarea` + 侧栏按钮**（`会话侧栏`、`隐藏侧栏`、`显示/隐藏侧边栏`），看不到 composer，所以本流程不覆盖「窗口恢复后会话内容完好」，那部分由集成测试覆盖。
- **Stage Manager** 见前置条件；它会让所有 bounds 断言失效。
- **`focus-window --window-id` 可能 TIMEOUT**（应用不在前台或刚从托盘恢复）。先切前台再操作，或直接用 bounds 判断。

## 清理

```bash
# 结束 dev：在启动 pnpm dev 的终端按 Ctrl+C
agent-desktop list-apps --app "grok-app"     # 期望空
```

- 不要用 `close-app` 关正式版 `Grok`；本流程只针对 `grok-app`。
- 不要为了跑流程去改共享的 `settings.json`；需要验证 `closeToTray=false` 分支时另起任务，并在结束后改回。
- 窗口 bounds 变化会被持久化进 `.window-state.json`；断言里不要写死尺寸，用「隐藏前后一致」比较。

## 实测记录

2026-11-19，macOS，agent-desktop 1.3.1，dev 二进制 `0.2.55`：

- 菜单结构、About 面板（`Grok Dev` / `Version 0.2.55 (0.2.55)`）、`File > 关闭` 后 `list-windows: []` 且 pid 存活、再次启动二进制恢复窗口 `1400×900 @ (68, 82)`，全部符合上述期望。
- `closeToTray=false` 的退出确认分支未在本次验证中执行（需要改共享设置）。
