/**
 * Literal find over a ProseMirror document (TipTap markdown editor).
 *
 * Matches stay inside a single text node, so offsets map directly onto
 * editor positions. Finding across inline marks is split per node, which is
 * the same granularity TipTap itself uses for text selection.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

export const PM_FIND_MAX_MATCHES = 2000;

export type PmFindMatch = {
  /** Absolute ProseMirror position of the first character. */
  from: number;
  /** Absolute ProseMirror position after the last character. */
  to: number;
};

/** Non-overlapping, case-insensitive matches in document order. */
export function findPmTextMatches(
  doc: PmNode,
  query: string,
  maxMatches: number = PM_FIND_MAX_MATCHES,
): PmFindMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const limit = Math.max(1, maxMatches);
  const matches: PmFindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const haystack = node.text.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1 && matches.length < limit) {
      matches.push({ from: pos + at, to: pos + at + needle.length });
      at = haystack.indexOf(needle, at + needle.length);
    }
    return matches.length < limit;
  });
  return matches;
}
