# 端到端测试（agent-desktop）

用 `agent-desktop` 通过 macOS 辅助功能树观察并操作真实的 Grok Dev 应用。这里保存具体流程，不接管 `docs/llm-wiki/desktop-e2e.md` 中的工具说明与权限步骤。

## 准入条件

只有同时满足以下条件的流程才放进来：

- 风险只在真实窗口、菜单、弹窗、剪贴板或持久化结果里暴露；单元/集成测试无法证明。
- 能用 `agent-desktop` 的 snapshot / ref 循环稳定复现。
- 有明确的前置条件（启动命令、初始项目、登录状态）。

## 目录与命名

```
tests/e2e/
├── README.md
└── <flow>.md          # 一个用户路径一份流程
```

每份流程包含：

1. 前置条件（`pnpm dev`、需要的项目目录、账号状态）。
2. 操作步骤（按 snapshot ref 描述点击、输入、导航）。
3. 断言（可见文案、状态、文件副作用）。
4. 清理（关闭弹窗、删除临时项目或会话）。

## 现有流程

| 流程 | 守的风险 | 最近实测 |
|---|---|---|
| [app-menu-window-lifecycle.md](app-menu-window-lifecycle.md) | 菜单条由 app 持有（⌘W 不是系统 Close）、About 面板的产品名与版本、`File → 关闭` 是隐藏到托盘而非退出、隐藏后经单实例 relaunch 恢复窗口与 bounds | 2026-11-19，dev 0.2.55 |

写流程时先读目标机器上的实测标识符，不要照抄 `productName`：dev 跑的是未打包的 `target/debug/grok-app`，`agent-desktop --app` 要用进程名 `grok-app`，窗口 title 也是 `grok-app`；`--app "Grok Dev"` 会返回 `APP_NOT_FOUND`。

## 执行

```bash
pnpm dev                     # 启动 Grok Dev
agent-desktop status         # 确认权限与 surfaces
agent-desktop snapshot       # 按流程文档逐步操作
```

CI 默认不执行。改动桌面交互、窗口 chrome、持久化路径时，发版前手工跑一遍相关流程，并在 PR 中记录跑过的流程名。

## 与产品回归的关系

流程稳定且能完全脚本化后，优先把可判定部分下沉为集成测试；端到端目录保留真实窗口独有的部分。
