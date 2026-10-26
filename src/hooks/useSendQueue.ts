import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { useBackgroundQueueDrain } from "@/hooks/useBackgroundQueueDrain";
import type { createT } from "@/i18n";
import * as api from "@/lib/api";
import type { Attachment } from "@/lib/attachments";
import type { SessionSnapshot, SessionState } from "@/lib/session";
import {
  applyClearSendQueuePlan,
  applyExternalQueuePush,
  applyExternalQueueTake,
  claimQueueHead,
  dropQueuesForSessions,
  enqueueSend,
  getQueueForKey,
  makeQueuedSend,
  migrateDraftQueue,
  moveQueuedSend,
  planClearSendQueue,
  queuePreviewText,
  queueSessionKey,
  removeQueuedSend,
  reorderQueuedSend,
  requeueAfterFlushFail,
  SEND_QUEUE_MAX,
  setQueueForKey,
  shouldEnqueueSend,
  shouldHoldFlushForLive,
  updateQueuedSend,
  type ClearSendQueuePlan,
  type ExternalQueuePush,
  type ExternalQueueTake,
  type QueueMoveDirection,
  type QueuedSend,
  type QueuedSendPatch,
} from "@/lib/sendQueue";

export type ExecuteSendFromQueue = (opts: {
  storedDisplay: string;
  att: Attachment[];
  quotes?: import("@/lib/composerQuotes").ComposerQuote[];
  goalMode: boolean;
  fromQueue: true;
  targetSessionId: string | null;
}) => Promise<boolean>;

type Translate = ReturnType<typeof createT>;

export type UseSendQueueOptions = {
  sessionId: string | null;
  sessionState: SessionState;
  connecting: boolean;
  liveHostRef: RefObject<SessionSnapshot>;
  viewingSessionIdRef: MutableRefObject<string | null>;
  /** Optional session-keyed claims; the boolean remains a legacy fallback. */
  sendInFlightRef: MutableRefObject<boolean>;
  sendInFlightBySessionRef?: MutableRefObject<Set<string>>;
  connectingBySessionRef?: MutableRefObject<Set<string>>;
  /** Always call via ref so flush sees the latest executeSend. */
  executeSendRef: MutableRefObject<ExecuteSendFromQueue>;
  showToast: (msg: string, ms?: number) => void;
  /** Primary window only — secondary has its own queue map and must not double-send. */
  acceptExternal?: boolean;
  tr: Translate;
};

/**
 * Per-session follow-up send queue: enqueue while busy, auto-flush every
 * ready session (not only the chat on screen), claim/requeue on flush
 * failure, hold that session after fail so it cannot spin or block others.
 */
export function useSendQueue({
  sessionId,
  sessionState,
  connecting,
  liveHostRef,
  viewingSessionIdRef,
  sendInFlightRef,
  sendInFlightBySessionRef,
  connectingBySessionRef,
  executeSendRef,
  showToast,
  acceptExternal = false,
  tr,
}: UseSendQueueOptions) {
  const labels = useMemo(
    () => ({
      sendFailed: tr("composer.queueSendFailed"),
      droppedOldest: (n: number, max: number) =>
        tr("composer.queueDroppedOldest", {
          n: String(n),
          max: String(max),
        }),
      externalAdded: (preview: string) =>
        tr("composer.queueExternalAdded", { preview }),
      externalAddedOther: (preview: string) =>
        tr("composer.queueExternalAddedOther", { preview }),
    }),
    [tr],
  );
  const [sendQueueByKey, setSendQueueByKey] = useState<
    Record<string, QueuedSend[]>
  >({});
  const sendQueueByKeyRef = useRef(sendQueueByKey);
  sendQueueByKeyRef.current = sendQueueByKey;

  const queueFlushHoldByKeyRef = useRef<Set<string>>(new Set());
  /** Sync claim window so a second tick cannot send the same head twice. */
  const drainingKeysRef = useRef<Set<string>>(new Set());
  const scheduleDrainRef = useRef<() => void>(() => {});
  /** UI-visible hold (ref alone does not re-render). */
  const [flushHold, setFlushHold] = useState(false);

  const activeQueue = useMemo(
    () => getQueueForKey(sendQueueByKey, queueSessionKey(sessionId)),
    [sendQueueByKey, sessionId],
  );

  const viewedQueueKey = useCallback(
    () => queueSessionKey(viewingSessionIdRef.current ?? sessionId),
    [sessionId, viewingSessionIdRef],
  );

  const isSendInFlightForKey = useCallback(
    (key: string) =>
      sendInFlightBySessionRef
        ? sendInFlightBySessionRef.current.has(key)
        : sendInFlightRef.current,
    [sendInFlightBySessionRef, sendInFlightRef],
  );

  const isConnectingForKey = useCallback(
    (key: string) =>
      connectingBySessionRef
        ? connectingBySessionRef.current.has(key)
        : connecting,
    [connectingBySessionRef, connecting],
  );

  const setHoldForKey = useCallback(
    (key: string, on: boolean) => {
      const holds = queueFlushHoldByKeyRef.current;
      if (on) holds.add(key);
      else holds.delete(key);
      // The strip represents the queue currently on screen only. A failed
      // background queue must not paint/hold this session's composer.
      setFlushHold(holds.has(viewedQueueKey()));
    },
    [viewedQueueKey],
  );

  const setHold = useCallback(
    (on: boolean) => setHoldForKey(viewedQueueKey(), on),
    [setHoldForKey, viewedQueueKey],
  );

  const releaseFlushHold = useCallback(() => {
    setHold(false);
  }, [setHold]);

  const releaseHolds = useCallback(
    (keys: readonly string[]) => {
      if (!keys.length) return;
      let changed = false;
      for (const key of keys) {
        if (queueFlushHoldByKeyRef.current.delete(key)) changed = true;
      }
      if (changed) {
        setFlushHold(queueFlushHoldByKeyRef.current.has(viewedQueueKey()));
      }
    },
    [viewedQueueKey],
  );

  const writeMap = useCallback((next: Record<string, QueuedSend[]>) => {
    sendQueueByKeyRef.current = next;
    setSendQueueByKey(next);
  }, []);

  // Host session API: mid-turn external prompts join this same map so the
  // composer strip updates immediately (drawing / tools / streaming).
  useEffect(() => {
    if (!acceptExternal || !api.hasHost()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenTake: (() => void) | undefined;
    let retryTimer: number | null = null;
    let wakeRetry: (() => void) | null = null;
    const onPush = (push: ExternalQueuePush) => {
      if (cancelled) return;
      const r = applyExternalQueuePush(sendQueueByKeyRef.current, push);
      if (!r.added) return;
      writeMap(r.byKey);
      if (r.dropped > 0) {
        showToast(labels.droppedOldest(r.dropped, SEND_QUEUE_MAX), 3200);
      }
      const preview = queuePreviewText(push.prompt ?? "", [], 48);
      const viewId = viewingSessionIdRef.current ?? sessionId;
      const same = !!viewId && viewId === (push.sessionId ?? "").trim();
      const toast = same
        ? labels.externalAdded?.(preview)
        : labels.externalAddedOther?.(preview);
      if (toast) showToast(toast, same ? 2800 : 4200);
    };
    const onTake = (take: ExternalQueueTake) => {
      if (cancelled) return;
      const r = applyExternalQueueTake(sendQueueByKeyRef.current, take);
      if (!r.removed) return;
      writeMap(r.byKey);
    };
    const register = async () => {
      let attempt = 0;
      while (!cancelled) {
        try {
          const fn = await api.listen<ExternalQueuePush>(
            "session://send_queue",
            onPush,
          );
          const fnTake = await api.listen<ExternalQueueTake>(
            "session://send_queue_take",
            onTake,
          );
          if (cancelled) {
            fn();
            fnTake();
          } else {
            unlisten = fn;
            unlistenTake = fnTake;
          }
          return;
        } catch (e) {
          if (cancelled) return;
          const delayMs = Math.min(5_000, 250 * 2 ** Math.min(attempt, 4));
          attempt += 1;
          if (attempt === 1 || attempt % 5 === 0) {
            console.warn(
              "[send-queue] external listener registration failed; retrying",
              e,
            );
          }
          await new Promise<void>((resolve) => {
            wakeRetry = resolve;
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              wakeRetry = null;
              resolve();
            }, delayMs);
          });
        }
      }
    };
    void register();
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      wakeRetry?.();
      wakeRetry = null;
      unlisten?.();
      unlistenTake?.();
    };
  }, [
    acceptExternal,
    labels,
    sessionId,
    showToast,
    viewingSessionIdRef,
    writeMap,
  ]);

  /** Enqueue a follow-up for the *viewed* session (ref, not stale React id). */
  const enqueue = useCallback(
    (input: {
      storedDisplay: string;
      attachments: Attachment[];
      quotes?: import("@/lib/composerQuotes").ComposerQuote[];
      goalMode: boolean;
    }) => {
      // Prefer viewing ref so a mid-render session switch cannot mis-key the item.
      const key = queueSessionKey(viewingSessionIdRef.current ?? sessionId);
      const item = makeQueuedSend(input);
      const r = enqueueSend(
        getQueueForKey(sendQueueByKeyRef.current, key),
        item,
      );
      writeMap(setQueueForKey(sendQueueByKeyRef.current, key, r.queue));
      if (r.dropped > 0) {
        showToast(labels.droppedOldest(r.dropped, SEND_QUEUE_MAX), 3200);
      }
      return r.dropped;
    },
    [sessionId, viewingSessionIdRef, showToast, labels, writeMap],
  );

  const removeItem = useCallback(
    (id: string) => {
      const key = queueSessionKey(sessionId);
      const next = setQueueForKey(
        sendQueueByKeyRef.current,
        key,
        removeQueuedSend(getQueueForKey(sendQueueByKeyRef.current, key), id),
      );
      writeMap(next);
    },
    [sessionId, writeMap],
  );

  const updateItem = useCallback(
    (id: string, patch: QueuedSendPatch) => {
      const key = queueSessionKey(sessionId);
      const prev = getQueueForKey(sendQueueByKeyRef.current, key);
      const updated = updateQueuedSend(prev, id, patch);
      if (updated === prev) return false;
      writeMap(setQueueForKey(sendQueueByKeyRef.current, key, updated));
      return true;
    },
    [sessionId, writeMap],
  );

  /** Reorder one step; does not pause or trigger flush beyond normal state. */
  const moveItem = useCallback(
    (id: string, direction: QueueMoveDirection) => {
      const key = queueSessionKey(sessionId);
      const prev = getQueueForKey(sendQueueByKeyRef.current, key);
      const updated = moveQueuedSend(prev, id, direction);
      if (updated === prev) return false;
      writeMap(setQueueForKey(sendQueueByKeyRef.current, key, updated));
      return true;
    },
    [sessionId, writeMap],
  );

  /** Reorder by index (clamp via pure helper); same flush semantics as moveItem. */
  const reorderItem = useCallback(
    (fromIndex: number, toIndex: number) => {
      const key = queueSessionKey(sessionId);
      const prev = getQueueForKey(sendQueueByKeyRef.current, key);
      const updated = reorderQueuedSend(prev, fromIndex, toIndex);
      if (updated === prev) return false;
      writeMap(setQueueForKey(sendQueueByKeyRef.current, key, updated));
      return true;
    },
    [sessionId, writeMap],
  );

  /**
   * Clear the viewed session queue.
   * Prefer planning with {@link planClearQueue} + GlassModal confirm when
   * `confirmNeeded` before calling this (never window.confirm).
   */
  const clearQueue = useCallback((): ClearSendQueuePlan => {
    const key = queueSessionKey(sessionId);
    const prev = getQueueForKey(sendQueueByKeyRef.current, key);
    const plan = planClearSendQueue(prev);
    writeMap(applyClearSendQueuePlan(sendQueueByKeyRef.current, key, plan));
    setHoldForKey(key, false);
    return plan;
  }, [sessionId, writeMap, setHoldForKey]);

  /** Pure clear plan for the viewed queue (does not mutate). */
  const planClearQueue = useCallback((): ClearSendQueuePlan => {
    const key = queueSessionKey(sessionId);
    return planClearSendQueue(getQueueForKey(sendQueueByKeyRef.current, key));
  }, [sessionId]);

  const clearDraftQueue = useCallback(() => {
    writeMap(setQueueForKey(sendQueueByKeyRef.current, "__draft__", []));
    setHoldForKey("__draft__", false);
  }, [writeMap, setHoldForKey]);

  const dropSessions = useCallback(
    (sessionIds: Iterable<string>) => {
      const ids = [...sessionIds];
      const next = dropQueuesForSessions(sendQueueByKeyRef.current, ids);
      let holdsChanged = false;
      for (const id of ids) {
        const key = queueSessionKey(id);
        if (queueFlushHoldByKeyRef.current.delete(key)) holdsChanged = true;
        drainingKeysRef.current.delete(key);
      }
      if (next !== sendQueueByKeyRef.current) writeMap(next);
      if (holdsChanged) {
        setFlushHold(queueFlushHoldByKeyRef.current.has(viewedQueueKey()));
      }
    },
    [viewedQueueKey, writeMap],
  );

  const migrateDraft = useCallback(
    (newSessionId: string) => {
      const next = migrateDraftQueue(sendQueueByKeyRef.current, newSessionId);
      if (next !== sendQueueByKeyRef.current) writeMap(next);
    },
    [writeMap],
  );

  /**
   * Claim and send the head of one session queue.
   * The key is that session's own id — never the live host id.
   */
  const flushKey = useCallback(
    (claimKey: string) => {
      if (drainingKeysRef.current.has(claimKey)) return;
      if (isSendInFlightForKey(claimKey)) return;
      if (isConnectingForKey(claimKey)) return;
      if (queueFlushHoldByKeyRef.current.has(claimKey)) return;
      const queued = getQueueForKey(sendQueueByKeyRef.current, claimKey);
      if (!queued.length || queued[0]?.source === "external") return;

      const live = liveHostRef.current;
      const claimSessionId = claimKey === "__draft__" ? null : claimKey;
      // Same-session busy only. A foreign live turn must not block this key.
      if (shouldHoldFlushForLive(live.sessionId, live.state, claimSessionId)) {
        return;
      }

      drainingKeysRef.current.add(claimKey);
      const claimed = claimQueueHead(sendQueueByKeyRef.current, claimKey);
      if (!claimed) {
        drainingKeysRef.current.delete(claimKey);
        return;
      }
      const { head } = claimed;
      const targetSessionId = claimSessionId;
      writeMap(claimed.byKey);

      void (async () => {
        try {
          const ok = await executeSendRef.current({
            storedDisplay: head.storedDisplay,
            att: head.attachments,
            quotes: head.quotes,
            goalMode: head.goalMode,
            fromQueue: true,
            targetSessionId,
          });
          if (ok) return;
          const r = requeueAfterFlushFail(
            sendQueueByKeyRef.current,
            claimKey,
            head,
          );
          writeMap(r.byKey);
          const viewedNow = queueSessionKey(viewingSessionIdRef.current);
          if (claimKey !== viewedNow) {
            // Background failure holds only this key so it cannot spin,
            // and so the chat on screen is not painted as held.
            setHoldForKey(claimKey, true);
          } else {
            // Hold only while the session is still live/busy. Terminal
            // failures must release the key so the viewed chat can recover.
            const liveAfter = liveHostRef.current;
            const terminal =
              liveAfter.state === "ready" ||
              liveAfter.state === "disconnected" ||
              !!liveAfter.lastError;
            setHoldForKey(claimKey, !terminal);
          }
          if (r.dropped > 0) {
            showToast(labels.droppedOldest(r.dropped, SEND_QUEUE_MAX), 3500);
          } else if (claimKey === viewedNow) {
            showToast(labels.sendFailed, 3500);
          }
        } catch (e) {
          // Keep a rejected executeSend from leaving the queue claimed.
          // Requeue is idempotent by item id.
          const r = requeueAfterFlushFail(
            sendQueueByKeyRef.current,
            claimKey,
            head,
          );
          writeMap(r.byKey);
          const viewedNow = queueSessionKey(viewingSessionIdRef.current);
          setHoldForKey(claimKey, claimKey !== viewedNow);
          console.warn("[send-queue] flush failed", e);
        } finally {
          drainingKeysRef.current.delete(claimKey);
          scheduleDrainRef.current();
        }
      })();
    },
    [
      liveHostRef,
      viewingSessionIdRef,
      executeSendRef,
      showToast,
      labels,
      writeMap,
      setHoldForKey,
      isSendInFlightForKey,
      isConnectingForKey,
    ],
  );

  const flush = useCallback(() => {
    flushKey(viewedQueueKey());
  }, [flushKey, viewedQueueKey]);

  useBackgroundQueueDrain({
    sessionId,
    sessionState,
    connecting,
    viewingSessionIdRef,
    liveHostRef,
    sendQueueByKey,
    sendQueueByKeyRef,
    inFlightKeysRef: sendInFlightBySessionRef,
    sendInFlightRef,
    connectingKeysRef: connectingBySessionRef,
    holdKeysRef: queueFlushHoldByKeyRef,
    drainingKeysRef,
    scheduleDrainRef,
    flushKey,
    onReleaseHolds: releaseHolds,
    onDropSessions: dropSessions,
  });

  // Clear the viewed key's hold once a real turn is in progress again, and on
  // terminal/disconnected transitions. Holds for other sessions remain local.
  const previousSessionStateRef = useRef(sessionState);
  useEffect(() => {
    const key = viewedQueueKey();
    const wasBusy =
      previousSessionStateRef.current === "streaming" ||
      previousSessionStateRef.current === "awaiting_permission";
    const isBusy =
      sessionState === "streaming" || sessionState === "awaiting_permission";
    if (isBusy || (wasBusy && !isBusy) || sessionState === "disconnected") {
      setHoldForKey(key, false);
    }
    previousSessionStateRef.current = sessionState;
  }, [sessionState, sessionId, setHoldForKey, viewedQueueKey]);

  // Keep the visible strip in sync when navigation changes without touching
  // another session's hold bit.
  useEffect(() => {
    setFlushHold(queueFlushHoldByKeyRef.current.has(viewedQueueKey()));
  }, [sessionId, viewedQueueKey]);

  /** Clear hold and try flush immediately (user retry). */
  const resumeFlush = useCallback(() => {
    setHold(false);
    // Defer so ref/state settle before claim.
    window.setTimeout(() => flush(), 0);
  }, [setHold, flush]);

  /** Pause auto-flush (e.g. while editing a queued item). */
  const pauseFlush = useCallback(() => {
    setHold(true);
  }, [setHold]);

  return {
    activeQueue,
    flushHold,
    enqueue,
    removeItem,
    updateItem,
    moveItem,
    reorderItem,
    clearQueue,
    planClearQueue,
    clearDraftQueue,
    dropSessions,
    migrateDraft,
    releaseFlushHold,
    pauseFlush,
    resumeFlush,
    shouldEnqueue: (state: SessionState, conn: boolean) =>
      shouldEnqueueSend(state, conn),
    canShowQueueButton: (
      state: SessionState,
      conn: boolean,
      hasBody: boolean,
    ) => hasBody && shouldEnqueueSend(state, conn),
  };
}
