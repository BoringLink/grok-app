#!/usr/bin/env node
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
 * for the macOS client's own first frame; it bounds the frontend work. The
 * ledger's own footprint at this scale is reported by `measure-chat-scroll.mjs`
 * and, in the packaged client, on the trace heartbeat.
 *
 *   node scripts/measure-chat-first-frame.mjs [rows]
 */

import { withChromeHarness } from "./lib/chatHeadlessHarness.mjs";

const ROWS = Number(process.argv[2] || 10_000);

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

try {
  const result = await withChromeHarness(ENTRY, (page) =>
    page.waitFor(
      "({ms: window.__FIRST_FRAME_MS ?? null, rows: window.__ROW_COUNT ?? null, appMount: window.__APP_RENDERS_AT_MOUNT__ ?? null, appScroll: window.__APP_RENDERS_AFTER_SCROLL__ ?? null, rowRenders: window.__ROW_RENDERS_DURING_SCROLL__ ?? null, err: window.__ERR__ ?? null})",
      (value) => value?.appScroll != null,
    ),
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
} catch (error) {
  console.error(
    `chat-first-frame: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
