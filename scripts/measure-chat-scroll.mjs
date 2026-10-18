#!/usr/bin/env node
/**
 * Measure the per-frame cost and the position-write budget of a 10k-row chat
 * conversation.
 *
 * This extends `measure-chat-first-frame.mjs`: it mounts the *real* resident
 * list plus the *real* viewport controller (the single transcript writer), then
 * drives two phases over the conversation and reports, per phase:
 *
 *   - the per-frame cost from a CDP trace: the `FireAnimationFrame` callback
 *     durations (the app's paint-boundary work) and, beside them, the
 *     `UpdateLayoutTree` + `Layout` durations, read against the 120Hz budget of
 *     8.3ms;
 *   - the transcript position writes each frame carried, from the controller's
 *     own write counter.
 *
 * The first phase ("read") escapes the tail and scrolls up through history;
 * the second ("stream") re-pins and grows the content every frame, which is the
 * case the "≤ 1 layout read + ≤ 1 scrollTop write per frame" budget is about.
 *
 * It runs Chromium in headless mode, not the packaged WKWebView app, so it
 * bounds the frontend work; it does not report the macOS client's own frame
 * delivery. See docs/llm-wiki/chat-viewport-budget.md.
 *
 *   node scripts/measure-chat-scroll.mjs [rows] [readSteps] [streamFrames]
 */

import { withChromeHarness } from "./lib/chatHeadlessHarness.mjs";

const ROWS = Number(process.argv[2] || 10_000);
const READ_STEPS = Number(process.argv[3] || 200);
const READ_STEP_PX = 240;
const STREAM_FRAMES = Number(process.argv[4] || 120);

const ENTRY = `
import { createRoot } from "react-dom/client";
import { createElement, memo, useRef, useSyncExternalStore } from "react";
import { useChatResidentList } from "@/hooks/useChatResidentList";
import { useChatViewportController } from "@/hooks/useChatViewportController";
import { chatViewportWriteStats, setChatViewportTraceEnabled } from "@/lib/chatViewportTrace";

const ROWS = ${ROWS};
const READ_STEPS = ${READ_STEPS};
const READ_STEP_PX = ${READ_STEP_PX};
const STREAM_FRAMES = ${STREAM_FRAMES};

setChatViewportTraceEnabled(true);

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

const Row = memo(function Row({ index, bandStore, rowHeight, measureRef }) {
  const rich = useSyncExternalStore(
    bandStore.subscribeFor(index),
    () => bandStore.isRich(index),
  );
  if (!rich) {
    return createElement("div", {
      "data-virt-index": index,
      "data-virt-shell": "",
      style: { height: rowHeight(index), contain: "strict" },
    });
  }
  return createElement(
    "div",
    { "data-virt-index": index, ref: measureRef(index) },
    createElement("p", null, "row " + index),
  );
});

function App() {
  const ctl = useChatViewportController({ conversationKey: "bench" });
  const { viewportRef, contentRef, isPinnedRef, controller } = ctl;
  const { bandStore, rowHeight, measureRef } = useChatResidentList({
    itemCount: ROWS,
    getEstimateHeight: () => 60,
    viewportRef,
    isPinnedRef,
    controller,
    resetKey: "bench",
  });
  window.__CTL__ = ctl;
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push(
      createElement(Row, { key: i, index: i, bandStore, rowHeight, measureRef }),
    );
  }
  return createElement(
    "div",
    {
      ref: viewportRef,
      id: "viewport",
      style: { height: "100vh", overflowY: "auto", overflowAnchor: "none" },
    },
    createElement("div", { ref: contentRef, id: "content" }, rows),
  );
}

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
const t0 = performance.now();
root.render(createElement(App));

async function boot() {
  await frame();
  await frame();
  window.__FIRST_FRAME_MS__ = performance.now() - t0;

  const vp = document.getElementById("viewport");
  const content = document.getElementById("content");
  let prevWrites = chatViewportWriteStats().writes;

  window.__PHASES__ = {
    meta() {
      const ledger = window.__CTL__.controller.ledger();
      return {
        rows: ROWS,
        firstFrameMs: window.__FIRST_FRAME_MS__,
        ledgerMemoryBytes: ledger.stats().memoryBytes,
        ledgerRows: ledger.rowCount(),
        scrollHeight: vp.scrollHeight,
        clientHeight: vp.clientHeight,
      };
    },
    async read() {
      // Escape the tail with a real wheel gesture, then walk up through history.
      vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      await frame();
      vp.scrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);
      await frame();
      prevWrites = chatViewportWriteStats().writes;
      const writes = [];
      let fromTop = 0;
      let toTop = 0;
      for (let k = 0; k < READ_STEPS; k++) {
        vp.scrollTop = Math.max(0, vp.scrollTop - READ_STEP_PX);
        vp.dispatchEvent(new Event("scroll"));
        await frame();
        const w = chatViewportWriteStats().writes;
        writes.push(w - prevWrites);
        prevWrites = w;
        if (k === 0) fromTop = Math.round(vp.scrollTop);
        toTop = Math.round(vp.scrollTop);
      }
      return { writes, fromTop, toTop, escaped: window.__CTL__.escapedRef.current };
    },
    async stream() {
      // Re-pin to the tail, then grow the content every frame — the streaming
      // case the one-restore-per-frame budget is measured on.
      window.__CTL__.scrollToBottom("instant", "bench:stream");
      await frame();
      prevWrites = chatViewportWriteStats().writes;
      const writes = [];
      for (let k = 0; k < STREAM_FRAMES; k++) {
        const grow = document.createElement("div");
        grow.style.height = "30px";
        content.appendChild(grow);
        await frame();
        const w = chatViewportWriteStats().writes;
        writes.push(w - prevWrites);
        prevWrites = w;
      }
      return { writes, pinned: window.__CTL__.isPinnedRef.current };
    },
  };
  window.__HARNESS_READY__ = true;
}
boot();
`;

/**
 * Renderer main-thread ids, from the `CrRendererMain` thread-name metadata.
 * Browser-process and worker threads carry the same task names, so every
 * per-frame metric is restricted to these.
 */
function rendererThreads(events) {
  const tids = new Set();
  for (const event of events) {
    if (
      event.ph === "M" &&
      event.name === "thread_name" &&
      event.args?.name === "CrRendererMain"
    ) {
      tids.add(`${event.pid}:${event.tid}`);
    }
  }
  return tids;
}

/**
 * Per-frame callback cost (ms).
 *
 * A frame's cost is the duration of its `FireAnimationFrame` — the
 * requestAnimationFrame callbacks the application schedules (the resident
 * list's band recompute, the controller's restore latch) plus the work they run
 * before returning. This is the main-thread work the app owns each frame; it is
 * read against the 120 Hz budget of 8.3ms. (The React commit for the rows whose
 * band membership flipped runs on the microtask checkpoint after the callback
 * and is not included; the layout it forces is measured separately.)
 */
function frameCallbackMillis(events) {
  const mainThreads = rendererThreads(events);
  return events
    .filter(
      (event) =>
        event.ph === "X" &&
        event.name === "FireAnimationFrame" &&
        mainThreads.has(`${event.pid}:${event.tid}`) &&
        event.dur != null,
    )
    .map((event) => Number(event.dur) / 1000);
}

function distribution(values) {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p90: 0, p99: 0, max: 0, over: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    over: sorted.filter((value) => value > 8.3).length,
  };
}

/** Durations (ms) of the named renderer main-thread events, one value each. */
function namedMillis(events, names) {
  const mainThreads = rendererThreads(events);
  return events
    .filter(
      (event) =>
        event.ph === "X" &&
        names.has(event.name) &&
        mainThreads.has(`${event.pid}:${event.tid}`) &&
        event.dur != null,
    )
    .map((event) => Number(event.dur) / 1000);
}

const ms = (value) => `${value.toFixed(2)}ms`;

function printFrameCost(label, events) {
  const values = frameCallbackMillis(events);
  const d = distribution(values);
  console.log(
    `${label}: ${d.count} frames, min ${ms(d.min)}, p50 ${ms(d.p50)}, p90 ${ms(d.p90)}, p99 ${ms(d.p99)}, max ${ms(d.max)}; frames over 8.3ms: ${d.over}`,
  );
}

function printLayoutCost(label, events) {
  const d = distribution(
    namedMillis(events, new Set(["UpdateLayoutTree", "Layout"])),
  );
  console.log(
    `${label}: ${d.count} records, min ${ms(d.min)}, p50 ${ms(d.p50)}, p90 ${ms(d.p90)}, p99 ${ms(d.p99)}, max ${ms(d.max)}; over 8.3ms: ${d.over}`,
  );
}

function printWrites(label, result) {
  const max = Math.max(0, ...result.writes);
  const over = result.writes.filter((w) => w > 1).length;
  console.log(
    `${label}: frames ${result.writes.length}, max writes/frame ${max}, frames over 1 write ${over}`,
  );
}

const output = await withChromeHarness(ENTRY, async (page) => {
  await page.waitFor("window.__HARNESS_READY__ === true", (value) => value === true);
  const meta = await page.evaluate("__PHASES__.meta()");

  const stopRead = await page.startTracing();
  const read = await page.evaluate("__PHASES__.read()", { awaitPromise: true });
  const readEvents = await stopRead();

  const stopStream = await page.startTracing();
  const stream = await page.evaluate("__PHASES__.stream()", { awaitPromise: true });
  const streamEvents = await stopStream();

  return { meta, read, readEvents, stream, streamEvents };
}).catch((error) => {
  console.error(
    `chat-scroll: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
  return null;
});

if (output) {
  console.log(`rows: ${output.meta.rows} (ledger ${output.meta.ledgerRows})`);
  console.log(
    `trace events: read ${output.readEvents.length}, stream ${output.streamEvents.length}`,
  );
  console.log(
    `conversation height: ${output.meta.scrollHeight}px, viewport ${output.meta.clientHeight}px`,
  );
  console.log(`first-frame: ${output.meta.firstFrameMs.toFixed(0)}ms`);
  console.log(
    `ledger memory: ${(output.meta.ledgerMemoryBytes / 1024).toFixed(1)}KB (${output.meta.ledgerMemoryBytes} bytes)`,
  );
  printFrameCost("read-phase frame cost", output.readEvents);
  printLayoutCost("read-phase style+layout", output.readEvents);
  console.log(
    `read phase: escaped=${output.read.escaped}, ${output.read.fromTop}px -> ${output.read.toTop}px`,
  );
  printWrites("read-phase writes", output.read);
  printFrameCost("stream-phase frame cost", output.streamEvents);
  printLayoutCost("stream-phase style+layout", output.streamEvents);
  console.log(`stream phase: pinned=${output.stream.pinned}`);
  printWrites("stream-phase writes", output.stream);
}
