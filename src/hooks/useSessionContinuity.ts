import { useEffect, useMemo, useState } from "react";

import * as api from "@/lib/api";
import {
  continuityBanner,
  type ContinuityBannerView,
  type SessionContinuitySnapshot,
} from "@/lib/sessionContinuity";
import type { SessionSnapshot } from "@/lib/session";

/** 回合结束后可能晚于最后一次状态事件落盘的待核验原因。 */
const TURN_PENDING_REASONS = new Set(["turn_unconfirmed", "flush_unconfirmed"]);

/**
 * 为当前查看的会话派生上下文恢复横幅。
 *
 * live 快照优先；打开尚未连接的会话时，改为读取该会话持久化的 checkpoint。
 * 回合结束后 Host 的核验可能晚于最后一次 state 事件，空闲时再读一次持久化记录，
 * 避免界面停留在“上一轮未确认”。
 */
export function useSessionContinuity(
  session: SessionSnapshot,
  hasHistory: boolean,
): ContinuityBannerView | null {
  const [persisted, setPersisted] = useState<SessionContinuitySnapshot | null>(
    null,
  );
  const sessionId = session.sessionId;
  const liveContinuity = session.continuity;
  const busy =
    session.state === "connecting" ||
    session.state === "streaming" ||
    session.state === "awaiting_permission";
  const liveReason = liveContinuity?.reason ?? "";

  useEffect(() => {
    const refreshAfterTurn = !busy && TURN_PENDING_REASONS.has(liveReason);
    if (!sessionId || (liveContinuity?.reason && !refreshAfterTurn)) {
      setPersisted(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (attempt: number) => {
      void api
        .sessionContinuityState(sessionId)
        .then((value) => {
          if (cancelled) return;
          setPersisted(value);
          // 核验落盘可能晚于“回合结束”状态事件；最多补读两次，仍失败则保留待恢复提示。
          if (
            refreshAfterTurn &&
            value?.status !== "verified" &&
            attempt < 2
          ) {
            timer = setTimeout(() => load(attempt + 1), 1200);
          }
        })
        .catch(() => {
          if (!cancelled) setPersisted(null);
        });
    };
    load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, liveReason, busy]);

  const continuity = useMemo(() => {
    // 回合已结束且磁盘记录显示已核验：以后者为准，修复丢失的状态事件。
    if (
      !busy &&
      persisted?.status === "verified" &&
      TURN_PENDING_REASONS.has(liveReason)
    ) {
      return persisted;
    }
    // 没有原因码的 live 快照只是占位（刚创建或连接失败），持久化记录才反映真实状态。
    return liveContinuity?.reason
      ? liveContinuity
      : (persisted ?? liveContinuity);
  }, [liveContinuity, persisted, busy]);

  return useMemo(
    () => continuityBanner(continuity, hasHistory, busy),
    [continuity, hasHistory, busy],
  );
}
