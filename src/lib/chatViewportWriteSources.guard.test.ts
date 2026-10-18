import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The transcript viewport has exactly one position writer: the controller hook
 * (`useChatViewportController`, ADR 0006). ADR 0006 defines the transcript as
 * the `.lobe-chat__scroll` column, so anything that touches that surface must
 * hand the controller a measured height or a decided position — never write a
 * position itself.
 *
 * The surface is *discovered*, not listed: every non-test source file that
 * references the transcript element or the controller is scanned, so a new
 * writer added anywhere on the transcript path is caught.
 *
 * Nested scroll ports (thinking body, activity phase table, the sidebar
 * `VirtualList`) are separate scrollers, not the transcript, and keep their own
 * scoped writes.
 */
const SRC = resolve(__dirname, "..");
const CONTROLLER = resolve(SRC, "hooks/useChatViewportController.ts");
/** The recorder: it is the one place that assigns, on the controller's behalf. */
const TRACE = resolve(SRC, "lib/chatViewportTrace.ts");

/** References the transcript element, its pin state, or the controller. */
const TRANSCRIPT_SURFACE =
  /lobe-chat__scroll|useChatViewportController|ChatViewportControllerHandle|viewportController|isPinnedRef|escapedRef/;

/**
 * Every way a caller can move a scroll container. `scrollIntoView` and a
 * focus-driven scroll would otherwise bypass the write funnel unnoticed.
 */
const WRITE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "scrollTop assign", pattern: /\.scrollTop\s*(?:\+=|-=|=)(?!=)/ },
  { name: "scrollTo", pattern: /\.scrollTo\s*\(/ },
  { name: "scrollIntoView", pattern: /scrollIntoView\s*\(/ },
];

/** Comments describe the write funnel; they must not be scanned as writes. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const read = (path: string): string =>
  stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));

/** Non-test source files under `src/`. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

const writeHits = (source: string): string[] =>
  WRITE_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(
    ({ name }) => name,
  );

describe("transcript scroll write source guard", () => {
  it("catches every write form, so the guard cannot rot into a no-op", () => {
    expect(writeHits("el.scrollTop = 0;")).toEqual(["scrollTop assign"]);
    expect(writeHits("el.scrollTop += 12;")).toEqual(["scrollTop assign"]);
    expect(writeHits("el.scrollTop >= 0;")).toEqual([]);
    expect(writeHits("el.scrollTop ==")).toEqual([]);
    expect(writeHits("el.scrollTo({ top: 1 });")).toEqual(["scrollTo"]);
    expect(writeHits("el.scrollToTarget = 1;")).toEqual([]);
    expect(writeHits("el.scrollIntoView({ block: 'start' });")).toEqual([
      "scrollIntoView",
    ]);
    // Comments describing the funnel are not writes.
    expect(writeHits(stripComments("// el.scrollTop = 0"))).toEqual([]);
    expect(writeHits(stripComments("/* el.scrollIntoView() */"))).toEqual([]);
  });

  it("discovers the transcript surface instead of listing it", () => {
    const surface = sourceFiles(SRC)
      .filter((path) => TRANSCRIPT_SURFACE.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).replaceAll("\\", "/"));

    // The thread, the virtual list, the shared args and the controller.
    expect(surface).toContain("components/lobe-chat/ConversationThread.tsx");
    expect(surface).toContain("hooks/useChatMessageVirtualizer.ts");
    expect(surface).toContain("hooks/useChatViewportController.ts");
  });

  it("keeps the controller the only transcript position writer", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => path !== CONTROLLER && path !== TRACE)
      .filter((path) => TRANSCRIPT_SURFACE.test(readFileSync(path, "utf8")))
      .flatMap((path) =>
        writeHits(read(path)).map(
          (hit) => `${relative(SRC, path)}: ${hit}`,
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("routes the controller's writes through the trace helper", () => {
    const controller = read(CONTROLLER);
    expect(controller).toContain("applyScrollTopTraced");
    // A smooth write goes through the same funnel and is recorded.
    expect(controller).toContain("traceScrollTopWrite");

    const helper = read(resolve(SRC, "lib/chatViewportTrace.ts")).match(
      /export function applyScrollTopTraced\([\s\S]*?\n\}/,
    )?.[0];

    expect(helper).toBeDefined();
    expect(writeHits(helper ?? "")).toEqual(["scrollTop assign"]);
  });
});
