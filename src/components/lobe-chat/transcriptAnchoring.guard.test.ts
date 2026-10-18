import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The transcript must not let the engine pick its scroll anchor: our own
 * viewport writes and the engine's compensation cancel each other out (ADR
 * 0006). CSS Scroll Anchoring Level 1 §3 re-enables anchoring for every
 * descendant scroll container that does not opt out itself, so the opt-out has
 * to cover the nested scrollers (activity steps, thinking body, tool bodies),
 * not only the transcript viewport.
 */
const raw = readFileSync(resolve(__dirname, "lobe-chat.part1.css"), "utf8");
// Comments in this file contain braces (`*:not(textarea) { … }`), so drop them
// before splitting rules.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

type CssRule = { selectors: string[]; body: string };

const rules: CssRule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (match) => ({
    selectors: match[1]
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean),
    body: match[2],
  }),
);

const ANCHOR_OFF = /overflow-anchor\s*:\s*none/;

const optOutRules = rules.filter((rule) => ANCHOR_OFF.test(rule.body));

describe("transcript engine anchoring guard", () => {
  it("opts the transcript viewport out of engine anchoring", () => {
    const viewportRule = optOutRules.find((rule) =>
      rule.selectors.includes(".lobe-chat__scroll"),
    );

    expect(viewportRule).toBeDefined();
  });

  it("opts every nested scroller in the transcript out, and nothing else", () => {
    expect(
      optOutRules.some((rule) => rule.selectors.includes(".lobe-chat__scroll *")),
    ).toBe(true);
    // Scoped to the transcript subtree: a rule anchored on a bare `*` would
    // disable anchoring in the composer, rail, sidebar and settings scrollers.
    const unscoped = optOutRules.filter((rule) =>
      rule.selectors.some((selector) => !selector.startsWith(".lobe-chat__scroll")),
    );

    expect(unscoped).toEqual([]);
  });
});
