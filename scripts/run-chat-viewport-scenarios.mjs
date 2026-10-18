#!/usr/bin/env node
/**
 * Run the chat-viewport delivery's synthetic scenarios and assert on the
 * resulting trace event sequence.
 *
 * Spec (`docs/plans/2026-10-18-chat-viewport-scroll-spec.md`, Testing
 * Decisions, seam two) asks for scriptable scenarios that run a real session
 * stream and assert on the log's event sequence. This drives the *real*
 * viewport controller (`useChatViewportController` + the pure planner) in
 * headless Chrome over real DOM, real layout and real ResizeObserver /
 * MutationObserver delivery, and checks each scenario against the trace ring
 * (`src/lib/chatViewportTrace.ts`) plus the DOM's own geometry:
 *
 *   1.  continuous output           7.  occlusion and restore (pinned)
 *   2.  a collapse above            8.  occlusion and restore (escaped)
 *   3.  a re-growth above           9.  the per-frame write budget
 *   4.  small repeated reflow       10. a window resize
 *   5.  a gesture-free upward move  11. a nested scroller expanding
 *   6.  a real wheel upward         12. a media decode
 *
 * It is a repeatable artifact: exit code 0 when every scenario passes, 1
 * otherwise. Nothing is left running — the harness tears Chrome, the server
 * and the scratch dir down. When the dev trace is off the app still runs; this
 * script turns it on inside its own page only.
 *
 *   node scripts/run-chat-viewport-scenarios.mjs
 */

import { withChromeHarness } from "./lib/chatHeadlessHarness.mjs";

const ENTRY = `
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { useChatViewportController } from "@/hooks/useChatViewportController";
import {
  chatViewportTraceEvents,
  chatViewportWriteStats,
  resetChatViewportTrace,
  setChatViewportTraceEnabled,
} from "@/lib/chatViewportTrace";

// Dev-only, this page only: the trace is what the scenarios assert on.
setChatViewportTraceEnabled(true);

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const frames = async (n) => { for (let i = 0; i < n; i += 1) await frame(); };
const contentEnd = (vp) => vp.scrollHeight - vp.clientHeight;
const distFromEnd = (vp) => contentEnd(vp) - vp.scrollTop;

function App() {
  const ctl = useChatViewportController({ conversationKey: "scenarios" });
  window.__CTL__ = ctl;
  return createElement(
    "div",
    {
      ref: ctl.viewportRef,
      id: "viewport",
      style: {
        height: "600px",
        width: "800px",
        overflowY: "auto",
        overflowAnchor: "none",
      },
    },
    createElement(
      "div",
      { ref: ctl.contentRef, id: "content" },
      createElement("div", { id: "above", style: { height: "800px" } }, "above"),
      createElement("div", { id: "anchorBlock", style: { height: "400px" } }, "anchor"),
      createElement(
        "div",
        { id: "nested", style: { height: "300px", overflowY: "auto" } },
        createElement("div", { id: "nestedInner", style: { height: "400px" } }, "inner"),
      ),
      createElement("div", { id: "below", style: { height: "2000px" } }, "below"),
    ),
  );
}

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
root.render(createElement(App));

const results = [];
window.__SCENARIO_RESULTS__ = results;
function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

async function pin() {
  window.__CTL__.scrollToBottom("instant", "scn:pin");
  await frames(2);
}

/** Escape the tail and put #anchorBlock at the viewport top; returns its ref. */
async function escapeOntoAnchor() {
  const vp = document.getElementById("viewport");
  vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  await frame();
  // #above is 800px, so a scrollTop of ~740 puts #anchorBlock at the top.
  vp.scrollTop = 740;
  vp.dispatchEvent(new Event("scroll"));
  await frame();
  return window.__CTL__.anchorRef.current;
}

const anchorShift = () => {
  const a = window.__CTL__.anchorRef.current;
  if (!a || !a.element || !a.element.isConnected) return null;
  return a.element.getBoundingClientRect().top - a.screenTop;
};

const pinEvents = () =>
  chatViewportTraceEvents().filter((event) => event.kind === "pin");
const kinds = () => chatViewportTraceEvents().map((event) => event.kind);

/**
 * Drive Page Visibility directly. The controller reads document.hidden, so this
 * is the same signal a hidden window delivers; clearHidden removes the override
 * so a later scenario runs against the real document.
 */
function setHidden(value) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
function clearHidden() {
  delete document.hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

window.__SCENARIOS__ = {
  async continuousOutput() {
    resetChatViewportTrace();
    await pin();
    const vp = document.getElementById("viewport");
    const below = document.getElementById("below");
    let worst = 0;
    for (let k = 0; k < 20; k += 1) {
      below.style.height = 2000 + (k + 1) * 50 + "px";
      void vp.scrollHeight;
      await frame();
      worst = Math.max(worst, Math.abs(distFromEnd(vp)));
    }
    const escapedPins = pinEvents().filter((event) => event.escaped);
    record(
      "continuous output stays pinned at the end",
      window.__CTL__.isPinnedRef.current && worst <= 0.5 && escapedPins.length === 0,
      "worst distance to end=" + worst.toFixed(2) + "px, escapes=" + escapedPins.length,
    );
  },

  async collapseAbove() {
    resetChatViewportTrace();
    await pin();
    await escapeOntoAnchor();
    const above = document.getElementById("above");
    above.style.height = "200px";
    await frames(3);
    const shift = anchorShift();
    record(
      "a collapse above does not move the escaped anchor",
      shift != null && Math.abs(shift) <= 0.5 && window.__CTL__.escapedRef.current,
      "anchor shift=" + (shift == null ? "null" : shift.toFixed(2) + "px"),
    );
  },

  async regrowthAbove() {
    resetChatViewportTrace();
    await pin();
    await escapeOntoAnchor();
    const above = document.getElementById("above");
    above.style.height = "200px";
    await frames(2);
    above.style.height = "800px";
    await frames(3);
    const shift = anchorShift();
    record(
      "a re-growth above does not move the escaped anchor",
      shift != null && Math.abs(shift) <= 0.5,
      "anchor shift=" + (shift == null ? "null" : shift.toFixed(2) + "px"),
    );
  },

  async smallRepeatedReflow() {
    resetChatViewportTrace();
    await pin();
    const vp = document.getElementById("viewport");
    const below = document.getElementById("below");
    let worst = 0;
    for (let k = 0; k < 30; k += 1) {
      below.style.height = 2000 + (k % 2 === 0 ? 3 : -3) + "px";
      void vp.scrollHeight;
      await frame();
      worst = Math.max(worst, Math.abs(distFromEnd(vp)));
    }
    const escapedPins = pinEvents().filter((event) => event.escaped);
    record(
      "small repeated reflow keeps the pin",
      window.__CTL__.isPinnedRef.current && escapedPins.length === 0,
      "escapes=" + escapedPins.length + ", worst end distance=" + worst.toFixed(2),
    );
  },

  async gestureFreeUpward() {
    resetChatViewportTrace();
    await pin();
    const vp = document.getElementById("viewport");
    const base = contentEnd(vp);
    // First gesture-free upward move at a stable height: a layout clamp.
    vp.scrollTop = base - 20;
    vp.dispatchEvent(new Event("scroll"));
    await frame();
    const pinnedAfterFirst = window.__CTL__.isPinnedRef.current;
    // Second one within the streak window is a scrollbar drag — a real escape.
    vp.scrollTop = base - 40;
    vp.dispatchEvent(new Event("scroll"));
    await frame();
    const escapedAfterSecond = window.__CTL__.escapedRef.current;
    const causes = pinEvents().map((event) => event.cause);
    record(
      "a gesture-free upward move is a clamp, then a drag",
      pinnedAfterFirst && escapedAfterSecond && causes.includes("scrollbar"),
      "pinned after 1st=" + pinnedAfterFirst + ", escaped after 2nd=" + escapedAfterSecond,
    );
  },

  async realWheelUpward() {
    resetChatViewportTrace();
    await pin();
    const vp = document.getElementById("viewport");
    vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    await frame();
    const causes = pinEvents().map((event) => event.cause);
    record(
      "a real wheel upward escapes the tail",
      window.__CTL__.escapedRef.current && causes.includes("wheel"),
      "escaped=" + window.__CTL__.escapedRef.current + ", causes=" + causes.join(","),
    );
  },

  async occlusionRestore() {
    resetChatViewportTrace();
    await pin();
    const vp = document.getElementById("viewport");
    const below = document.getElementById("below");
    setHidden(true);
    await frame();
    // Output continues while the window is covered.
    below.style.height = "2600px";
    void vp.scrollHeight;
    await frame();
    setHidden(false);
    await frames(2);
    const occlusionEvents = chatViewportTraceEvents().filter(
      (event) => event.kind === "occlusion",
    );
    clearHidden();
    record(
      "restore lands back at the end after occlusion",
      Math.abs(distFromEnd(vp)) <= 0.5 &&
        occlusionEvents.some((event) => event.state === "exit"),
      "distance to end=" + distFromEnd(vp).toFixed(2) + "px, occlusion events=" +
        occlusionEvents.length,
    );
  },

  async escapeOcclusionRestore() {
    resetChatViewportTrace();
    await pin();
    await escapeOntoAnchor();
    const above = document.getElementById("above");
    setHidden(true);
    await frame();
    // A block above the anchor reflows while the window is covered.
    above.style.height = "300px";
    await frames(2);
    setHidden(false);
    await frames(2);
    const shift = anchorShift();
    clearHidden();
    record(
      "occlusion restore holds the escaped anchor, not the end",
      window.__CTL__.escapedRef.current && shift != null && Math.abs(shift) <= 0.5,
      "escaped=" + window.__CTL__.escapedRef.current + ", anchor shift=" +
        (shift == null ? "null" : shift.toFixed(2) + "px"),
    );
  },

  async writeBudget() {
    resetChatViewportTrace();
    await pin();
    const vp = document.getElementById("viewport");
    const below = document.getElementById("below");
    let prev = chatViewportWriteStats().writes;
    let maxWrites = 0;
    const sampleWrites = () => {
      const writes = chatViewportWriteStats().writes;
      maxWrites = Math.max(maxWrites, writes - prev);
      prev = writes;
    };
    // Pinned streaming: the controller restores the end on every growth.
    for (let k = 0; k < 50; k += 1) {
      below.style.height = 2000 + (k + 1) * 20 + "px";
      void vp.scrollHeight;
      await frame();
      sampleWrites();
    }
    // Escaped read scroll: the controller holds the anchor.
    vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    await frame();
    prev = chatViewportWriteStats().writes;
    for (let k = 0; k < 50; k += 1) {
      vp.scrollTop = Math.max(0, vp.scrollTop - 20);
      vp.dispatchEvent(new Event("scroll"));
      await frame();
      sampleWrites();
    }
    record(
      "no frame carries more than one transcript write",
      maxWrites <= 1,
      "max writes/frame=" + maxWrites,
    );
  },

  async windowResize() {
    resetChatViewportTrace();
    await pin();
    const vp = document.getElementById("viewport");
    vp.style.height = "700px";
    await frames(3);
    const hasResize = kinds().includes("viewport-size");
    record(
      "a window resize re-follows the end",
      hasResize && Math.abs(distFromEnd(vp)) <= 0.5,
      "viewport-size event=" + hasResize + ", distance to end=" + distFromEnd(vp).toFixed(2),
    );
  },

  async nestedScroller() {
    resetChatViewportTrace();
    await pin();
    await escapeOntoAnchor();
    const inner = document.getElementById("nestedInner");
    const before = window.__CTL__.escapedRef.current ? 1 : 0;
    inner.style.height = "1200px";
    await frames(3);
    const shift = anchorShift();
    record(
      "a nested scroller expanding does not move the outer anchor",
      before === 1 && shift != null && Math.abs(shift) <= 0.5,
      "anchor shift=" + (shift == null ? "null" : shift.toFixed(2) + "px"),
    );
  },

  async mediaDecode() {
    resetChatViewportTrace();
    await pin();
    // Put a not-yet-loaded image in #above, then escape onto the anchor below
    // it. When the image finishes decode its rendered height grows without a
    // DOM mutation carrying the size — the content ResizeObserver path.
    const above = document.getElementById("above");
    const img = document.createElement("img");
    img.style.width = "300px";
    img.style.display = "block";
    img.src =
      "data:image/svg+xml," +
      encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='300' height='400'></svg>");
    above.appendChild(img);
    await frame();
    await pin();
    await escapeOntoAnchor();
    // Wait for the decode: the image grows from 0 to 400px above the anchor.
    await new Promise((resolve) => {
      if (img.complete) resolve();
      else img.addEventListener("load", resolve, { once: true });
    });
    await frames(3);
    const shift = anchorShift();
    const imageHeight = img.getBoundingClientRect().height;
    record(
      "a media decode above the anchor does not move it",
      imageHeight > 0 && shift != null && Math.abs(shift) <= 0.5,
      "decoded height=" + imageHeight.toFixed(0) + "px, shift=" +
        (shift == null ? "null" : shift.toFixed(2) + "px"),
    );
  },
};

async function boot() {
  await frames(3);
  // Restore the state a scenario may have left behind between scenarios by
  // re-pinning and resetting the blocks the next one mutates.
  const reset = async () => {
    clearHidden();
    document.getElementById("above").style.height = "800px";
    document.getElementById("below").style.height = "2000px";
    document.getElementById("nestedInner").style.height = "400px";
    const img = document.querySelector("#above img");
    if (img) img.remove();
    await pin();
  };
  window.__SCENARIOS__.reset = reset;
  window.__HARNESS_READY__ = true;
}
boot();
`;

const output = await withChromeHarness(
  ENTRY,
  async (page) => {
    await page.waitFor(
      "window.__HARNESS_READY__ === true",
      (value) => value === true,
    );
    const names = [
      "continuousOutput",
      "collapseAbove",
      "regrowthAbove",
      "smallRepeatedReflow",
      "gestureFreeUpward",
      "realWheelUpward",
      "occlusionRestore",
      "escapeOcclusionRestore",
      "writeBudget",
      "windowResize",
      "nestedScroller",
      "mediaDecode",
    ];
    const results = [];
    for (const name of names) {
      await page.evaluate("__SCENARIOS__.reset()", { awaitPromise: true });
      await page.evaluate("__SCENARIO_RESULTS__.length = 0");
      await page.evaluate(`__SCENARIOS__.${name}()`, { awaitPromise: true });
      results.push(...(await page.evaluate("__SCENARIO_RESULTS__")));
    }
    return results;
  },
  {
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env.DEV": "true",
    },
  },
).catch((error) => {
  console.error(
    `chat-scenarios: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
  return null;
});

if (output) {
  let failed = 0;
  for (const result of output) {
    const mark = result.ok ? "PASS" : "FAIL";
    if (!result.ok) failed += 1;
    console.log(`${mark}  ${result.name} — ${result.detail}`);
  }
  console.log(`${output.length - failed}/${output.length} scenarios passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
