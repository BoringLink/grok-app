import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveAppDisplayVersion } from "./src/lib/appDisplayVersion";

/** 读取 git 命令输出；仓库不可用时返回空串，由版本回落逻辑处理。 */
function gitOut(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * 计算 Vite `define` 注入的显示版本号。
 *
 * `vite.config.ts` 与 Vitest 配置共用，保证测试里读到的
 * `import.meta.env.VITE_GROK_DISPLAY_VERSION` 与真实构建一致。
 */
export function resolveBakedDisplayVersion(root: string): string {
  let packageVersion = "";
  try {
    packageVersion = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ).version as string;
  } catch {
    packageVersion = "";
  }
  return resolveAppDisplayVersion({
    tagsAtHead: gitOut(root, ["tag", "--points-at", "HEAD"])
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean),
    shortSha: gitOut(root, ["rev-parse", "--short", "HEAD"]) || null,
    packageVersion,
    githubRef: process.env.GITHUB_REF,
    githubRefType: process.env.GITHUB_REF_TYPE,
    githubRefName: process.env.GITHUB_REF_NAME,
    displayOverride:
      process.env.GROK_DISPLAY_VERSION || process.env.VITE_GROK_DISPLAY_VERSION,
  });
}
