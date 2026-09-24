/**
 * `@` file mention detection + ranking for the composer at-panel.
 * Mirrors slash token rules: trigger only after start/whitespace.
 */

import {
  getStoredTextBeforeCaret,
  readStoredEditorText,
} from "@/lib/draftDoc";

/** Active `@token` at end of text-before-caret. */
export type AtQuery = {
  /** Index of `@` in the (trimmed-end) prefix string. */
  start: number;
  /** Text after `@` (may be empty). */
  query: string;
};

/**
 * Detect an active @ token at the end of `textBeforeCursor`.
 * `@` must be at index 0 or immediately after whitespace.
 * Rejects email-like `name@host` (letter/digit before `@`).
 * Query is the non-whitespace rest after `@`.
 *
 * 尾部空白**不**先剥掉：`@` 后一旦出现空白就终止补全（验收 C9）。否则 `"@ "`
 * 会以空 query 匹配成功，面板以「刚打完 @」的样子常驻，和标准相反。
 */
export function detectAtQuery(textBeforeCursor: string): AtQuery | null {
  const text = textBeforeCursor.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "");
  const m = /(^|[\s])@([^\s@]*)$/u.exec(text);
  if (!m) return null;
  // Reject `user@domain` — char before `@` is not whitespace/start.
  // The regex already requires start or whitespace before `@`.
  const start = m.index + m[1]!.length;
  return { start, query: m[2]! };
}

/** Stored-form @ token (same coordinate space as draft / removeAtTokenFromDraft). */
export function detectAtQueryOnStored(
  stored: string,
): { start: number; query: string; end: number } | null {
  const q = detectAtQuery(stored);
  if (!q) return null;
  const stripped = stored.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "");
  return { start: q.start, query: q.query, end: stripped.length };
}

/** Live @ token from a contenteditable element — no innerText (forced layout). */
export function detectAtQueryFromEditor(
  el: HTMLElement | null | undefined,
): { start: number; query: string; end: number } | null {
  if (!el) return null;
  const before = getStoredTextBeforeCaret(el);
  if (before != null) return detectAtQueryOnStored(before);
  return detectAtQueryOnStored(readStoredEditorText(el));
}

/** Hit shape used for ranking (subset of codebase search hit). */
export type AtFileHit = {
  path: string;
  name: string;
  relativePath: string;
  mtimeMs?: number;
};

/**
 * Fuzzy score for ranking file hits against a query.
 * Higher is better. 0 = no match (when query non-empty).
 */
export function scoreAtFileHit(hit: AtFileHit, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    // Empty query: prefer recent mtime.
    return hit.mtimeMs != null ? Math.min(hit.mtimeMs / 1e12, 1) : 0;
  }
  const name = (hit.name || "").toLowerCase();
  const rel = (hit.relativePath || hit.path || "").toLowerCase().replace(/\\/g, "/");
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800 - Math.min(name.length, 100);
  if (name.includes(q)) return 600 - name.indexOf(q);
  if (rel.includes(q)) return 400 - Math.min(rel.indexOf(q), 100);
  // Subsequence (fuzzy) match on basename
  let qi = 0;
  for (let i = 0; i < name.length && qi < q.length; i++) {
    if (name[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 200 - name.length;
  return 0;
}

/** Sort hits for the @ panel (best first). Drops zero-score when query set. */
export function rankAtFileHits<T extends AtFileHit>(
  hits: T[],
  query: string,
): T[] {
  const q = query.trim();
  const scored = hits
    .map((h) => ({ h, s: scoreAtFileHit(h, q) }))
    .filter((x) => (q ? x.s > 0 : true));
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    const am = a.h.mtimeMs ?? 0;
    const bm = b.h.mtimeMs ?? 0;
    if (bm !== am) return bm - am;
    return (a.h.relativePath || a.h.name).localeCompare(
      b.h.relativePath || b.h.name,
    );
  });
  return scored.map((x) => x.h);
}

/**
 * Replace the active `@query` span in stored draft with empty string
 * (file is attached as a chip instead).
 */
/**
 * Replace the active `@query` span in stored draft with empty string.
 *
 * 保留给非 token 化路径等的回退场景；文件引用正常走
 * {@link insertAtTokenAsRef}，它把 `@query` 换成一个内联引用 token。
 */
export function removeAtTokenFromDraft(
  draft: string,
  start: number,
  end: number,
): string {
  if (start < 0 || end < start || end > draft.length) return draft;
  return draft.slice(0, start) + draft.slice(end);
}

/**
 * 把 `@query` 区间替换成内联引用 token（BOR-53），并在其后补一个空格。
 *
 * 返回替换后的 draft 与 chip 之后的存储态偏移——调用方据此放置光标。
 * 区间非法时改为追加到末尾（面板可能由别处触发，此时没有 `@query` 区间）。
 */
export function insertAtTokenAsRef(
  draft: string,
  range: { start: number; end: number } | null,
  token: string,
): { draft: string; caret: number } {
  if (range && range.start >= 0 && range.end >= range.start && range.end <= draft.length) {
    const after = draft.slice(range.end);
    // `@query` 后面通常已经跟着一个空格；再补一个会在正文与发给 CLI 的 prompt
    // 里留下双空格，所以只在后面不是空白时才补。
    const needsSpace = !/^\s/.test(after);
    const tail = needsSpace ? ` ${after}` : after;
    return {
      draft: draft.slice(0, range.start) + token + tail,
      caret: range.start + token.length + (needsSpace ? 1 : 0),
    };
  }
  const sep = draft && !/\s$/.test(draft) ? " " : "";
  const next = `${draft}${sep}${token} `;
  return { draft: next, caret: next.length };
}
