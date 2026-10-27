/**
 * Director mode steering for a send.
 *
 * Settings → Director mode is app-wide. A new agent receives the rule as
 * ACP `_meta.rules` on `session/new` (see `src-tauri/src/director.rs`), so
 * this module does not prefix that turn. An open chat, which will not call
 * `session/new` again, gets the same paragraph on the next send.
 * This module does not write `~/.grok`.
 */

export const DIRECTOR_RULE =
  "Do lane work with a background workflow or background subagents. Keep this transcript to decisions, blockers, and a short status. Put file lists, diffs, and command output in the child prompt. Name the task ids started. Ask before two writers share one tree.";

/** Agent id already attached to this send. Empty means the next connect is `session/new`. */
export function openAgentSessionId(input: {
  sendTargetId: string | null | undefined;
  viewedSessionId: string | null | undefined;
  viewedAgentSessionId: string | null | undefined;
  rows: ReadonlyArray<{ id: string; agentSessionId?: string | null }>;
}): string {
  const target = (input.sendTargetId || "").trim();
  const viewed = (input.viewedSessionId || "").trim();
  const rowId = target || viewed;
  const row = rowId ? input.rows.find((item) => item.id === rowId) : undefined;
  const fromRow = (row?.agentSessionId || "").trim();
  if (fromRow) return fromRow;
  if (!target || target === viewed) {
    return (input.viewedAgentSessionId || "").trim();
  }
  return "";
}

/** Prefix an already-open chat. New sessions leave the text alone. */
export function wrapDirectorSend(userText: string, directorOn: boolean): string {
  if (!directorOn) return userText;
  return `${DIRECTOR_RULE}\n\nUser request:\n${userText.trim()}`;
}
