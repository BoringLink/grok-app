# PR Monitor「CI 运行期间挂载」验收（本 PR）

本分支与它的 PR 只用于验收 Grok App 的 **PR Monitor**，验收完即删，不含产品改动。

与前两个 fixture 的区别：这个 PR 的检查会**先跑 3 分钟再失败**，所以有时间在 CI 运行期间挂上
监视，观察 running → fail 这一条迁移。

## 这条验收要看什么

1. 分支区出现 `test/pr-monitor-ci-run #<n> <标题>`，标题过长要省略。
2. CI 正在跑的时候（`ci-slow-fail` 处于 in progress）在分支菜单「拉取请求」里挂上监视：
   显示「监视中」，且**不应**因为初始快照就唤醒 —— 挂载是给指纹打基线，不是一次变化。
3. `ci-slow-fail` 由 running 转 fail → 被唤醒一次，唤醒走 CI 失败那条（列出失败的 check 名，
   并带上 `Fix the failing CI checks` 那段）。
4. `ci-quick-pass` 早就通过、之后也不变，**不应**单独触发唤醒。
5. 完成下面的待更新事项（`CI-FAIL: ON` → `OFF`）再推一次 → `ci-slow-fail` 由 fail 转 pass →
   再被唤醒一次，这次是「CI 已变绿」。

## 时间线

| 检查 | 行为 |
| --- | --- |
| `ci-slow-fail` | 先跑约 3 分钟（日志每 30s 一行），随后失败 |
| `ci-quick-pass` | 立刻通过，让 checks 汇总同时有 pass 与 fail |
| 本仓库 `ci.yml`（frontend + Rust） | 和平时一样跑，耗时数分钟，属正常现象 |

想再触发一次运行：在 Actions 里对该 run 点 **Re-run jobs**，或者推一个空提交
（`git commit --allow-empty -m "retrigger"`）。后者也会顺带重跑 `ci.yml`。

## 可用来触发更新的动作

| 动作 | 期望 |
| --- | --- |
| 等 `ci-slow-fail` 从 running 转 fail | 唤醒一次，CI 失败文案 |
| 完成待更新事项并推送 | 唤醒一次，CI 变绿文案 |
| 在本 PR 下追加评论 | 新评论 → 唤醒会话 |
| 修改 PR 标题 | 标题变化 → 唤醒会话 |

## 待更新事项

- [x] **待更新项**：把下面 `CI-FAIL` 的值由 `ON` 改成 `OFF` 后提交并推送，`ci-slow-fail` 即变为通过。

```
CI-FAIL: OFF
```
