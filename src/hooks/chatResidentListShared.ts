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
