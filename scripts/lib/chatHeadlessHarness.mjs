/**
 * Shared plumbing for the headless-Chrome chat-viewport harnesses:
 * `measure-chat-first-frame.mjs`, `measure-chat-scroll.mjs` and
 * `run-chat-viewport-scenarios.mjs`.
 *
 * Each harness bundles a small entry against the repo's *real* modules (the
 * resident list, the viewport controller, the layout ledger, the trace) with
 * vite, serves it to headless Chromium and drives the page over the DevTools
 * Protocol. The entry publishes its findings on `window`; the harness reads
 * them back.
 *
 * Scope limit (see docs/llm-wiki/chat-viewport-budget.md): this is Chromium in
 * headless mode, not the packaged WKWebView app. It bounds the frontend work;
 * it does not reproduce the macOS client's own frame delivery.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

const PAGE_HTML = `<!doctype html><html><body>
<script>
window.__ERR__ = null;
window.addEventListener("error", (e) => { window.__ERR__ = String((e.error && e.error.stack) || e.message); });
window.addEventListener("unhandledrejection", (e) => { window.__ERR__ = String((e.reason && e.reason.stack) || e.reason); });
</script>
<script type="module" src="./harness.js"></script>
</body></html>`;

/**
 * Write `entry` as an ES module and bundle it against the repo's source with
 * vite into a scratch dir under `node_modules/.cache` (kept inside the repo so
 * bare imports and the `@/` alias resolve). Returns the dir and a disposer.
 */
export async function buildHarness(entry, { define = {} } = {}) {
  const cacheRoot = join(REPO, "node_modules/.cache");
  mkdirSync(cacheRoot, { recursive: true });
  const dir = mkdtempSync(join(cacheRoot, "chat-harness-"));
  writeFileSync(join(dir, "entry.jsx"), entry);
  const { build } = await import("vite");
  await build({
    root: REPO,
    logLevel: "warn",
    resolve: { alias: { "@": join(REPO, "src") } },
    esbuild: { jsx: "automatic" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      ...define,
    },
    build: {
      outDir: dir,
      emptyOutDir: false,
      minify: false,
      lib: { entry: join(dir, "entry.jsx"), formats: ["es"], fileName: "harness" },
    },
  });
  writeFileSync(join(dir, "index.html"), PAGE_HTML);
  return {
    dir,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Serve `dir` on an ephemeral loopback port. */
export function serveDir(dir) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url || "/").split("?")[0]);
      const file = join(dir, name === "/" ? "index.html" : name.slice(1));
      try {
        const body = readFileSync(file);
        res.writeHead(200, {
          "content-type":
            CONTENT_TYPES[extname(file)] || "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ port: server.address().port, close: () => server.close() });
    });
  });
}

/**
 * Launch headless Chrome with an OS-assigned remote-debugging port.
 *
 * `--remote-debugging-port=0` lets the OS pick a free port (a fixed or random
 * range can collide when two harnesses run at once); Chrome writes the chosen
 * port to `DevToolsActivePort` in the user-data dir, which this polls until it
 * appears.
 */
export async function launchChrome(dir) {
  const profileDir = join(dir, "profile");
  const child = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "about:blank",
  ]);
  const portFile = join(profileDir, "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 200; i++) {
    try {
      const lines = readFileSync(portFile, "utf8").split("\n");
      const parsed = Number(lines[0]);
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
        break;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (port == null) {
    child.kill("SIGKILL");
    throw new Error("Chrome never reported a devtools port");
  }
  return {
    port,
    kill: () => child.kill("SIGKILL"),
  };
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

/**
 * A single page target driven over CDP (flatten sessions). Request/response is
 * matched by id; events are matched by method name so `Tracing` and page
 * events can be consumed without a full client.
 */
class CdpPage {
  /** Wire the browser websocket: dispatch responses by id, events by method. */
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.globalHandlers = new Set();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        for (const handler of this.eventHandlers.get(msg.method) ?? []) {
          handler(msg.params);
        }
        for (const handler of this.globalHandlers) handler(msg);
      }
    });
  }

  /** Send one CDP command; resolves with the full reply message. */
  send(method, params, sessionId) {
    return new Promise((resolvePromise) => {
      const msgId = ++this.id;
      this.pending.set(msgId, resolvePromise);
      this.ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
    });
  }

  /** Subscribe to a CDP event method; returns an unsubscribe. */
  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method).add(handler);
    return () => this.eventHandlers.get(method)?.delete(handler);
  }

  /** Subscribe to every CDP event; returns an unsubscribe. */
  onEvent(handler) {
    this.globalHandlers.add(handler);
    return () => this.globalHandlers.delete(handler);
  }

  /** Create the page target, attach a flat session and navigate to `url`. */
  async open(url) {
    await new Promise((r) => this.ws.addEventListener("open", r, { once: true }));
    const { result } = await this.send("Target.createTarget", { url: "about:blank" });
    const { result: attached } = await this.send("Target.attachToTarget", {
      targetId: result.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.send("Runtime.enable", {}, this.sessionId);
    await this.send("Page.enable", {}, this.sessionId);
    await this.send("Page.navigate", { url }, this.sessionId);
  }

  /**
   * Evaluate `expression` in the page and return its value by value. Rethrows a
   * page exception and fails on a timeout.
   */
  async evaluate(expression, { awaitPromise = false, timeoutMs = 120_000 } = {}) {
    const res = await Promise.race([
      this.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise },
        this.sessionId,
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("evaluate timed out")), timeoutMs),
      ),
    ]);
    const value = res?.result?.result?.value;
    if (res?.result?.exceptionDetails) {
      throw new Error(
        "page exception: " +
          JSON.stringify(res.result.exceptionDetails.exception?.description ?? ""),
      );
    }
    return value;
  }

  /** Poll `expression` until `predicate(value)` is true (or fail). */
  async waitFor(expression, predicate, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression);
      if (value?.err) throw new Error("harness error: " + value.err);
      if (predicate(value)) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`waitFor never satisfied: ${expression}`);
  }

  /** Start a devtools.timeline trace; returns a stop() that resolves events. */
  async startTracing() {
    const events = [];
    const off = this.on("Tracing.dataCollected", (params) => {
      if (params.value) events.push(...params.value);
    });
    let complete;
    const done = new Promise((r) => (complete = r));
    const offComplete = this.on("Tracing.tracingComplete", () => complete());
    await this.send(
      "Tracing.start",
      {
        // `toplevel` carries the RunTask envelopes (the per-frame main-thread
        // tasks); `devtools.timeline` carries the layout / paint / script
        // children they contain.
        categories: "toplevel,devtools.timeline",
        transferMode: "ReportEvents",
      },
      this.sessionId,
    );
    return async () => {
      await this.send("Tracing.end", {}, this.sessionId);
      await done;
      off();
      offComplete();
      return events;
    };
  }

  /** Close the browser websocket. */
  close() {
    this.ws.close();
  }
}

/**
 * Build, serve, launch and drive one harness page. `run` receives the page and
 * the page URL and returns what the caller wants to print; the scratch dir,
 * the server and Chrome are torn down afterwards.
 */
export async function withChromeHarness(entry, run, { define } = {}) {
  const built = await buildHarness(entry, { define });
  let server = null;
  let chrome = null;
  try {
    server = await serveDir(built.dir);
    chrome = await launchChrome(built.dir);
    const ws = await waitForDevtools(chrome.port);
    const page = new CdpPage(ws);
    await page.open(`http://127.0.0.1:${server.port}/index.html`);
    return await run(page);
  } finally {
    chrome?.kill();
    server?.close();
    built.dispose();
  }
}
