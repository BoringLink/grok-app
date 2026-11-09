/**
 * ProseMirror decorations for the in-editor find session.
 *
 * Keeps the visible word highlight independent from the selection: the find
 * input owns keyboard focus, so a bare TextSelection is not painted. Matches
 * are rebuilt from the current document whenever the query/active index
 * changes or the document is edited.
 */

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PmNode } from "@tiptap/pm/model";
import { findPmTextMatches, type PmFindMatch } from "./pmFind";

export type PmFindHighlightMeta = {
  query: string;
  active: number;
};

type PmFindHighlightState = {
  query: string;
  active: number;
  matches: PmFindMatch[];
  decorations: DecorationSet;
};

export const pmFindHighlightKey = new PluginKey<PmFindHighlightState>(
  "pmFindHighlight",
);

function buildState(
  doc: PmNode,
  query: string,
  active: number,
): PmFindHighlightState {
  const matches = query ? findPmTextMatches(doc, query) : [];
  const decorations = DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === active ? "rp-find-hit is-active" : "rp-find-hit",
      }),
    ),
  );
  return { query, active, matches, decorations };
}

/** ProseMirror plugin that paints every match of the current find query. */
export function createPmFindHighlightPlugin(): Plugin<PmFindHighlightState> {
  return new Plugin<PmFindHighlightState>({
    key: pmFindHighlightKey,
    state: {
      init: () => ({
        query: "",
        active: -1,
        matches: [],
        decorations: DecorationSet.empty,
      }),
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(pmFindHighlightKey) as
          | PmFindHighlightMeta
          | undefined;
        if (meta) return buildState(newState.doc, meta.query, meta.active);
        if (!tr.docChanged) return previous;
        return buildState(newState.doc, previous.query, previous.active);
      },
    },
    props: {
      decorations(state) {
        return pmFindHighlightKey.getState(state)?.decorations ?? null;
      },
    },
  });
}
