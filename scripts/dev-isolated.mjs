import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const originalHome = homedir();
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const devHome = join(repoRoot, ".grok-app-dev");
const appHome = join(devHome, "app-data");
const grokHome = join(devHome, ".grok");
const packageManager = process.env.npm_execpath;

if (!packageManager) {
  throw new Error("pnpm must launch the isolated Grok Dev environment");
}

const packageManagerIsJavaScript = /\.[cm]?js$/i.test(packageManager);
const packageManagerCommand = packageManagerIsJavaScript
  ? process.execPath
  : packageManager;
const packageManagerArgs = packageManagerIsJavaScript ? [packageManager] : [];

await mkdir(appHome, { recursive: true, mode: 0o700 });

const child = spawn(
  packageManagerCommand,
  [
    ...packageManagerArgs,
    "exec",
    "tauri",
    "dev",
    "--config",
    "src-tauri/tauri.dev.conf.json",
    ...process.argv.slice(2),
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: devHome,
      USERPROFILE: devHome,
      GROK_APP_HOME: appHome,
      GROK_HOME: grokHome,
      CARGO_HOME: process.env.CARGO_HOME ?? join(originalHome, ".cargo"),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(originalHome, ".rustup"),
      PATH: [join(originalHome, ".grok", "bin"), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
    },
  },
);

child.on("error", (error) => {
  console.error("Failed to start Grok Dev:", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
