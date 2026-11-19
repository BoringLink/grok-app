# HANDOFF — 移除 agent-home config.toml 的备份写入逻辑

- 分支:`chore/remove-agent-home-config-backup`(基于 `main` @ `82b280df` v0.2.55)
- Worktree:`/Users/soren/personal-git/grok-app-remove-backup`
- 目标:heal 机制不再向 agent-home 写 `config.toml.bak-heal-{unix秒}` 备份文件。

## 背景(2026-11-19 排查结论)

用户的 `agent-home` 长期累积 `.bak` 文件(回收站现存 16 个)。来源分四类:
1. `sync-grok-app` 脚本(`bak_时间戳` 系列,9-21,agent 会话手工运行,已不存在于机器上);
2. agent 会话手工 `cp`(`bak-before-model-sections`、`bak-broken-alias-state`,9-23);
3. **App 本体的 heal 备份**(`bak-heal-{unix秒}`,9-23~9-24 共 7 个)——本任务要移除的唯一产品侧来源;
4. MCP 修复时的手工备份(11-18)。

**关键事实:全代码库(git 全历史)、前端、Grok Build CLI 二进制中没有任何读取 `.bak` 的路径。**
备份是纯死数据,移除写入不影响任何读取方。

## heal 机制现状

- 入口:`src-tauri/src/agent_home_config.rs:507` `ensure_agent_home_config_sane(session_data_mode)`。
- 调用点:`src-tauri/src/acp_client.rs:916`(每次会话连接 / agent prep 时检查)。
- 行为:仅当 `config.toml` 存在重复赋值 key 时,L570-572 先 `fs::copy` 备份原件为
  `config.toml.bak-heal-{unix秒}`,再写入去重后的配置(同 key 保留最后一次赋值)。
  shared 模式 / 文件缺失 / 空文件 / 无重复 key 时均 no-op,**合法文件从不写**。
- 历史背景:提交 `b7d0d5aa`(heal duplicate keys + exact-match upserts)引入;其中
  exact-match upserts 已修复重复 key 的产生根因,9-24 之后 heal 未再触发。

## 改动点

1. `agent_home_config.rs` L568-575:删除 `fs::copy` 备份与 `backup` 变量,直接 `fs::write(&path, &healed)`。
2. `ConfigHealReport`(L481-499)的 `backup_path` 字段:建议整体删除,并同步更新:
   - 所有 `backup_path: None` 构造点;
   - `acp_client.rs:916-925` 处 tracing 日志里的 `backup = ?report.backup_path` 字段;
   - 测试 `agent_home_config.rs` L861-890(`ensure_sane_noops_on_valid_and_heals_dups` 断言
     `r2.backup_path.is_some()`)改为断言"无备份文件残留"。
3. 检查 UI 是否展示 `backup_path`(doctor / 设置面板):`rg -n 'backup_path|ConfigHealReport' src/ src-tauri/src`,
   若有展示需同步调整文案;`rg -n 'bak-heal' docs/` 同步文档。
4. 新增回归测试:构造含重复 key 的临时 home → heal → 断言配置已去重且目录下**没有**新 `.bak` 文件。

## 风险与说明

- 无备份即无回滚副本。缓解:heal 仅在重复 key 场景触发、保留最后赋值、输出确定性;
  且历史上读取方为零。若 code review 倾向保守,可退而求其次改为"单槽滚动备份"
  (固定文件名,覆盖旧备份,不累积),但用户明确要求移除,默认按完全移除实现。

## 验收

```bash
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
```

手动:向 agent-home `config.toml` 注入一行重复赋值 → 在 App 中连接任意会话 →
确认配置被去重、目录无新 `.bak`;再次连接无多余写入。

提交信息建议:`chore(agent-home): stop writing config.toml heal backups`
