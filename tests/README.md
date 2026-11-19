# 测试目录约定

Grok App 的测试按 **场景** 和 **范围** 两个维度组织。任何新用例先确定场景，再决定放在哪一层。

## 场景 × 范围

| 范围 | 产品回归（长期保留） | 任务验收（验收后销毁） |
|---|---|---|
| 单元测试 | `src/**/*.test.ts(x)`，与源码同目录 | `tests/acceptance/<日期>-<任务>/` |
| 静态守卫 | `src/**/*.guard.test.ts(x)`，与源码同目录 | 不适用 |
| 集成测试 | `tests/integration/**` | `tests/acceptance/<日期>-<任务>/` |
| 端到端测试 | `tests/e2e/**`（agent-desktop 流程） | `tests/acceptance/<日期>-<任务>/` |

## 判定规则

1. **产品回归**：守护已发布行为，改动失败即代表产品回归，必须长期保留。
2. **任务验收**：只证明「这次任务做完了」。验收结论写进 PR / Issue 后即失效，不留在回归集里。
3. **单元**：单个模块的输入输出，或对源码/样式的静态断言（`*.guard.test.ts`）。
4. **集成**：跨两个以上模块，或经过真实宿主边界（子进程、临时目录、真实文件系统、IPC 协议）。
5. **端到端**：真实窗口、菜单、弹窗、持久化结果的完整用户路径，用 `agent-desktop` 驱动。

同一用例同时满足多个层次时，放在能覆盖风险的最低层。

## 命令

| 命令 | 范围 |
|---|---|
| `pnpm test` | 产品回归：unit + integration（CI 闸门） |
| `pnpm test:unit` | 只跑 unit |
| `pnpm test:integration` | 只跑 integration |
| `pnpm test:acceptance` | 只跑 `tests/acceptance/**`，默认回归不含 |
| `pnpm test:acceptance:clean` | 预览过期验收目录，`--apply` 才删除 |

## 边界

- 验收用例默认不进入 CI；需要跑时显式执行 `pnpm test:acceptance`。
- 端到端流程默认不进 CI，发版前或改动桌面交互时执行 `tests/e2e/` 里的流程。
- 产品规则的完整说明见 `docs/llm-wiki/testing.md`。
