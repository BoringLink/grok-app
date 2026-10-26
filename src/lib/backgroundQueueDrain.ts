/**
 * Which per-session composer queues may send their next follow-up.
 *
 * Auto-flush is not tied to the chat on screen. Each session drains on its
 * own ready/idle state. One session's hold, in-flight send, or disconnect
 * does not block the others. Host still drains `source: external` rows.
 */
import type { SessionState } from "@/lib/session";
import {
  getQueueForKey,
  shouldHoldFlushForLive,
  type QueuedSend,
} from "@/lib/sendQueue";

const FLUSHABLE: ReadonlySet<SessionState> = new Set(["ready", "idle"]);

/**
 * Queued follow-up aimed at a chat the user is not looking at.
 * That send must call `session_send` for the target id and must not
 * `ensureConnected` — connect adopts the workbench view.
 */
export function isBackgroundQueuedSend(opts: {
  fromQueue: boolean;
  targetSessionId: string | null | undefined;
  viewingSessionId: string | null | undefined;
}): boolean {
  if (!opts.fromQueue) return false;
  const target = opts.targetSessionId ?? null;
  if (!target) return false;
  return (opts.viewingSessionId ?? null) !== target;
}

export type QueueDrainPlanInput = {
  byKey: Record<string, QueuedSend[]>;
  stateByKey: Readonly<Record<string, SessionState | undefined>>;
  /** Queue key of the chat on screen (`__draft__` when there is no id). */
  viewedKey: string;
  inFlightKeys: ReadonlySet<string>;
  connectingKeys: ReadonlySet<string>;
  holdKeys: ReadonlySet<string>;
  /** Sync claim window — blocks a second send before `executeSend` locks. */
  drainingKeys: ReadonlySet<string>;
  liveSessionId: string | null | undefined;
  liveState: SessionState | null | undefined;
};

/**
 * Keys whose composer head should send now. Each key appears at most once.
 * `__draft__` drains only while that draft is the viewed chat.
 */
export function planBackgroundQueueDrain(input: QueueDrainPlanInput): string[] {
  const out: string[] = [];
  const keys = Object.keys(input.byKey).sort();
  for (const key of keys) {
    if (key === "__draft__" && key !== input.viewedKey) continue;
    const queue = getQueueForKey(input.byKey, key);
    if (!queue.length) continue;
    if (queue[0]?.source === "external") continue;
    if (input.inFlightKeys.has(key)) continue;
    if (input.connectingKeys.has(key)) continue;
    if (input.holdKeys.has(key)) continue;
    if (input.drainingKeys.has(key)) continue;
    const state = input.stateByKey[key];
    if (!state || !FLUSHABLE.has(state)) continue;
    const claimId = key === "__draft__" ? null : key;
    if (
      shouldHoldFlushForLive(input.liveSessionId, input.liveState, claimId)
    ) {
      continue;
    }
    out.push(key);
  }
  return out;
}

/** Real sessions whose queue must be dropped because the chat disconnected. */
export function disconnectedQueueKeys(
  byKey: Record<string, QueuedSend[]>,
  stateByKey: Readonly<Record<string, SessionState | undefined>>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(byKey)) {
    if (key === "__draft__") continue;
    if (stateByKey[key] === "disconnected") out.push(key);
  }
  return out.sort();
}

function isBusyState(state: SessionState | undefined): boolean {
  return state === "streaming" || state === "awaiting_permission";
}

/**
 * Holds to drop because that session entered a turn or left one, or
 * disconnected. A steady `ready` after a failed flush does not release —
 * releasing it would send the same follow-up again on the next tick.
 */
export function queueHoldKeysToRelease(opts: {
  prev: Readonly<Record<string, SessionState | undefined>>;
  next: Readonly<Record<string, SessionState | undefined>>;
  holdKeys: ReadonlySet<string>;
}): string[] {
  const released: string[] = [];
  for (const key of opts.holdKeys) {
    const now = opts.next[key];
    const was = opts.prev[key];
    if (now === "disconnected") {
      released.push(key);
      continue;
    }
    if (
      isBusyState(now) ||
      (isBusyState(was) && now !== undefined && !isBusyState(now))
    ) {
      released.push(key);
    }
  }
  return released.sort();
}
