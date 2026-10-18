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
const RAW_WRITE = /\.scrollTop\s*(?:\+=|-=|=)(?!=)/g;

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), "utf8").replace(/\r\n/g, "\n");

describe("transcript scroll write source guard", () => {
  it("catches an assignment, so the guard cannot rot into a no-op", () => {
    expect("el.scrollTop = 0;".match(RAW_WRITE)).toHaveLength(1);
    expect("el.scrollTop += 12;".match(RAW_WRITE)).toHaveLength(1);
    expect("el.scrollTop >= 0;".match(RAW_WRITE)).toBeNull();
    expect("el.scrollTop ==".match(RAW_WRITE)).toBeNull();
  });

  it("routes every transcript position write through the traced helper", () => {
    const rawWrites = TRANSCRIPT_WRITE_PATH.flatMap((path) =>
      [...read(path).matchAll(RAW_WRITE)].map((match) => {
        const line = read(path).slice(0, match.index).split("\n").length;

        return `${path}:${line}`;
      }),
    );

    expect(rawWrites).toEqual([]);
  });

  it("keeps the traced helper the single place that assigns", () => {
    const trace = read("chatViewportTrace.ts");
    const helper = trace.match(
      /export function applyScrollTopTraced\([\s\S]*?\n\}/,
    )?.[0];

    expect(helper).toBeDefined();
    expect(helper).toMatch(RAW_WRITE);
  });
});
