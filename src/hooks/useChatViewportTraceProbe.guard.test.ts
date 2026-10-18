import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The trace is dev-only diagnostics and off by default: a production session
 * must pay nothing for it. The probe must therefore bail out of its effect
 * before it installs a listener, an observer or an rAF loop when
 * `chatViewportTraceEnabled()` is false. This guard reads the source because
 * the property is about what the effect *does not* do, which a jsdom run of the
 * hook cannot observe cheaply.
 */
const source = readFileSync(
  resolve(__dirname, "useChatViewportTraceProbe.ts"),
  "utf8",
);

describe("chat viewport probe cost guard", () => {
  it("returns before touching the DOM, listeners or rAF when the trace is off", () => {
    // Arrange
    const effectStart = source.indexOf("useEffect(() => {");
    const guard = source.indexOf(
      "if (!chatViewportTraceEnabled()) return;",
      effectStart,
    );

    // Assert — the guard exists, sits first in the effect, and precedes every
    // side effect the effect installs.
    expect(effectStart).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(effectStart);
    for (const sideEffect of [
      "addEventListener",
      "new MutationObserver",
      "requestAnimationFrame(frame)",
      "window.setInterval",
      "window.setTimeout",
    ]) {
      const at = source.indexOf(sideEffect, effectStart);
      expect(at, `${sideEffect} is installed`).toBeGreaterThan(effectStart);
      expect(at, `${sideEffect} is behind the guard`).toBeGreaterThan(guard);
    }
  });
});
