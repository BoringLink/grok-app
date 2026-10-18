/**
 * Model-derived activity fold state for one transcript row.
 *
 * A row outside the viewport band renders as a shell: no DOM for its thinking
 * body or work phase, so nothing in the DOM can say whether that content is
 * currently expanded. This projects the row's fold from the message model
 * alone, using the same {@link activityUnitDefaultOpen} policy the rich
 * components read, so a shell's ledger height cannot disagree with what the row
 * would render.
 *
 * Two facts are needed and both come out of one pass:
 * - `hasActivity` — the row has foldable content at all. A folded row with a
 *   failed phase still has activity (it renders error-excerpt rows), so it stays
 *   tracked and a later re-growth is propagated.
 * - `expanded` — at least one unit currently renders its body open.
 *
 * Pure: no DOM, no React.
 */

import type { MessageSegment } from "@/lib/session";
import { buildAssistantTimeline, toolFailed, type TimelineUnit } from "@/lib/timelinePhases";
import { toolExpandHasBody } from "@/lib/toolDisplay";
import { activityUnitDefaultOpen } from "@/lib/toolStepsAutoCollapsePref";

/** Fold state of one row, from the model. */
export type RowActivityFold = {
  /** The row has foldable content, so its height depends on the fold policy. */
  hasActivity: boolean;
  /** At least one unit renders its body open right now. */
  expanded: boolean;
};

/** Bare thought / thought-group has body text to expand. */
function thoughtHasBody(unit: Extract<TimelineUnit, { kind: "thought" | "thought-group" }>): boolean {
  if (unit.kind === "thought") return unit.text.trim().length > 0;
  return unit.texts.some((text) => text.trim().length > 0);
}

export function resolveRowActivityFold(input: {
  streaming: boolean;
  segments?: readonly MessageSegment[] | null;
  autoCollapse: boolean;
}): RowActivityFold {
  const segments = input.segments ?? [];
  // Streaming before any segment arrived paints the thinking placeholder: chrome
  // only, no expandable body, so its height does not depend on the fold.
  if (input.streaming && segments.length === 0) {
    return { hasActivity: false, expanded: false };
  }
  const units = buildAssistantTimeline([...segments], {
    streaming: input.streaming,
  });
  let hasActivity = false;
  let expanded = false;
  for (const unit of units) {
    if (unit.kind === "phase") {
      hasActivity = true;
      const running = input.streaming && (unit.live || unit.runningCount > 0);
      if (
        activityUnitDefaultOpen({
          kind: "phase",
          hasBody: true,
          running,
          streaming: input.streaming,
          autoCollapse: input.autoCollapse,
        })
      ) {
        expanded = true;
      }
      continue;
    }
    if (unit.kind === "thought" || unit.kind === "thought-group") {
      if (!thoughtHasBody(unit)) continue;
      hasActivity = true;
      if (
        activityUnitDefaultOpen({
          kind: "thought",
          hasBody: true,
          running: false,
          streaming: unit.streaming,
          autoCollapse: input.autoCollapse,
        })
      ) {
        expanded = true;
      }
      continue;
    }
    if (unit.kind === "tool") {
      if (!toolExpandHasBody(unit.tool, toolFailed(unit.tool))) continue;
      hasActivity = true;
      if (
        activityUnitDefaultOpen({
          kind: "tool",
          hasBody: true,
          running: false,
          streaming: input.streaming,
          autoCollapse: input.autoCollapse,
        })
      ) {
        expanded = true;
      }
    }
  }
  return { hasActivity, expanded };
}
