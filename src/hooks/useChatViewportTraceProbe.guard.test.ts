/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setChatViewportTraceEnabled } from "@/lib/chatViewportTrace";
import { useChatViewportTraceProbe } from "./useChatViewportTraceProbe";

/**
 * The trace is dev-only diagnostics and off by default: a production session
 * must pay nothing for it. The probe must therefore bail out of its effect
 * before it installs a listener, an observer or an rAF loop when
 * `chatViewportTraceEnabled()` is false.
 *
 * Two checks: a source scan that pins the guard as the effect's first
 * statement (with side-effect prefixes, so renaming the rAF callback cannot
 * defeat it), and a jsdom mount that proves nothing is actually installed.
 * The source scan cannot see an installer hidden inside a helper the effect
 * calls; the runtime check is what covers that case for the probes it spies on.
 */
const source = readFileSync(
  resolve(__dirname, "useChatViewportTraceProbe.ts"),
  "utf8",
);

const EFFECT_HEAD = "useEffect(() => {";
const GUARD = "if (!chatViewportTraceEnabled()) return;";

afterEach(() => {
  cleanup();
  setChatViewportTraceEnabled(null);
  vi.restoreAllMocks();
});

describe("chat viewport probe cost guard", () => {
  it("bails out as the first statement of the effect when the trace is off", () => {
    // Arrange
    const effectStart = source.indexOf(EFFECT_HEAD);
    expect(effectStart).toBeGreaterThan(-1);

    // Assert — nothing can run before the guard, so no setup leaks ahead of it.
    const firstStatement = source
      .slice(effectStart + EFFECT_HEAD.length)
      .match(/^\s*([^\n]+)/)?.[1]
      ?.trim();
    expect(firstStatement).toBe(GUARD);
  });

  it("keeps every side effect behind the guard", () => {
    // Arrange
    const effectStart = source.indexOf(EFFECT_HEAD);
    const guard = source.indexOf(GUARD, effectStart);

    // Assert — the markers are prefixes, not exact calls, so renaming the rAF
    // callback does not break the check.
    expect(effectStart).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(effectStart);
    for (const sideEffect of [
      "addEventListener",
      "new MutationObserver",
      "requestAnimationFrame(",
      "window.setInterval",
      "window.setTimeout",
    ]) {
      const at = source.indexOf(sideEffect, effectStart);
      expect(at, `${sideEffect} is installed`).toBeGreaterThan(effectStart);
      expect(at, `${sideEffect} is behind the guard`).toBeGreaterThan(guard);
    }
  });

  it("installs nothing at runtime when the trace is off", () => {
    // Arrange — force the flag off and give the probe a real viewport element.
    setChatViewportTraceEnabled(false);
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const addListener = vi.spyOn(viewport, "addEventListener");
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const interval = vi.spyOn(window, "setInterval");
    const timeout = vi.spyOn(window, "setTimeout");

    // Act
    renderHook(() =>
      useChatViewportTraceProbe({
        viewportRef: { current: viewport },
        isPinnedRef: { current: true },
      }),
    );

    // Assert — the disabled path pays nothing: no listener, no frame loop.
    expect(addListener).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
  });

  it("stamps which sampling path produced a frame", () => {
    // Arrange + Act — the rAF loop and the timer fallback must both pass the
    // path, so a fallback (non-draw) frame can be told from a drawn frame.
    const hasRafStamp = /takeSample\("raf"\)/.test(source);
    const hasFallbackStamp = /takeSample\("fallback"\)/.test(source);
    const recordsStamp = /by:\s*sampledBy/.test(source);

    // Assert
    expect(hasRafStamp).toBe(true);
    expect(hasFallbackStamp).toBe(true);
    expect(recordsStamp).toBe(true);
  });
});
