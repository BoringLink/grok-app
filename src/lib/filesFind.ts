/**
 * In-file find for the Files pane (Cmd/Ctrl+F).
 *
 * Literal, case-insensitive matching (browser find behavior: whitespace in the
 * query is significant). Index stepping is shared with the conversation find
 * bar via `stepChatFindIndex`.
 */

/** Cap so a pathological query on a huge file cannot freeze the pane. */
export const FILE_FIND_MAX_MATCHES = 2000;

export type FileFindMatch = {
  /** 0-based index of the match in the searched text. */
  index: number;
  /** 1-based line that contains the match. */
  line: number;
};

/**
 * Find non-overlapping case-insensitive occurrences of `query` in `text`.
 * Empty queries return no matches (no "match everything" behavior).
 */
export function findFileTextMatches(
  text: string,
  query: string,
  maxMatches: number = FILE_FIND_MAX_MATCHES,
): FileFindMatch[] {
  if (!text || !query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const limit = Math.max(1, maxMatches);
  const matches: FileFindMatch[] = [];
  let line = 1;
  let scanned = 0;
  let from = haystack.indexOf(needle);
  // Manual loop: indexOf advances the scan and we stop at the match cap.
  while (from !== -1 && matches.length < limit) {
    for (let i = scanned; i < from; i += 1) {
      if (text.charCodeAt(i) === 10) line += 1;
    }
    scanned = from;
    matches.push({ index: from, line });
    from = haystack.indexOf(needle, from + needle.length);
  }
  return matches;
}

/** 1-based line for the active match, or null when there is none. */
export function activeFileFindLine(
  matches: readonly FileFindMatch[],
  activeIndex: number,
): number | null {
  if (activeIndex < 0 || activeIndex >= matches.length) return null;
  return matches[activeIndex]!.line;
}
