# BOR-157 旧模型状态收缩与集成验收计划

- 日期：2026-11-18
- 分支：`feat/bor-157-legacy-model-state-cleanup`
- Linear：[BOR-157](https://linear.app/boring-link/issue/BOR-157/收缩旧模型状态并完成重构集成验收)
- 前置：BOR-152~156 已合并进本分支（模型档案契约、元数据、会话级路由、推理档位、上下文窗口）。

## 目标

删除重构后遗留的全局激活与重复模型状态，保留存量数据迁移兼容，并补齐产品文档与集成验收。

## 实施步骤

| 步骤 | 内容 | 提交 | 状态 |
|------|------|------|------|
| 1 | Host 删除全局激活链：`ProvidersListResult.active_source/active_provider_id`、`route_from_default`、`ActiveRoute`/`active_route()`、删除 provider 时的 `[models].default` 回写、`models_aux_*` 命令面与死代码、`official_aux` 的 `main_route_is_custom` / `prepare_x_search_block*` | `ff85d4a4` | 完成 |
| 2 | 设置搜索注册 `settings-anchor-prov-models`（模型目录 + 模型齿轮） | `0c665457` | 完成 |
| 3 | TS 收敛：删除 `modelsAux*` API、`activeSource`/`activeProviderId` 双 prop → 单一 `providerRoute`、AppWorkbench 三份路由状态 → 单一 `providerRouteId`、删除死导出（`effectiveComposerModel`、`resolveProviderSupportsVideo`、重复 1M 常量、`providerPing`、`SecretsStatus.defaultModel`）与 16 语言死文案 | `3c4ed12d` | 完成 |
| 4 | 旧会话回填迁移：`session_provider_backfill_migrated` 一次性幂等回填（唯一 provider 命中才写 `provider_id`；读取失败不落标记下次重试；已有 `provider_id` 永不覆盖） | `7bee46e9` | 完成 |
| 5 | 文档：`providers.md`（窗口来源、`isDefault`、Recovery/回填）、`automations.md`（当前路由语义）、`settings-ia.md`（新搜索锚点）、supersede 2026-07-31 两份 picker 计划 | 本次 | 完成 |

## 迁移契约

- 旧会话只有 `model_id`：唯一自定义 provider 列出该 id → 回填 `provider_id`，模型 id / effort / 排序不变；歧义或官方模型 → 保持 official 回退。
- 回填只跑一次（settings 标记），provider 配置不可读时放弃且不落标记，下次启动重试。
- `[models].default`：App 不再写（含删除 provider 时），仅保留 legacy 读取（`defaultModel` / `isDefault` secrets 镜像）。
- 既有迁移（relay 单槽、整数修复、effort 支持字段、child section 同步）保持不动，幂等性有测试。

## 验证

（收尾时回填）

## 未完成

（收尾时回填）
