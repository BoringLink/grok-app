/**
 * Shared remark/rehype plugins for chat + preview markdown.
 * GFM + KaTeX ($…$ / $$…$$ and \(…\) / \[…\]).
 */

import type { Options } from "react-markdown";
// Email autolink is patched in patches/mdast-util-gfm-autolink-literal@2.0.1.patch.
// Upstream's lookbehind throws on macOS 12 WKWebView (#1347).
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/**
 * KaTeX styles load with the first markdown processor instead of from
 * main.tsx — keeps ~30KB of @font-face CSS (plus fonts) off the boot
 * critical path. The plugin's transformer is a no-op; the import fires on
 * attach, and repeat mounts hit the module cache. Typed loosely because
 * unified's Plugin type is not a direct dependency.
 */
const rehypeKatexCssLoader = () => {
  void import("katex/dist/katex.min.css");
  return () => undefined;
};

export const MARKDOWN_REMARK_PLUGINS_GFM: NonNullable<Options["remarkPlugins"]> =
  [remarkGfm];

export const MARKDOWN_REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
  remarkGfm,
  remarkMath,
];

export const MARKDOWN_REHYPE_PLUGINS_NO_MATH: NonNullable<
  Options["rehypePlugins"]
> = [];

export const MARKDOWN_REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
  rehypeKatexCssLoader,
  [
    rehypeKatex,
    {
      throwOnError: false,
      errorColor: "#c44",
      strict: "ignore",
      output: "html",
      trust: false,
    },
  ],
];

/**
 * CommonMark treats `\[` as an escaped `[`, so remark-math never sees
 * display TeX. Grok (and other Chinese models) also emit one-line
 * `[ \int ... ]`. Rewrite those to `$` / `$$` before parse (#1238).
 */
const LATEX_HINT =
  /\\(?:int|sum|prod|frac|sqrt|mathrm|mathbf|operatorname|begin|end|left|right|bigl|bigr|Bigl|Bigr|cdot|times|alpha|beta|gamma|pi|theta|infty|partial|nabla|leq|geq|neq|to|rightarrow)|[_^]\s*\{/;

function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (i + n < src.length && src[i + n] === ch) n += 1;
  return n;
}

function lineEndAt(src: string, i: number): number {
  if (src[i] === "\r") return src[i + 1] === "\n" ? i + 2 : i + 1;
  if (src[i] === "\n") return i + 1;
  return i;
}

function isFenceLineEnd(src: string, i: number): boolean {
  return i >= src.length || src[i] === "\n" || src[i] === "\r";
}

/** Opening fence at a line start, or null. `end` is just past that line. */
function fenceOpen(
  src: string,
  i: number,
): { marker: string; len: number; end: number } | null {
  if (!(i === 0 || src[i - 1] === "\n" || src[i - 1] === "\r")) return null;
  let j = i;
  let spaces = 0;
  while (spaces < 3 && src[j] === " ") {
    spaces += 1;
    j += 1;
  }
  const marker = src[j];
  if (marker !== "`" && marker !== "~") return null;
  const len = runLength(src, j, marker);
  if (len < 3) return null;
  let k = j + len;
  while (k < src.length && src[k] !== "\n" && src[k] !== "\r") {
    // A backtick fence whose info string contains ` is not a fence.
    if (marker === "`" && src[k] === "`") return null;
    k += 1;
  }
  return { marker, len, end: lineEndAt(src, k) };
}

function fenceClose(
  src: string,
  from: number,
  marker: string,
  len: number,
): number | null {
  let i = from;
  while (i < src.length) {
    if (i === 0 || src[i - 1] === "\n" || src[i - 1] === "\r") {
      let j = i;
      let spaces = 0;
      while (spaces < 3 && src[j] === " ") {
        spaces += 1;
        j += 1;
      }
      if (src[j] === marker) {
        const run = runLength(src, j, marker);
        let k = j + run;
        while (src[k] === " " || src[k] === "\t") k += 1;
        if (run >= len && isFenceLineEnd(src, k)) return lineEndAt(src, k);
      }
    }
    i += 1;
  }
  return null;
}

function inlineCodeEnd(src: string, from: number, len: number): number | null {
  let i = from;
  while (i < src.length) {
    if (src[i] !== "`") {
      i += 1;
      continue;
    }
    const run = runLength(src, i, "`");
    if (run === len) return i + run;
    i += run;
  }
  return null;
}

/** Fenced and inline code spans. An unclosed fence runs through the end. */
function codeSpans(src: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < src.length) {
    const fence = fenceOpen(src, i);
    if (fence) {
      const close = fenceClose(src, fence.end, fence.marker, fence.len);
      const end = close ?? src.length;
      spans.push({ start: i, end });
      i = end;
      continue;
    }
    if (src[i] === "`") {
      const len = runLength(src, i, "`");
      const close = inlineCodeEnd(src, i + len, len);
      if (close != null) {
        spans.push({ start: i, end: close });
        i = close;
        continue;
      }
    }
    i += 1;
  }
  return spans;
}

function startsOnLine(src: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = src[index - 1];
  return prev === "\n" || prev === "\r";
}

/**
 * One rewrite pass of math normalization. `pattern` must be a global regex;
 * `rewrite` receives the full match and the captured body and returns the
 * replacement (returning `full` keeps the text unchanged).
 *
 * `normalizeMarkdownMathPasses` walks this table on text outside code spans.
 * Stream-reveal offset mapping uses those passes, so both see the same edits.
 */
export type MarkdownMathRewrite = {
  pattern: RegExp;
  rewrite: (full: string, body: string) => string;
};

export const MARKDOWN_MATH_REWRITES: readonly MarkdownMathRewrite[] = [
  { pattern: /\\\[([\s\S]+?)\\\]/g, rewrite: (_full, body) => `$$${body}$$` },
  { pattern: /\\\(([\s\S]+?)\\\)/g, rewrite: (_full, body) => `$${body}$` },
  {
    pattern: /^[ \t]*\[(?!\s*$)(?![^\]]+\]\()([^\n]+)\][ \t]*$/gm,
    rewrite: (full, body) => (LATEX_HINT.test(body) ? `$$${body}$$` : full),
  },
];

export type MarkdownMathRewriteMatch = {
  start: number;
  end: number;
  replacement: string;
};

/**
 * Runs one rewrite and returns the before / after offset pairs (`start` /
 * `end` are pre-rewrite coordinates). Matches `String.prototype.replace`
 * global semantics so normalization and offset mapping can share it.
 */
export function applyMarkdownMathRewrite(
  src: string,
  rewrite: MarkdownMathRewrite,
): { text: string; matches: MarkdownMathRewriteMatch[] } {
  // Clone the regex: a global regex reuses lastIndex, so state must not leak
  // across calls.
  const pattern = new RegExp(rewrite.pattern.source, rewrite.pattern.flags);
  const matches: MarkdownMathRewriteMatch[] = [];
  let out = "";
  let cursor = 0;
  for (const match of src.matchAll(pattern)) {
    const full = match[0];
    const start = match.index ?? cursor;
    const replacement = rewrite.rewrite(
      full,
      (match[1] as string | undefined) ?? "",
    );
    out += src.slice(cursor, start);
    out += replacement;
    cursor = start + full.length;
    if (replacement !== full) {
      matches.push({ start, end: cursor, replacement });
    }
  }
  out += src.slice(cursor);
  return { text: out, matches };
}

type RewrittenChunk = {
  text: string;
  originalLength: number;
  /** Length of this chunk after each rewrite pass. */
  lengths: number[];
  passes: MarkdownMathRewriteMatch[][];
};

function blankPasses(): MarkdownMathRewriteMatch[][] {
  return MARKDOWN_MATH_REWRITES.map(() => []);
}

function unchangedChunk(text: string): RewrittenChunk {
  return {
    text,
    originalLength: text.length,
    lengths: MARKDOWN_MATH_REWRITES.map(() => text.length),
    passes: blankPasses(),
  };
}

function rewriteMathChunk(chunk: string, atLineStart: boolean): RewrittenChunk {
  if (!chunk) return unchangedChunk(chunk);
  // A chunk that begins mid-line must not let `^` treat that cut as a new line.
  const guard = atLineStart ? "" : "\u0000";
  let body = guard + chunk;
  const passes: MarkdownMathRewriteMatch[][] = [];
  const lengths: number[] = [];
  for (const rewrite of MARKDOWN_MATH_REWRITES) {
    const applied = applyMarkdownMathRewrite(body, rewrite);
    body = applied.text;
    const shift = guard.length;
    const shifted: MarkdownMathRewriteMatch[] = [];
    for (const match of applied.matches) {
      if (match.start < shift) continue;
      shifted.push({
        start: match.start - shift,
        end: match.end - shift,
        replacement: match.replacement,
      });
    }
    passes.push(shifted);
    lengths.push(body.length - shift);
  }
  return {
    text: body.slice(guard.length),
    originalLength: chunk.length,
    lengths,
    passes,
  };
}

function chunkHasMath(chunk: string, atLineStart: boolean): boolean {
  if (!chunk) return false;
  const body = atLineStart ? chunk : `\u0000${chunk}`;
  if (/\$\$|\$[^$\n]|\\\[|\\\(/.test(body)) return true;
  return LATEX_HINT.test(body) && /^[ \t]*\[[^\n]+\][ \t]*$/m.test(body);
}

/** Text outside fenced and inline code, in order. */
function outsideCode(src: string): Array<{ text: string; atLineStart: boolean }> {
  const spans = codeSpans(src);
  const parts: Array<{ text: string; atLineStart: boolean }> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      parts.push({
        text: src.slice(cursor, span.start),
        atLineStart: startsOnLine(src, cursor),
      });
    }
    cursor = span.end;
  }
  if (cursor < src.length) {
    parts.push({
      text: src.slice(cursor),
      atLineStart: startsOnLine(src, cursor),
    });
  }
  return parts;
}

export type MarkdownMathNormalization = {
  text: string;
  /**
   * One match list per `MARKDOWN_MATH_REWRITES` entry. Offsets are global
   * coordinates in that pass's input. Code spans contribute length but no
   * matches.
   */
  passes: readonly (readonly MarkdownMathRewriteMatch[])[];
};

/**
 * Rewrites math delimiters outside code and reports each pass's matches.
 * `normalizeMarkdownMath` and stream-reveal offset mapping both use this.
 */
export function normalizeMarkdownMathPasses(src: string): MarkdownMathNormalization {
  if (!src) return { text: src, passes: blankPasses() };
  const chunks: RewrittenChunk[] = [];
  let out = "";
  let cursor = 0;
  const takeProse = (end: number) => {
    if (end <= cursor) return;
    const rewritten = rewriteMathChunk(
      src.slice(cursor, end),
      startsOnLine(src, cursor),
    );
    out += rewritten.text;
    chunks.push(rewritten);
    cursor = end;
  };
  const takeCode = (end: number) => {
    const text = src.slice(cursor, end);
    out += text;
    chunks.push(unchangedChunk(text));
    cursor = end;
  };
  for (const span of codeSpans(src)) {
    takeProse(span.start);
    takeCode(span.end);
  }
  takeProse(src.length);

  const passes: MarkdownMathRewriteMatch[][] = blankPasses();
  for (let pass = 0; pass < MARKDOWN_MATH_REWRITES.length; pass += 1) {
    let origin = 0;
    for (const chunk of chunks) {
      for (const match of chunk.passes[pass]) {
        passes[pass].push({
          start: origin + match.start,
          end: origin + match.end,
          replacement: match.replacement,
        });
      }
      origin += pass === 0 ? chunk.originalLength : chunk.lengths[pass - 1];
    }
  }
  return { text: out, passes };
}

export function normalizeMarkdownMath(src: string): string {
  if (!src) return src;
  return normalizeMarkdownMathPasses(src).text;
}

/** Skip remark-math + KaTeX when the source has no math delimiters. */
export function sourceHasMath(src: string): boolean {
  if (!src) return false;
  return outsideCode(src).some((part) => chunkHasMath(part.text, part.atLineStart));
}
