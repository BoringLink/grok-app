# 测试结构与生命周期

测试按 **场景** 和 **范围** 两个维度划分。场景决定生命周期，范围决定放置位置与执行命令。目录细节见 `tests/README.md`。

## 场景

| 场景 | 用途 | 生命周期 |
|---|---|---|
| 任务验收 | 证明本次任务达成验收标准 | 验收通过后销毁，不进长期回归 |
| 产品回归 | 守护已发布行为，失败即代表产品回归 | 长期保留，随产品演进更新 |

同一份用例只服务一个场景。验收结论需要长期守护时，改写成回归用例，不在验收目录留副本。

## 范围

| 范围 | 位置 | 判定标准 |
|---|---|---|
| 单元 | `src/**/*.test.ts(x)`，与源码同目录 | 单模块输入输出 |
| 静态守卫 | `src/**/*.guard.test.ts(x)` | 对源码、样式、Rust 文件做静态断言 |
| 集成 | `tests/integration/**` | 跨两个以上模块，或经真实宿主边界 |
| 端到端 | `tests/e2e/**` | 真实窗口/菜单/弹窗/持久化路径，`agent-desktop` 驱动 |

## 命令

| 命令 | 内容 | CI |
|---|---|---|
| `pnpm test` | unit + integration | ✅ |
| `pnpm test:unit` | 只跑单元与静态守卫 | 本地排查 |
| `pnpm test:integration` | 只跑集成 | 本地排查 |
| `pnpm test:acceptance` | `tests/acceptance/**` | ❌ |
| `pnpm test:acceptance:clean` | 预览过期验收目录 | ❌ |

`vitest.config.ts` 定义 `unit` / `integration` 两个 project，默认回归只加载这两个；`vitest.acceptance.config.ts` 单独收录验收目录，因此任何人都无法通过 `pnpm test` 把验收用例带进主分支闸门。

## 任务验收

目录：`tests/acceptance/<YYYY-MM-DD>-<任务slug>/`。

1. 开工时新建目录，写覆盖验收标准的用例。
2. `pnpm test:acceptance` 执行，把命令与结果贴进 PR / Issue 作为验收证据。
3. 验收通过后删除目录：`pnpm test:acceptance:clean -- --apply`（默认只删 7 天前的目录，`--older-than-days 0` 删全部）。

验收用例可以绑定临时实现细节和一次性 mock；这正是它需要销毁的原因。

## 静态守卫（guard）

`*.guard.test.ts` 不验证行为，而是守住一条工程约束（例如「Windows 上不得裸起控制台进程」「设置面板必须有不透明背景」）。约定：

- 断言对象是源码/样式文件的稳定结构，不是大段精确文本；文案断言优先用 i18n key。
- 扫描整棵目录的用例要显式放宽超时（默认 5s 在并发全量运行时可能误超时）。
- 约束失效（代码已删除或规则作废）时删除守卫用例，不留「永远通过」的空壳。

## 端到端

`tests/e2e/` 保存 `agent-desktop` 流程文档，工具安装与权限见 `docs/llm-wiki/desktop-e2e.md`。CI 默认不执行，改动桌面交互或持久化路径时手工执行并在 PR 中记录流程名。

## 用例编写约定

- 只断言对外可见结果；需要断言源码结构时放进 `*.guard.test.ts`。
- 失败信息要能定位行为，不写 `expect(x).toBeTruthy()` 这类无信息断言。
- 临时文件、子进程、监听器必须有清理路径。
- 平台差异用 `process.platform` 显式分支，不依赖开发机默认值。
