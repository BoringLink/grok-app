# BOR-156 模型上下文窗口实现计划

- 日期：2026-11-18
- 分支：`feat/bor-156-model-context-window`
- Linear：[BOR-156](https://linear.app/boring-link/issue/BOR-156/统一配置模型上下文窗口并收敛-composer-控件)

## 目标

统一官方与自定义模型的上下文窗口来源：窗口由模型配置决定，Host 在连接与切换模型时按目标模型下发；Composer 只负责模型与推理档，编辑器上下文组件继续展示真实用量。

## 最终范围

- 官方模型窗口只来自 CLI 目录（`models_cache.json`）；设置页不提供覆盖，App 不写窗口覆盖文件。
- 自定义提供商的窗口在设置 → 账户 → Providers 的模型齿轮中配置；生效顺序为模型行 `contextWindow` → 通道 `contextWindow` → **1M 兜底**。
- 设置中的 Available models 保持只读目录行。
- Composer 不提供窗口选择入口，`/context-window` 命令移除。
- 编辑器上下文组件以 live 用量优先，其次模型生效窗口；改配置不伪造用量。

## 实施步骤

| 步骤 | 内容 | 提交 | 状态 |
|------|------|------|------|
| 1 | Host 按模型解析生效窗口并在连接 / 恢复会话时下发 `_meta.contextWindow` | `18421574` | 完成 |
| 2 | Host 在切换模型时解析目标模型窗口，不沿用上一个模型 | `18421574` | 完成 |
| 3 | Composer 移除 `/context-window`、窗口状态与菜单入口 | `f344953b` | 完成 |
| 4 | 官方模型窗口收敛为目录只读，删除 App 侧覆盖存储与设置选择器 | `a5534186` → 回退 `ebb21342` / `110b7d68` | 完成 |
| 5 | 自定义提供商在模型行与通道都未配置时实际下发 1M 兜底 | `b8c5c5c3` | 完成 |
| 6 | 同步 `docs/llm-wiki/catalog.md`、`providers.md` | `e53a3c84`、`aece8ef2` | 完成 |

## 验证

- `cargo test --lib`：2307 passed，3 ignored。
- `cargo fmt --check`、`scripts/check-code-quality-gates.py`：通过。
- `pnpm typecheck`、`pnpm lint`：通过。
- `pnpm test`：749 个文件 / 8642 个用例通过。
- 覆盖边界：模型行优先于通道、行 / 通道为 0 时回落 1M、官方目录无窗口不下发、切换模型不继承旧窗口。

## 未完成

- 分支尚未推送，未创建 PR。
- 未在真实桌面窗口中手工验证设置页与 Composer（本次会话无浏览器工具；组件行为由 jsdom 测试覆盖，命令路径由 Rust 测试覆盖）。
