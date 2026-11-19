/**
 * 清理任务验收测试目录。
 *
 * 约定：`tests/acceptance/<YYYY-MM-DD>-<任务slug>/` 是一次任务的验收用例，
 * 验收通过后即失效。默认只打印将被删除的目录；传入 `--apply` 才真正删除。
 *
 * 用法：
 *   node scripts/clean-acceptance-tests.mjs               # 预览 7 天前的目录
 *   node scripts/clean-acceptance-tests.mjs --apply       # 删除 7 天前的目录
 *   node scripts/clean-acceptance-tests.mjs --older-than-days 0 --apply  # 删除全部
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ACCEPTANCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests/acceptance",
);
const DAY_MS = 24 * 60 * 60 * 1000;
/** 目录内允许保留的非任务文件。 */
const KEPT_NAMES = new Set(["README.md", ".gitkeep"]);

function parseArgs(argv) {
  const options = { apply: false, olderThanDays: 7 };
  argv.forEach((arg, index) => {
    if (arg === "--apply") {
      options.apply = true;
      return;
    }
    if (arg === "--older-than-days") {
      const raw = argv[index + 1];
      const parsed = Number.parseInt(raw ?? "", 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--older-than-days 需要非负整数，收到: ${raw ?? "(空)"}`);
      }
      options.olderThanDays = parsed;
    }
  });
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cutoff = Date.now() - options.olderThanDays * DAY_MS;

  const entries = readdirSync(ACCEPTANCE_ROOT, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !KEPT_NAMES.has(entry.name),
  );

  const stale = entries.filter((entry) => {
    const target = path.join(ACCEPTANCE_ROOT, entry.name);
    return statSync(target).mtimeMs < cutoff;
  });

  if (stale.length === 0) {
    console.log(
      `没有超过 ${options.olderThanDays} 天的验收目录（${ACCEPTANCE_ROOT}）。`,
    );
    return;
  }

  stale.forEach((entry) => {
    const target = path.join(ACCEPTANCE_ROOT, entry.name);
    // 防止软链或路径逃逸把删除范围带出验收目录。
    if (!target.startsWith(ACCEPTANCE_ROOT + path.sep)) {
      throw new Error(`拒绝删除验收目录之外的路径: ${target}`);
    }
    if (options.apply) {
      rmSync(target, { recursive: true, force: true });
      console.log(`已删除 ${path.relative(process.cwd(), target)}`);
    } else {
      console.log(`将删除 ${path.relative(process.cwd(), target)}（加 --apply 执行）`);
    }
  });
}

main();
