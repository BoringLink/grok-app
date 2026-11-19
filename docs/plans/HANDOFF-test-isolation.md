# HANDOFF — 修复 cargo test 写穿真实 settings.json 的测试隔离缺陷

- 分支:`fix/test-isolation-clobbers-real-settings`(基于 `main` @ `82b280df` v0.2.55)
- Worktree:`/Users/soren/personal-git/grok-app-test-isolation`
- 目标:测试套件(`cargo test`,lib 与集成)在任何情况下都不得读写真实数据根
  `~/Library/Application Support/com.grokapp.grok-app/`。

## 根因(2026-11-18/19 已实证)

1. 测试隔离依赖进程级环境变量 `GROK_APP_HOME`(`src-tauri/src/paths.rs:12` `app_data_root()` 动态读取,无缓存)。
2. 各测试文件的守卫助手共享 `paths::APP_HOME_ENV_LOCK` 互斥锁,但大量**内联守卫在结束时无条件
   `std::env::remove_var("GROK_APP_HOME")` 而不恢复原值**。泄漏点(全部在测试代码):
   - `store.rs` ~L5010-5050(`create_session_defaults_to_orphan`、`fork_session_partial_stores_rewind_index`)
   - `skin_presets.rs` L643/653/687/727/750
   - `cli_sessions/rewind_fence.rs` L180/199、`cli_sessions/rewind_reconcile_tests.rs` L128
   - `agent_home_config.rs` L898、`agent_proc_home.rs` L629
3. env 被抹掉后,同一测试二进制内**任何未受守卫保护的** `load_settings()`/`save_settings()`/
   `write_json(settings_file())` 解析到真实数据根:
   - 已观测签名 A(良性):真实 settings.json 仅被追加 `sessionProviderBackfillMigrated` 迁移标志;
   - 已观测签名 B(破坏性):整份覆盖为 `AppSettings::default()` + 测试夹具代理值(23 字段,
     含 `officialAuxInject=true`、`sessionDataMode="shared"`、`onboardingDone=false`、
     `manual+127.0.0.1:18080` 夹具代理)——即用户报的"每次重启设置被重置为固定一套"。
4. 复现记录(2026-11-18,监控快照 /tmp/grok-settings-watch/):
   `cargo test --lib` 全量并行跑,broken 概率约 1/2 触发真实文件写入;
   即使 `GROK_APP_HOME=/tmp/沙箱 cargo test --lib`,真实文件仍被写入(shell 传入值被内联守卫抹掉)。
   2026-11-19 10:45 仍有一次 `cargo test`(10:43 启动)写入迁移标志,缺陷持续存活。

## 实现方案(推荐顺序)

1. **让未隔离路径响亮失败**:`paths.rs::app_data_root()` 增加
   `#[cfg(test)]` 分支——`GROK_APP_HOME` 未设置时 `panic!("test must set GROK_APP_HOME ...")`。
   这样任何绕过守卫的读写在跑测时直接失败并指向具体测试,而不是静默写生产配置。
2. **修复所有内联守卫**:把上述 remove_var 泄漏点统一改为"保存 previous → 恢复 previous"
   (即 `store.rs::TempAppHome` 的语义,见 `with_temp_app_home` L~4040-4075)。
3. **统一测试助手**:`with_temp_app_home` 目前是 `store.rs` tests 模块私有,
   `integration_test.rs::with_isolated_project_store`(L28-75)、`workspace_store.rs` L549、
   `agent_memory_embed_tests.rs` L156/216/355 各自维护 env 逻辑。建议提取共享
   `#[cfg(test)]` 助手(如 `src/test_support.rs`)供全部模块使用,消除复制漂移。
4. 跑全量套件,逐个修复 panic 出的未守卫测试(补守卫或改用共享助手)。
   注意 `settings.json.lock`、`sessions/`、`sessions_index`、`projects.json` 等真实根副作用
   也会被 panic 策略一并暴露,都需要覆盖。

轻量替代方案(不推荐,仅备选):仅在 `load_settings`/`save_settings` 入口做 cfg(test) 拒绝真实根,
不覆盖其它文件路径。

## 复现与验证

```bash
# 监控脚本(已存在):/tmp/grok-settings-watch.sh,快照目录 /tmp/grok-settings-watch/
# 修复前基线(破坏性,只在确认可恢复时执行;备份:cp settings.json /tmp/settings.json.bak)
cd src-tauri && cargo test --lib   # 观察监控是否报 settings.json CHANGE

# 修复后验收:连续多次全量,settings.json md5 不变
for i in 1 2 3 4 5; do cargo test --lib --quiet; done
md5 -q "$HOME/Library/Application Support/com.grokapp.grok-app/settings.json"  # 每次相同
GROK_APP_HOME=/tmp/sandbox cargo test --lib   # 沙箱值不再被抹掉,沙箱内无真实数据泄漏
```

## 验收

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test            # 全部测试在无 GROK_APP_HOME 的干净 shell 下通过(证明全部路径已隔离)
```

外加:监控 5 轮全量无 settings.json 变更事件;真实数据根 mtime 无变化。

## 注意

- 开发本修复期间,本机其他 worktree 的 agent 若跑 `cargo test` 仍可能覆盖真实设置——
  开发期间保持监控开启,或先在沙箱 env 下开发。
- 相关记忆:workspace memory `topics/settings-reset-root-cause.md`(完整证据链)。
- 用户配置备份:`/tmp/settings.json.backup-204244`(2026-11-18 用户正确状态)。

提交信息建议:`fix(test): isolate GROK_APP_HOME per test and fail fast on real-root access`
