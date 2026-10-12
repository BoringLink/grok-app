# PR Monitor 多 PR 验收（本 PR，第二个 fixture）

本分支与它的 PR 只用于验收 Grok App 的 **PR Monitor 多 PR 场景**：同时挂着两个 PR 时，每个 PR 各自
触发唤醒、互不串台，且分支菜单能在同一处列出、逐个停掉本会话的全部挂载。验收完即删，不含产品改动。

本 PR 与 [PR #1](https://github.com/BoringLink/grok-app/pull/1) 是**互相独立**的两个 fixture：
两者都从 `main` 起分支，各自带一个「刻意失败 → 完成即通过」的检查。

## 待更新事项

- [ ] **待更新项**：把下面 `STATUS-2` 的值由 `PENDING` 改成 `DONE` 后提交并推送。

```
STATUS-2: PENDING
```

`pr-monitor-acceptance-2` 这个检查项在 `PENDING` 时刻意失败，改成 `DONE` 后通过；因此「完成本事项」
这一次推送就是一次可预测的 CI 状态迁移（失败 → 通过），再加上一次 PR 更新事件。它与 PR #1 的
`pr-monitor-acceptance` 是两个独立检查，所以从检查名就能看出更新来自哪个 PR。

## 多 PR 场景要看的东西

| # | 期望 |
| --- | --- |
| 1 | 两个 PR 各自挂上 Monitor，互不影响 |
| 2 | 分支菜单「拉取请求」区：一行一个 PR，每行尾部自带铃铛开关（需要带 `46e5f5ad` 的 App 构建） |
| 3 | 只动本 PR，也会得到指向本 PR（序号 / 标题 / URL）的唤醒 |
| 4 | 唤醒只进挂载它的那个会话，不串到另一个 PR / 另一个会话 |

> 第 2 条依赖 PR #1 分支上的优化提交 `feat(pr-monitor): one row per PR with the watch control inline`；
> 本 worktree 的代码是 `main`，没有这行改动。

## 可用来触发更新的动作

| 动作 | 期望 |
| --- | --- |
| 完成待更新事项并推送 | 本 PR 的 CI 由失败转通过 → 唤醒会话 |
| 在本 PR 下追加评论 | 新评论 → 唤醒会话 |
| 修改 PR 标题 | 标题变化 → 唤醒会话 |

> 说明：本仓库自身的 `ci.yml` 也会在这个 PR 上跑（frontend + Rust），耗时较长，属正常现象。
