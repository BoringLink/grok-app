import path from "node:path";
import { defineConfig } from "vitest/config";
import { resolveBakedDisplayVersion } from "./build-version";

/**
 * 任务验收测试配置。只收录 `tests/acceptance/**`，默认回归 (`pnpm test`) 不加载。
 *
 * 目录约定：`tests/acceptance/<YYYY-MM-DD>-<任务slug>/`，验收完成后由
 * `pnpm test:acceptance:clean` 删除，不进入产品回归集。
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  define: {
    "import.meta.env.VITE_GROK_DISPLAY_VERSION": JSON.stringify(
      resolveBakedDisplayVersion(path.resolve(__dirname)),
    ),
  },
  test: {
    name: "acceptance",
    environment: "node",
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    include: [
      "tests/acceptance/**/*.{test,spec}.ts",
      "tests/acceptance/**/*.{test,spec}.tsx",
    ],
    setupFiles: ["./src/test/loadLocaleCatalogs.ts"],
    // 没有待验收任务时属于正常状态。
    passWithNoTests: true,
  },
});
