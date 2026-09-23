/**
 * Subagent telemetry merge (BOR-55).
 *
 * The CLI emits `subagent_spawned` / `subagent_progress` / `subagent_finished`
 * notifications; the Rust host decodes them and broadcasts `session://subagent`
 * with a normalized payload. This module merges those pushes into one
 * {@link SubagentRun} per `subagentId`, keeping spawn order.
 *
 * Pure and dependency-free (no DOM, no Tauri) so it can be unit-tested. Missing
 * fields stay `undefined` / `[]` — never fabricated (honesty convention, see
 * {@link ./taskTreeHonesty}).
 */

/** Which lifecycle update a payload carries. */
export type SubagentPhase = "spawned" | "progress" | "finished";

/**
 * Raw `session://subagent` payload. Fields are optional because the host
 * serializes absent values to `null` / `[]`; treat every field as untrusted and
 * narrow before use.
 */
export type SubagentEventPayload = {
  sessionId?: string | null;
  phase?: string | null;
  subagentId?: string | null;
  parentSessionId?: string | null;
  childSessionId?: string | null;
  parentPromptId?: string | null;
  attemptId?: string | null;
  subagentType?: string | null;
  description?: string | null;
  model?: string | null;
  status?: string | null;
  durationMs?: number | null;
  turnCount?: number | null;
  toolCallCount?: number | null;
  tokensUsed?: number | null;
  contextWindowTokens?: number | null;
  contextUsagePct?: number | null;
  toolsUsed?: string[] | null;
  errorCount?: number | null;
  output?: string | null;
  willWake?: boolean | null;
};

/** Merged view of one subagent across its lifecycle updates. */
export type SubagentRun = {
  subagentId: string;
  phase: SubagentPhase;
  /** True once a `finished` update landed (terminal; later pushes don't reset). */
  finished: boolean;
  sessionId: string | null;
  parentSessionId: string | null;
  childSessionId: string | null;
  parentPromptId: string | null;
  attemptId: string | null;
  subagentType: string | null;
  description: string | null;
  model: string | null;
  status: string | null;
  durationMs?: number;
  turnCount?: number;
  toolCallCount?: number;
  tokensUsed?: number;
  contextWindowTokens?: number;
  contextUsagePct?: number;
  toolsUsed: string[];
  errorCount?: number;
  output: string | null;
  willWake?: boolean;
};

/** Coarse status the panel renders; derived from `phase` + `status`. */
export type SubagentDisplayStatus = "running" | "completed" | "failed";

function asText(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asPhase(v: unknown): SubagentPhase | null {
  return v === "spawned" || v === "progress" || v === "finished" ? v : null;
}

function newRun(id: string, payload: SubagentEventPayload): SubagentRun {
  const phase = asPhase(payload.phase) ?? "spawned";
  return {
    subagentId: id,
    phase,
    finished: phase === "finished",
    sessionId: asText(payload.sessionId),
    parentSessionId: asText(payload.parentSessionId),
    childSessionId: asText(payload.childSessionId),
    parentPromptId: asText(payload.parentPromptId),
    attemptId: asText(payload.attemptId),
    subagentType: asText(payload.subagentType),
    description: asText(payload.description),
    model: asText(payload.model),
    status: asText(payload.status),
    durationMs: asNumber(payload.durationMs),
    turnCount: asNumber(payload.turnCount),
    toolCallCount: asNumber(payload.toolCallCount),
    tokensUsed: asNumber(payload.tokensUsed),
    contextWindowTokens: asNumber(payload.contextWindowTokens),
    contextUsagePct: asNumber(payload.contextUsagePct),
    toolsUsed: Array.isArray(payload.toolsUsed)
      ? payload.toolsUsed.filter((x): x is string => typeof x === "string")
      : [],
    errorCount: asNumber(payload.errorCount),
    output: asText(payload.output),
    willWake: asBool(payload.willWake),
  };
}

/** Apply one payload onto an existing row; absent fields leave it untouched. */
function mergeRun(
  prev: SubagentRun,
  payload: SubagentEventPayload,
): SubagentRun {
  const next: SubagentRun = { ...prev };
  const phase = asPhase(payload.phase);
  // `finished` is terminal — a stray progress push must not downgrade it.
  if (phase && !(prev.finished && phase !== "finished")) {
    next.phase = phase;
  }
  if (phase === "finished") next.finished = true;

  next.sessionId = asText(payload.sessionId) ?? prev.sessionId;
  next.parentSessionId = asText(payload.parentSessionId) ?? prev.parentSessionId;
  next.childSessionId = asText(payload.childSessionId) ?? prev.childSessionId;
  next.parentPromptId = asText(payload.parentPromptId) ?? prev.parentPromptId;
  next.attemptId = asText(payload.attemptId) ?? prev.attemptId;
  next.subagentType = asText(payload.subagentType) ?? prev.subagentType;
  next.description = asText(payload.description) ?? prev.description;
  next.model = asText(payload.model) ?? prev.model;
  next.status = asText(payload.status) ?? prev.status;
  next.output = asText(payload.output) ?? prev.output;

  next.durationMs = asNumber(payload.durationMs) ?? prev.durationMs;
  next.turnCount = asNumber(payload.turnCount) ?? prev.turnCount;
  next.toolCallCount = asNumber(payload.toolCallCount) ?? prev.toolCallCount;
  next.tokensUsed = asNumber(payload.tokensUsed) ?? prev.tokensUsed;
  next.contextWindowTokens =
    asNumber(payload.contextWindowTokens) ?? prev.contextWindowTokens;
  next.contextUsagePct =
    asNumber(payload.contextUsagePct) ?? prev.contextUsagePct;
  next.errorCount = asNumber(payload.errorCount) ?? prev.errorCount;

  if (Array.isArray(payload.toolsUsed) && payload.toolsUsed.length > 0) {
    next.toolsUsed = payload.toolsUsed.filter(
      (x): x is string => typeof x === "string",
    );
  }
  const willWake = asBool(payload.willWake);
  if (willWake !== undefined) next.willWake = willWake;
  return next;
}

/**
 * Fold one `session://subagent` payload into the run list for its session.
 * Insertion order is spawn order; a repeated id updates in place rather than
 * appending a second row. Payloads without a `subagentId` are ignored (returns
 * the same reference).
 */
export function applySubagentEvent(
  prev: readonly SubagentRun[],
  payload: SubagentEventPayload,
): SubagentRun[] {
  const id = asText(payload.subagentId);
  if (!id) return prev as SubagentRun[];
  const idx = prev.findIndex((r) => r.subagentId === id);
  if (idx === -1) return [...prev, newRun(id, payload)];
  const merged = mergeRun(prev[idx]!, payload);
  const next = prev.slice();
  next[idx] = merged;
  return next;
}

/** Coarse panel status: running until finished, then completed vs failed. */
export function subagentDisplayStatus(
  run: SubagentRun,
): SubagentDisplayStatus {
  if (!run.finished) return "running";
  return run.status === "completed" ? "completed" : "failed";
}

/**
 * Row title: description, else subagent type, else a shortened id. Never
 * fabricates text for a run that has none.
 */
export function subagentDisplayLabel(run: SubagentRun): string {
  if (run.description) return run.description;
  if (run.subagentType) return run.subagentType;
  return run.subagentId.length > 8
    ? `${run.subagentId.slice(0, 8)}…`
    : run.subagentId;
}

/**
 * Human-readable duration for the meta line. `undefined` → `—` (unknown), never
 * a fabricated zero. Units match the existing `accountUi.formatDuration` style.
 */
export function formatSubagentDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}
