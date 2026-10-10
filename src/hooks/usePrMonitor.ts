/**
 * usePrMonitor — branch-bound PR state for the composer chip and the wake loop.
 *
 * Responsibilities:
 * - resolve the PR bound to the current branch (git-native: the PR whose head
 *   branch is the current branch) and whether a host watch is mounted;
 * - mount / unmount the host watch (the host is the source of truth for mounts,
 *   so a UI remount re-reads them instead of guessing);
 * - on `pr-monitor://update`, diff the two snapshots and hand the session a
 *   localized follow-up turn through `session_send`;
 * - never interrupt a running turn: a wake waits for the session to be idle;
 * - deliver each real change once, and remember delivered changes across a
 *   remount so a re-render cannot double-wake.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createT, type Locale } from "@/i18n";
import * as api from "@/lib/api";
import type { GitPrCheckEntry, GitPrHubEntry } from "@/lib/gitPrHub";
import {
  bindPrToBranch,
  buildPrUpdatePrompt,
  diffPrSnapshots,
  isWakeKeySeen,
  prWakeKey,
  rememberWakeKey,
  shouldAutoUnwatch,
  type PrMonitorUpdateEvent,
  type PrMonitorWatcherInfo,
  type PrUpdate,
  type PrWakeComment,
} from "@/lib/prMonitor";

export type UsePrMonitorOptions = {
  /** Desktop host, a bound project and a real branch are all required. */
  enabled: boolean;
  projectPath: string | null;
  /** Current branch; `null` for detached HEAD / unknown. */
  branch: string | null;
  sessionId: string | null;
  locale: Locale;
  /** True while a turn streams or a permission prompt is pending. */
  sessionBusy: boolean;
  /**
   * Wake transport. Defaults to the shipped `session_send`; injectable so the
   * follow-up path can be driven without a live agent.
   */
  sendTurn?: (text: string, sessionId: string | null) => Promise<void>;
  /** Short status message for the user (toast). */
  notify?: (message: string, tone: "info" | "error") => void;
};

export type UsePrMonitorResult = {
  /** First resolution finished (so the chip can avoid a flash). */
  ready: boolean;
  /** `gh`/git availability as reported by the host; `null` while unknown. */
  available: boolean | null;
  reason: string | null;
  /** PR bound to the current branch, or `null` (never invented). */
  pr: GitPrHubEntry | null;
  /** A host watch is mounted for this project + branch. */
  watching: boolean;
  /** A watch/unwatch call is in flight. */
  busy: boolean;
  /** Last change that woke (or is about to wake) the session. */
  lastUpdates: PrUpdate[] | null;
  /** Wakes waiting for an idle session. */
  pendingCount: number;
  /** Mount or unmount the watch for the bound PR. */
  toggleWatch: () => void;
};

type QueuedWake = {
  key: string;
  event: PrMonitorUpdateEvent;
  updates: PrUpdate[];
  attempts: number;
};

type Tr = ReturnType<typeof createT>;

function sameProjectPath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function sameWatch(
  watcher: PrMonitorWatcherInfo,
  projectPath: string,
  branch: string,
): boolean {
  return sameProjectPath(watcher.projectPath, projectPath) && watcher.branch === branch;
}

/**
 * Build the follow-up turn for one queued change.
 *
 * The host snapshot only carries excerpts and check counts, so the full comment
 * body and the failed-check rows come from the shipped PR commands — falling
 * back to the excerpt when a fetch does not work.
 */
export async function buildWakePrompt(
  item: QueuedWake,
  projectPath: string,
  tr: Tr,
): Promise<string> {
  const { event, updates } = item;
  const prNumber = event.prNumber;

  let newestComment: PrWakeComment | null = null;
  const commentUpdate = updates.find(
    (u): u is Extract<PrUpdate, { kind: "comment" | "review" }> =>
      u.kind === "comment" || u.kind === "review",
  );
  if (commentUpdate) {
    try {
      const res = await api.gitPrComments(projectPath, prNumber);
      const hit = (res.comments ?? []).find(
        (c) => c.id === commentUpdate.commentId,
      );
      if (hit) {
        newestComment = {
          author: hit.author || commentUpdate.author,
          body: hit.body || hit.excerpt || commentUpdate.excerpt,
          kind: hit.kind,
          state: hit.state ?? null,
          url: hit.url ?? null,
        };
      }
    } catch {
      // Soft-fail: fall back to the snapshot excerpt below.
    }
    if (!newestComment) {
      newestComment = {
        author: commentUpdate.author,
        body: commentUpdate.excerpt,
        kind: commentUpdate.kind,
        state: commentUpdate.state ?? null,
        url: null,
      };
    }
  }

  let failedChecks: GitPrCheckEntry[] | null = null;
  if (updates.some((u) => u.kind === "checks_failed")) {
    try {
      const res = await api.gitPrChecks(projectPath, prNumber);
      failedChecks = res.checks ?? null;
    } catch {
      // Soft-fail: the fix-CI block then asks the agent to investigate itself.
    }
  }

  return buildPrUpdatePrompt({
    prNumber,
    title: event.next.title || event.title,
    url: event.next.url || event.url,
    headRef: event.next.headRefName,
    baseRef: event.next.baseRefName,
    updates,
    newestComment,
    failedChecks,
    checksSummary: event.next.checks ?? null,
    tr,
  });
}

export function usePrMonitor(opts: UsePrMonitorOptions): UsePrMonitorResult {
  const { enabled, projectPath, branch, sessionId, locale, sessionBusy } = opts;

  const tr = useMemo(() => createT(locale), [locale]);
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [pr, setPr] = useState<GitPrHubEntry | null>(null);
  const [watcher, setWatcher] = useState<PrMonitorWatcherInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdates, setLastUpdates] = useState<PrUpdate[] | null>(null);
  const [queue, setQueue] = useState<QueuedWake[]>([]);

  // Delivery memory + live refs (event handlers must not re-subscribe per render).
  const seenRef = useRef<readonly string[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const projectRef = useRef<string | null>(projectPath);
  projectRef.current = projectPath;
  const branchRef = useRef<string | null>(branch);
  branchRef.current = branch;
  const sessionRef = useRef<string | null>(sessionId);
  sessionRef.current = sessionId;
  const flushingRef = useRef(false);

  const sendTurn = useCallback(async (text: string, sid: string | null) => {
    const custom = optsRef.current.sendTurn;
    if (custom) {
      await custom(text, sid);
      return;
    }
    await api.sessionSend(text, null, sid);
  }, []);

  /** Fold a host update into UI state and queue a wake for a real change. */
  const handleUpdate = useCallback((event: PrMonitorUpdateEvent) => {
    const currentProject = projectRef.current;
    const currentBranch = branchRef.current;
    if (!event || !currentProject || !currentBranch) return;
    if (!sameProjectPath(event.projectPath, currentProject)) return;
    if (event.branch !== currentBranch) return;

    const key = prWakeKey(event);
    if (!key || isWakeKeySeen(seenRef.current, key)) return;

    const updates = diffPrSnapshots(event.prev, event.next);
    // Keep the chip honest even when there is nothing worth waking for.
    setPr((current) =>
      current && current.number === event.prNumber
        ? { ...current, title: event.next.title || current.title, state: event.next.state }
        : current,
    );
    setWatcher((current) =>
      current && current.prNumber === event.prNumber
        ? { ...current, snapshot: event.next, lastUpdateAt: event.at }
        : current,
    );
    if (updates.length === 0) {
      void api.prMonitorConsumePending(event.projectPath, event.branch);
      return;
    }

    seenRef.current = rememberWakeKey(seenRef.current, key);
    setLastUpdates(updates);
    setQueue((current) =>
      current.some((item) => item.key === key)
        ? current
        : [...current, { key, event, updates, attempts: 0 }],
    );
  }, []);

  const handleUpdateRef = useRef(handleUpdate);
  handleUpdateRef.current = handleUpdate;

  // ── Resolve the bound PR + mounted watch for this project/branch ──────────
  useEffect(() => {
    let cancelled = false;
    if (!enabled || !projectPath || !branch) {
      setPr(null);
      setWatcher(null);
      setAvailable(enabled ? null : false);
      setReason(null);
      setReady(true);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const [list, watches] = await Promise.all([
          api.gitPrList(projectPath, { limit: 30, state: "open" }),
          api.prMonitorList(),
        ]);
        if (cancelled) return;
        setAvailable(!!list.available);
        setReason(list.reason ?? null);
        setPr(bindPrToBranch(list.prs ?? [], branch));
        const mine =
          (watches ?? []).find((w) => sameWatch(w, projectPath, branch)) ?? null;
        setWatcher(mine);
        // A change that arrived while the UI was not listening is still here.
        if (mine?.pending) {
          handleUpdateRef.current(mine.pending);
          void api.prMonitorConsumePending(projectPath, branch);
        }
      } catch (e) {
        if (cancelled) return;
        setAvailable(false);
        setReason(String(e));
        setPr(null);
        setWatcher(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectPath, branch]);

  // ── Subscribe to host updates while a mount is possible ───────────────────
  useEffect(() => {
    if (!enabled || !projectPath || !branch) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const off = await api.onPrMonitorUpdate((payload) =>
        handleUpdateRef.current(payload),
      );
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, projectPath, branch]);

  // ── Deliver queued wakes once the session can take a turn ─────────────────
  useEffect(() => {
    if (queue.length === 0 || sessionBusy || flushingRef.current) return;
    const item = queue[0];
    const currentProject = projectRef.current;
    const currentBranch = branchRef.current;
    if (!currentProject || !currentBranch) return;

    flushingRef.current = true;
    void (async () => {
      try {
        const prompt = await buildWakePrompt(item, currentProject, tr);
        if (!prompt) {
          setQueue((current) => current.filter((q) => q.key !== item.key));
          return;
        }
        await sendTurn(prompt, sessionRef.current);
        optsRef.current.notify?.(
          tr("prMonitor.wokeToast", { number: item.event.prNumber }),
          "info",
        );
        setQueue((current) => current.filter((q) => q.key !== item.key));
        // A merged/closed PR is done: stop the host polling it forever.
        if (shouldAutoUnwatch(item.event.next)) {
          await api.prMonitorUnwatch(currentProject, currentBranch);
          setWatcher(null);
          setPr(null);
          optsRef.current.notify?.(
            tr("prMonitor.terminal", { state: item.event.next.state }),
            "info",
          );
        }
      } catch (e) {
        if (item.attempts >= 1) {
          optsRef.current.notify?.(
            tr("prMonitor.wakeFailed", { reason: String(e) }),
            "error",
          );
          setQueue((current) => current.filter((q) => q.key !== item.key));
        } else {
          // One retry: the transport may have been mid-reconnect.
          setQueue((current) =>
            current.map((q) =>
              q.key === item.key ? { ...q, attempts: q.attempts + 1 } : q,
            ),
          );
        }
      } finally {
        flushingRef.current = false;
      }
    })();
  }, [queue, sessionBusy, sendTurn, tr]);

  const toggleWatch = useCallback(() => {
    const currentProject = projectRef.current;
    const currentBranch = branchRef.current;
    if (!currentProject || !currentBranch || busy) return;
    setBusy(true);
    void (async () => {
      try {
        if (watcher) {
          await api.prMonitorUnwatch(currentProject, currentBranch);
          setWatcher(null);
          setQueue([]);
          return;
        }
        const bound = pr;
        if (!bound) return;
        const res = await api.prMonitorWatch({
          projectPath: currentProject,
          branch: currentBranch,
          prNumber: bound.number,
          sessionId: sessionRef.current,
        });
        if (!res.ok || !res.watcher) {
          throw new Error(res.error || "watch failed");
        }
        setWatcher(res.watcher);
        // Seed the baseline now so the chip shows real checks/state and the
        // first scheduled tick cannot look like a change.
        const polled = await api.prMonitorPollNow(currentProject, currentBranch);
        if (polled.watcher) setWatcher(polled.watcher);
      } catch (e) {
        optsRef.current.notify?.(
          tr("prMonitor.watchFailed", { reason: String(e) }),
          "error",
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, pr, tr, watcher]);

  return {
    ready,
    available,
    reason,
    pr,
    watching: !!watcher,
    busy,
    lastUpdates,
    pendingCount: queue.length,
    toggleWatch,
  };
}
