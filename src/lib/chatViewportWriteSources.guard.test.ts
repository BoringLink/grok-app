import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The transcript viewport has exactly one position writer: the controller hook.
 * ADR 0006 defines the transcript as the `.lobe-chat__scroll` column, so the
 * virtual list and the thread must not assign `scrollTop` — they hand the
 * controller a measured height or a decided position instead.
 *
 * Nested scroll ports (thinking body, activity phase table, the sidebar
 * `VirtualList`) are separate scrollers, not the transcript, and keep their own
 * scoped writes.
 */
const TRANSCRIPT_CONTROLLER = "../hooks/useChatViewportController.ts";
/** Transcript writers that must delegate to the controller. */
const TRANSCRIPT_CONSUMERS = [
  "../components/lobe-chat/ConversationThread.tsx",
  "../hooks/useChatMessageVirtualizer.ts",
] as const;

/** Assignment only: reads, `>=`, `<=` and `==` must not match. */
const rawWrite = () => /\.scrollTop\s*(?:\+=|-=|=)(?!=)/g;

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), "utf8").replace(/\r\n/g, "\n");

/** `file:line` for every raw assignment the guard would reject. */
const rawWriteLocations = (source: string, path: string): string[] =>
  [...source.matchAll(rawWrite())].map((match) => {
    const line = source.slice(0, match.index).split("\n").length;

    return `${path}:${line}`;
  });

describe("transcript scroll write source guard", () => {
  it("catches an assignment, so the guard cannot rot into a no-op", () => {
    expect(rawWriteLocations("el.scrollTop = 0;", "x")).toHaveLength(1);
    expect(rawWriteLocations("el.scrollTop += 12;", "x")).toHaveLength(1);
    expect(rawWriteLocations("el.scrollTop >= 0;", "x")).toHaveLength(0);
    expect(rawWriteLocations("el.scrollTop ==", "x")).toHaveLength(0);
  });

  it("keeps the controller the only transcript position writer", () => {
    const rawWrites = TRANSCRIPT_CONSUMERS.flatMap((path) =>
      rawWriteLocations(read(path), path),
    );

    expect(rawWrites).toEqual([]);
  });

  it("routes every transcript write through the controller's traced helper", () => {
    const leaked = TRANSCRIPT_CONSUMERS.filter((path) =>
      /applyScrollTopTraced/.test(read(path)),
    );

    expect(leaked).toEqual([]);
  });

  it("keeps the traced helper the single place that assigns", () => {
    const controller = read(TRANSCRIPT_CONTROLLER);
    expect(controller).toMatch(/applyScrollTopTraced\(/);

    const helper = read("chatViewportTrace.ts").match(
      /export function applyScrollTopTraced\([\s\S]*?\n\}/,
    )?.[0];

    expect(helper).toBeDefined();
    expect(rawWriteLocations(helper ?? "", "chatViewportTrace.ts")).not.toEqual(
      [],
    );
  });
});
