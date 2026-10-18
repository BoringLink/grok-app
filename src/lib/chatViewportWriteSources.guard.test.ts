import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every position write on the transcript path must go through
 * `applyScrollTopTraced` so a trace can attribute a move to a source (ADR 0006,
 * Spec "诊断"). A raw `scrollTop` assignment is invisible in the geometry
 * afterwards and makes the drift unattributable.
 */
const TRANSCRIPT_WRITE_PATH = [
  "../components/lobe-chat/ConversationThread.tsx",
  "../components/lobe-chat/TimelinePhaseBlock.tsx",
  "../components/VirtualList.tsx",
  "../hooks/useStickToBottom.ts",
  "../hooks/useChatMessageVirtualizer.ts",
  "../hooks/useThoughtBodyFollow.ts",
  "grokActivityVirtualize.ts",
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

  it("routes every transcript position write through the traced helper", () => {
    const rawWrites = TRANSCRIPT_WRITE_PATH.flatMap((path) =>
      rawWriteLocations(read(path), path),
    );

    expect(rawWrites).toEqual([]);
  });

  it("keeps the traced helper the single place that assigns", () => {
    const helper = read("chatViewportTrace.ts").match(
      /export function applyScrollTopTraced\([\s\S]*?\n\}/,
    )?.[0];

    expect(helper).toBeDefined();
    expect(rawWriteLocations(helper ?? "", "chatViewportTrace.ts")).not.toEqual(
      [],
    );
  });
});
