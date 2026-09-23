/**
 * Subscribe the Tasks panel to subagent telemetry (BOR-55).
 *
 * One module-level subscription feeds a per-session store; components re-render
 * only when the store revision bumps (`listen` established once, soft-fail on
 * missing host). Mirrors {@link ./usePendingModelSwitch}.
 */
import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@/lib/api/host";
import {
  applySubagentEvent,
  type SubagentEventPayload,
  type SubagentRun,
} from "@/lib/session/subagents";

type Listener = () => void;

const EMPTY: readonly SubagentRun[] = [];

class SubagentStore {
  private readonly bySession = new Map<string, SubagentRun[]>();
  private readonly listeners = new Set<Listener>();
  private rev = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Bump-on-change revision — identity for useSyncExternalStore. */
  getSnapshot = (): number => this.rev;

  /** Merged runs for one session, in spawn order. Stable when unchanged. */
  list(sessionId: string | null | undefined): readonly SubagentRun[] {
    if (!sessionId) return EMPTY;
    return this.bySession.get(sessionId) ?? EMPTY;
  }

  apply(payload: SubagentEventPayload): void {
    const sid = typeof payload.sessionId === "string" ? payload.sessionId : "";
    if (!sid) return;
    const prev = this.bySession.get(sid) ?? [];
    const next = applySubagentEvent(prev, payload);
    if (next === prev) return;
    this.bySession.set(sid, next);
    this.rev += 1;
    for (const l of this.listeners) l();
  }

  resetForTests(): void {
    this.bySession.clear();
    this.rev += 1;
    for (const l of this.listeners) l();
  }
}

export const subagentStore = new SubagentStore();

let subscriptionStarted = false;

function ensureSubscription(): void {
  if (subscriptionStarted) return;
  subscriptionStarted = true;
  void listen<SubagentEventPayload>("session://subagent", (p) => {
    subagentStore.apply(p);
  }).catch(() => {
    subscriptionStarted = false;
  });
}

/** Merged subagent runs for `sessionId` (empty when none / no session). */
export function useSubagents(
  sessionId: string | null | undefined,
): readonly SubagentRun[] {
  useEffect(() => {
    ensureSubscription();
  }, []);
  useSyncExternalStore(
    subagentStore.subscribe,
    subagentStore.getSnapshot,
  );
  return subagentStore.list(sessionId);
}
