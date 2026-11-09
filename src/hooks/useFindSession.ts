/**
 * Shared find-session state for the conversation-style find bar.
 *
 * Owns open/query/active/nonce and index stepping; the caller supplies a
 * stable matcher so files (source text) and the TipTap editor (ProseMirror
 * positions) can share the state machine without sharing match types.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { stepFindIndex } from "@/lib/chatFind";

export type FindSession<Match> = {
  open: boolean;
  query: string;
  /** Matches for the current query; empty while closed or blank. */
  matches: Match[];
  active: number;
  nonce: number;
  setQuery: (query: string) => void;
  openFind: () => void;
  close: () => void;
  /** Move to the next/previous match, wrapping. */
  step: (direction: 1 | -1) => void;
};

export function useFindSession<Match>(
  findMatches: (query: string) => Match[],
): FindSession<Match> {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [nonce, setNonce] = useState(0);

  const matches = useMemo(
    () => (open && query ? findMatches(query) : []),
    [open, query, findMatches],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(-1);
  }, []);
  const openFind = useCallback(() => {
    setOpen(true);
    setNonce((current) => current + 1);
  }, []);
  const step = useCallback(
    (direction: 1 | -1) => {
      setActive((current) =>
        matches.length > 0
          ? stepFindIndex(current, matches.length, direction)
          : -1,
      );
    },
    [matches.length],
  );

  useEffect(() => {
    setActive(matches.length > 0 ? 0 : -1);
  }, [matches]);

  return {
    open,
    query,
    matches,
    active,
    nonce,
    setQuery,
    openFind,
    close,
    step,
  };
}
