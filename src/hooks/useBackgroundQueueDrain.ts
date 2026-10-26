/**
 * Drain composer follow-up queues for every ready session, not only the
 * chat on screen. Live-map updates (background turn end) schedule a kick
 * without subscribing the workbench shell to the full map.
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import {
  disconnectedQueueKeys,
  planBackgroundQueueDrain,
  queueHoldKeysToRelease,
} from "@/lib/backgroundQueueDrain";
import type { SessionSnapshot, SessionState } from "@/lib/session";
import { sessionLiveMapStore } from "@/lib/sessionLiveMapStore";
import { queueSessionKey, type QueuedSend } from "@/lib/sendQueue";

const DRAIN_DEBOUNCE_MS = 40;

/**
 * Per-session states used by the drain planner.
 * The chat on screen uses the shell FSM (it can lead the map). A busy live
 * slot overlays that id so a stale `ready` cannot send into a live turn.
 */
export function readQueueDrainStates(opts: {
  sessionId: string | null;
  sessionState: SessionState;
  viewingSessionId: string | null;
  live: SessionSnapshot | null | undefined;
}): Record<string, SessionState | undefined> {
  const out: Record<string, SessionState | undefined> = {};
  const map = sessionLiveMapStore.getMap();
  for (const [id, row] of Object.entries(map)) {
    if (row?.state) out[id] = row.state;
  }
  const viewedKey = queueSessionKey(opts.viewingSessionId ?? opts.sessionId);
  out[viewedKey] = opts.sessionState;
  const liveId = opts.live?.sessionId;
  const liveState = opts.live?.state;
  if (
    liveId &&
    (liveState === "streaming" || liveState === "awaiting_permission")
  ) {
    out[liveId] = liveState;
  }
  return out;
}

export type BackgroundQueueDrainOpts = {
  sessionId: string | null;
  sessionState: SessionState;
  connecting: boolean;
  viewingSessionIdRef: RefObject<string | null>;
  liveHostRef: RefObject<SessionSnapshot>;
  sendQueueByKey: Record<string, QueuedSend[]>;
  sendQueueByKeyRef: RefObject<Record<string, QueuedSend[]>>;
  inFlightKeysRef?: RefObject<Set<string>>;
  sendInFlightRef: RefObject<boolean>;
  connectingKeysRef?: RefObject<Set<string>>;
  holdKeysRef: RefObject<Set<string>>;
  drainingKeysRef: RefObject<Set<string>>;
  scheduleDrainRef: MutableRefObject<() => void>;
  flushKey: (key: string) => void;
  onReleaseHolds: (keys: readonly string[]) => void;
  onDropSessions: (sessionIds: readonly string[]) => void;
};

export function useBackgroundQueueDrain(opts: BackgroundQueueDrainOpts): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const prevStateRef = useRef<Record<string, SessionState | undefined>>({});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const kick = () => {
      if (cancelled) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        const o = optsRef.current;
        const viewing = o.viewingSessionIdRef.current ?? o.sessionId;
        const viewedKey = queueSessionKey(viewing);
        const stateByKey = readQueueDrainStates({
          sessionId: o.sessionId,
          sessionState: o.sessionState,
          viewingSessionId: o.viewingSessionIdRef.current,
          live: o.liveHostRef.current,
        });
        const holds = o.holdKeysRef.current ?? new Set<string>();
        const release = queueHoldKeysToRelease({
          prev: prevStateRef.current,
          next: stateByKey,
          holdKeys: holds,
        });
        prevStateRef.current = stateByKey;
        if (release.length) o.onReleaseHolds(release);
        const drop = disconnectedQueueKeys(
          o.sendQueueByKeyRef.current ?? {},
          stateByKey,
        );
        if (drop.length) o.onDropSessions(drop);
        const byKey = o.sendQueueByKeyRef.current ?? {};
        const inFlight = new Set(o.inFlightKeysRef?.current ?? []);
        if (!o.inFlightKeysRef && o.sendInFlightRef.current) {
          inFlight.add(viewedKey);
        }
        const connectingKeys = new Set(o.connectingKeysRef?.current ?? []);
        if (!o.connectingKeysRef && o.connecting) {
          connectingKeys.add(viewedKey);
        }
        const keys = planBackgroundQueueDrain({
          byKey,
          stateByKey,
          viewedKey,
          inFlightKeys: inFlight,
          connectingKeys,
          holdKeys: o.holdKeysRef.current ?? new Set<string>(),
          drainingKeys: o.drainingKeysRef.current ?? new Set<string>(),
          liveSessionId: o.liveHostRef.current?.sessionId,
          liveState: o.liveHostRef.current?.state,
        });
        for (const key of keys) o.flushKey(key);
      }, DRAIN_DEBOUNCE_MS);
    };
    opts.scheduleDrainRef.current = kick;
    kick();
    const unsub = sessionLiveMapStore.subscribeMap(kick);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      opts.scheduleDrainRef.current = () => {};
      unsub();
    };
  }, [
    opts.connecting,
    opts.scheduleDrainRef,
    opts.sendQueueByKey,
    opts.sessionId,
    opts.sessionState,
  ]);
}
