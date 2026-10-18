/**
 * User preference: auto-collapse tool steps in the chat timeline.
 * localStorage-only — does not touch Host AppSettings.
 * Default: true (tool rows start collapsed, including while running — #1018).
 */

export const TOOL_STEPS_AUTO_COLLAPSE_STORAGE_KEY = "grok.toolStepsAutoCollapse";

/** Fired on `window` after a successful save (detail = boolean autoCollapse). */
export const TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT =
  "grok-tool-steps-auto-collapse-change";

export const DEFAULT_TOOL_STEPS_AUTO_COLLAPSE = true;

/** Minimal storage surface so unit tests need no jsdom. */
export interface ToolStepsAutoCollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): ToolStepsAutoCollapseStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

/** Parse stored value; invalid / empty → default true. */
export function parseToolStepsAutoCollapsePref(raw: unknown): boolean {
  if (raw === "0" || raw === "false" || raw === false) return false;
  if (raw === "1" || raw === "true" || raw === true) return true;
  return DEFAULT_TOOL_STEPS_AUTO_COLLAPSE;
}

export function loadToolStepsAutoCollapsePref(
  storage: ToolStepsAutoCollapseStorage = defaultStorage(),
): boolean {
  try {
    return parseToolStepsAutoCollapsePref(
      storage.getItem(TOOL_STEPS_AUTO_COLLAPSE_STORAGE_KEY),
    );
  } catch {
    /* private mode */
    return DEFAULT_TOOL_STEPS_AUTO_COLLAPSE;
  }
}

export function saveToolStepsAutoCollapsePref(
  autoCollapse: boolean,
  storage: ToolStepsAutoCollapseStorage = defaultStorage(),
): void {
  try {
    storage.setItem(
      TOOL_STEPS_AUTO_COLLAPSE_STORAGE_KEY,
      autoCollapse ? "1" : "0",
    );
  } catch {
    /* private mode / quota */
  }
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, {
          detail: autoCollapse,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * Pure default-open for a tool step / tool group.
 * Tools never auto-expand — including while running — so large stdout stays
 * off the DOM until the user opens the row (#1018). `running` is kept for
 * call-site compatibility; streaming thoughts use activity `openWhileRunning`.
 */
export function toolStepDefaultOpen(
  _running: boolean,
  autoCollapse: boolean = DEFAULT_TOOL_STEPS_AUTO_COLLAPSE,
): boolean {
  return !autoCollapse;
}

/**
 * Work-phase fold (“工作中 / 工作了”).
 * Live work stays expanded so the user can see which tools are running.
 * After the phase ends, follow auto-collapse even when tools failed.
 * Failed leaves render as excerpt rows under the folded header.
 */
export function workPhaseDefaultOpen(opts: {
  running: boolean;
  /** Ignored. Failures use excerpt rows, not a forced-open rail. */
  errorCount?: number;
  autoCollapse?: boolean;
}): boolean {
  if (opts.running) return true;
  return !(opts.autoCollapse ?? DEFAULT_TOOL_STEPS_AUTO_COLLAPSE);
}

/**
 * Bare thinking fold. It expands while its episode is live and folds the moment
 * the episode ends — regardless of the tool-step preference (Thinking.tsx).
 */
export function thoughtDefaultOpen(streaming: boolean): boolean {
  return streaming;
}

/** What kind of foldable activity a row unit is. */
export type ActivityFoldKind = "phase" | "thought" | "tool";

/**
 * The single fold-default policy: whether one activity unit renders its body
 * open. The rich components and the shell-side fold model
 * (`chatRowCollapse`) both read the rule from here, so a shell's ledger height
 * cannot disagree with what the row would render if it were in the band.
 *
 * A unit without a body can never expand, so it contributes nothing to height:
 * a collapsed and an expanded render are identical.
 */
export function activityUnitDefaultOpen(input: {
  kind: ActivityFoldKind;
  /** Does the unit have an expandable body at all? */
  hasBody: boolean;
  /** Phase / tool still running. */
  running: boolean;
  /** Thought episode still live. */
  streaming: boolean;
  autoCollapse: boolean;
}): boolean {
  if (!input.hasBody) return false;
  switch (input.kind) {
    case "phase":
      return workPhaseDefaultOpen({
        running: input.running,
        autoCollapse: input.autoCollapse,
      });
    case "thought":
      return thoughtDefaultOpen(input.streaming);
    case "tool":
      return toolStepDefaultOpen(false, input.autoCollapse);
  }
}

/**
 * Live→idle folds must follow `defaultOpen` on the same render the turn
 * settles. Waiting on useEffect paints one expanded idle frame then collapses.
 */
export function resolveFoldExpanded(input: {
  userToggled: boolean;
  storedOpen: boolean;
  defaultOpen: boolean;
}): boolean {
  return input.userToggled ? input.storedOpen : input.defaultOpen;
}
