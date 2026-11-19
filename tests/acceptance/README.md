# 任务验收测试

用来证明「本次任务完成」，验收后销毁，不进入产品回归集。

## 目录

```
tests/acceptance/
└── 2026-11-19-test-suite-restructure/
    ├── README.md          # 验收目标、命令、证据（可选）
    └── *.test.ts(x)
```

- 一级目录统一为 `<YYYY-MM-DD>-<任务slug>`，日期是任务开始日期。
- 目录内文件命名不限，按验收点组织。
- 一个任务一个目录；同一任务的多轮验收可以覆盖同一目录。

## 生命周期

1. 开工时创建目录，写覆盖验收标准的用例。
2. `pnpm test:acceptance` 执行；结果与命令贴进 PR / Issue 作为验收证据。
3. 验收通过后删除目录。可手工删除，也可用清理脚本：

```bash
pnpm test:acceptance:clean                                  # 预览 7 天前的目录
pnpm test:acceptance:clean -- --older-than-days 0 --apply    # 删除全部验收目录
```

`pnpm test` 与 CI 都不包含本目录。

## 与产品回归的边界

- 验收用例可以被实现细节绑定（例如临时快照、一次性 mock），这是允许的。
- 一旦某条验收结论需要长期守护，把它改写成单元或集成用例放进 `src/` 或 `tests/integration/`，不要在验收目录里留存副本。
