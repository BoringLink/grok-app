import path from "node:path";
import { defineConfig } from "vitest/config";
import { resolveBakedDisplayVersion } from "./build-version";

/**
 * 默认回归测试配置：`pnpm test` 只跑 unit 与 integration 两个 project。
 *
 * - unit：与源码同目录的 `src/**\/*.test.ts(x)`，包含纯逻辑与静态 guard 用例。
 * - integration：`tests/integration/**`，跨模块或真实宿主边界（子进程、临时目录）。
 *
 * 任务验收用例是另一条生命周期，放在 `tests/acceptance/**`，由
 * `vitest.acceptance.config.ts` 单独执行，绝不进入默认回归。
 */
const alias = { "@": path.resolve(__dirname, "./src") };
const define = {
  // 与 vite.config.ts 同一规则，保证测试读到真实构建一致的显示版本。
  "import.meta.env.VITE_GROK_DISPLAY_VERSION": JSON.stringify(
    resolveBakedDisplayVersion(path.resolve(__dirname)),
  ),
};
const sharedTest = {
  environment: "node",
  environmentOptions: {
    jsdom: {
      url: "http://localhost/",
    },
  },
  setupFiles: ["./src/test/loadLocaleCatalogs.ts"],
};

export default defineConfig({
  resolve: { alias },
  define,
  test: {
    ...sharedTest,
    projects: [
      {
        resolve: { alias },
        define,
        test: {
          ...sharedTest,
          name: "unit",
          include: ["src/**/*.{test,spec}.ts", "src/**/*.{test,spec}.tsx"],
        },
      },
      {
        resolve: { alias },
        define,
        test: {
          ...sharedTest,
          name: "integration",
          include: [
            "tests/integration/**/*.{test,spec}.ts",
            "tests/integration/**/*.{test,spec}.tsx",
          ],
        },
      },
    ],
  },
});
