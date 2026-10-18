/**
 * Measure the first-frame cost of opening a 10k-row conversation.
 *
 * The resident list mounts every conversation row, so "first frame" here is the
 * React mount of the row set plus the layout-ledger seeding and the first band
 * decision — the work `useChatResidentList` does before the first paint. This
 * runs the *real* modules (`@/hooks/useChatResidentList`, the ledger, the band
 * policy) in headless Chrome and reports the time from `render()` to the first
 * animation frame after it.
 *
 * It does NOT run the packaged app on WKWebView, so it cannot report a number
 * for the macOS client's own first frame; it bounds the frontend work.
 *
 *   node scripts/measure-chat-first-frame.mjs [rows]
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROWS = Number(process.argv[2] || 10_000);
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ENTRY = `
import { createRoot } from "react-dom/client";
import { createElement, memo, useRef, useSyncExternalStore } from "react";
import { useChatResidentList } from "@/hooks/useChatResidentList";
import { createLayoutLedger } from "@/lib/chatViewportLedger";

const ROWS = ${ROWS};

function makeController() {
  let ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
  const positionListeners = new Set();
  return {
    ledger: () => ledger,
    reportRowHeight(index, height) {
      if (index >= ledger.rowCount()) ledger.setCount(index + 1);
      ledger.setRowHeight(index, height, "measured");
    },
    resetLedger() {
      ledger = createLayoutLedger({ count: 0, estimateHeight: 120 });
    },
    restoreLayout() {},
    subscribePosition(listener) {
      positionListeners.add(listener);
      return () => positionListeners.delete(listener);
    },
    assign() {},
    escape() {},
    pinToEnd() {},
  };
}

window.__ROW_RENDERS__ = 0;
const Row = memo(function Row({ index, bandStore, rowHeight, measureRef }) {
  window.__ROW_RENDERS__ += 1;
  const rich = useSyncExternalStore(
    bandStore.subscribeFor(index),
    () => bandStore.isRich(index),
  );
  if (!rich) {
    return createElement("div", {
      "data-virt-index": index,
      style: { height: rowHeight(index), contain: "strict" },
    });
  }
  return createElement(
    "div",
    { "data-virt-index": index, ref: measureRef(index) },
    createElement("p", null, "row " + index),
  );
});

window.__APP_RENDERS__ = 0;
function App() {
  window.__APP_RENDERS__ += 1;
  const viewportRef = useRef(null);
  const isPinnedRef = useRef(true);
  const controllerRef = useRef(makeController());
  const { bandStore, rowHeight, measureRef } = useChatResidentList({
    itemCount: ROWS,
    getEstimateHeight: () => 60,
    viewportRef,
    isPinnedRef,
    controller: controllerRef.current,
    resetKey: "bench",
  });
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push(
      createElement(Row, { key: i, index: i, bandStore, rowHeight, measureRef }),
    );
  }
  window.__PINNED_REF__ = isPinnedRef;
  return createElement(
    "div",
    {
      ref: viewportRef,
      id: "viewport",
      style: { height: "100vh", overflowY: "auto" },
    },
    rows,
  );
}

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);

const t0 = performance.now();
root.render(createElement(App));
requestAnimationFrame(() =>
  requestAnimationFrame(async () => {
    window.__FIRST_FRAME_MS = performance.now() - t0;
    window.__ROW_COUNT = document.querySelectorAll("[data-virt-index]").length;
    window.__APP_RENDERS_AT_MOUNT__ = window.__APP_RENDERS__;
    // Scroll a while with follow released: the parent must not re-render, and
    // only the rows whose band membership flipped may re-render.
    const viewport = document.getElementById("viewport");
    window.__PINNED_REF__.current = false;
    const rowsBefore = window.__ROW_RENDERS__;
    for (let k = 0; k < 40; k++) {
      viewport.scrollTop = k * 240;
      viewport.dispatchEvent(new Event("scroll"));
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    window.__APP_RENDERS_AFTER_SCROLL__ = window.__APP_RENDERS__;
    window.__ROW_RENDERS_DURING_SCROLL__ =
      window.__ROW_RENDERS__ - rowsBefore;
  }),
);
`;

function run(command, args, { onStderr } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      onStderr?.(stderr);
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(stderr);
      else rejectPromise(new Error(`${command} exited ${code}\n${stderr}`));
    });
  });
}

async function main() {
  // Keep the harness inside the repo's node_modules so bare imports resolve.
  const cacheRoot = join(REPO, "node_modules/.cache");
  mkdirSync(cacheRoot, { recursive: true });
  const dir = mkdtempSync(join(cacheRoot, "chat-first-frame-"));
  try {
    writeFileSync(join(dir, "entry.jsx"), ENTRY);
    const { build } = await import("vite");
    await build({
      root: REPO,
      logLevel: "warn",
      resolve: { alias: { "@": join(REPO, "src") } },
      esbuild: { jsx: "automatic" },
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env.DEV": "false",
      },
      build: {
        outDir: dir,
        emptyOutDir: false,
        minify: false,
        lib: { entry: join(dir, "entry.jsx"), formats: ["es"], fileName: "harness" },
      },
    });
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body>
<script>
window.__ERR__ = null;
window.addEventListener("error", (e) => { window.__ERR__ = String((e.error && e.error.stack) || e.message); });
window.addEventListener("unhandledrejection", (e) => { window.__ERR__ = String((e.reason && e.reason.stack) || e.reason); });
</script>
<script type="module" src="./harness.js"></script>
</body></html>`,
    );

    const port = 9200 + Math.floor(Math.random() * 500);
    const chrome = spawn(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--remote-debugging-port=${port}`,
      "--user-data-dir=" + join(dir, "profile"),
      "about:blank",
    ]);

    const server = await serveDir(dir);
    try {
      const ws = await waitForDevtools(port);
      const result = await evaluateFirstFrame(
        ws,
        `http://127.0.0.1:${server.port}/index.html`,
      );
      console.log(
        `first-frame: ${result.ms.toFixed(0)}ms for ${result.rows} rows (${ROWS} expected)`,
      );
      console.log(
        `parent renders: ${result.appMount} at mount, ${result.appScroll} after 40 scroll frames`,
      );
      console.log(
        `row re-renders during those 40 scroll frames: ${result.rowRenders}`,
      );
    } finally {
      chrome.kill("SIGKILL");
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

function serveDir(dir) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url || "/").split("?")[0]);
      const file = join(dir, name === "/" ? "index.html" : name.slice(1));
      try {
        const body = readFileSync(file);
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(file)] || "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({
        port: server.address().port,
        close: () => server.close(),
      });
    });
  });
}

async function waitForDevtools(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      return new WebSocket(info.webSocketDebuggerUrl);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Chrome devtools endpoint never came up");
}

function evaluateFirstFrame(browserWs, url) {
  return new Promise((resolvePromise, rejectPromise) => {
    let id = 0;
    const pending = new Map();
    const send = (sessionId, method, params) =>
      new Promise((res) => {
        const msgId = ++id;
        pending.set(msgId, res);
        browserWs.send(JSON.stringify({ id: msgId, method, params, sessionId }));
      });

    browserWs.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
    });
    browserWs.addEventListener("error", rejectPromise);

    browserWs.addEventListener("open", async () => {
      const { targetId } = await send(undefined, "Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await send(undefined, "Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await send(sessionId, "Runtime.enable");
      await send(sessionId, "Page.enable");
      await send(sessionId, "Page.navigate", { url });

      for (let i = 0; i < 300; i++) {
        const evalRes = await send(sessionId, "Runtime.evaluate", {
          expression:
            "({ms: window.__FIRST_FRAME_MS ?? null, rows: window.__ROW_COUNT ?? null, appMount: window.__APP_RENDERS_AT_MOUNT__ ?? null, appScroll: window.__APP_RENDERS_AFTER_SCROLL__ ?? null, rowRenders: window.__ROW_RENDERS_DURING_SCROLL__ ?? null, err: window.__ERR__ ?? null})",
          returnByValue: true,
        });
        const value = evalRes?.result?.value;
        if (value?.err) {
          rejectPromise(new Error("harness error: " + value.err));
          return;
        }
        if (value?.appScroll != null) {
          resolvePromise(value);
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      rejectPromise(new Error("first-frame value never appeared"));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
