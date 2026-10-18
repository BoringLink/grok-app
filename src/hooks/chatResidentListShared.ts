import type { RefObject } from "react";
import type { ChatViewportControllerHandle } from "@/hooks/useChatViewportController";

export type { ChatResidentBandStore } from "@/lib/chatResidentBand";
import type { ChatResidentBandStore } from "@/lib/chatResidentBand";

export type UseChatResidentListArgs = {
  /** Every conversation row is resident; this is how many there are. */
  itemCount: number;
  /** Content-aware height estimate, used to seed the ledger before first render. */
  getEstimateHeight?: (index: number) => number;
  viewportRef: RefObject<HTMLElement | null>;
  /** Stick pin flag from useChatViewportController (ref, not reactive). */
  isPinnedRef: RefObject<boolean>;
  /**
   * The transcript viewport controller. The resident list produces layout only:
   * estimates seed the controller's ledger, measured heights go back through it,
   * and it owns the single `scrollTop` write.
   */
  controller?: ChatViewportControllerHandle;
  /**
   * Row-identity key. When it changes (conversation switch, transcript filter),
   * the remembered heights are dropped so stale indices cannot pose as real.
   */
  resetKey?: string | number | null;
  /** When false, every row renders real content (no shell band). */
  enabled?: boolean;
  /**
   * Model-derived fold state of row `index`. A shell has no DOM to answer
   * whether its thinking / work phase is open, so the model must. The list
   * re-seeds a shell whose fold flipped — collapse to the estimate, re-growth to
   * the height remembered from its last expanded render — so the scrollbar
   * follows a fold that happened outside the band. Omit to disable.
   *
   * `inputs` is the identity of everything the fold reads; the list compares it
   * element-wise and only recomputes on a change, so this may be called for every
   * tracked row on every revision.
   */
  getActivityFold?: (index: number) => RowActivityFoldSnapshot | null;
  /**
   * Opaque revision of the transcript model: change it whenever any row's
   * activity fold could have changed (a token, a turn settling, the
   * auto-collapse preference, collapse-all). It only gates when the list
   * re-checks tracked rows, so it may change on every render.
   */
  activityRevision?: unknown;
};

/** One row's model fold, plus the identity of the inputs that produced it. */
export type RowActivityFoldSnapshot = {
  /** The row has foldable content (a failed folded phase included). */
  hasActivity: boolean;
  /** At least one unit renders its body open right now. */
  expanded: boolean;
  /** Identity of the fold inputs, compared element-wise for a change. */
  inputs: readonly unknown[];
};

/**
 * The hook result. The band is a store so a scroll re-renders only the rows
 * whose membership flipped, never the parent with its 10k rows.
 */
export type UseChatResidentListResult = {
  /** Every row is resident; the full range is always `[0, rowCount)`. */
  rowCount: number;
  /** Which rows render real content this frame (stable object). */
  bandStore: ChatResidentBandStore;
  /** Shell height for a row, from the ledger. */
  rowHeight: (index: number) => number;
  /** Attach to a real-content row wrapper so its height measures back. */
  measureRef: (index: number) => (el: HTMLElement | null) => void;
};
