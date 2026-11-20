import { useEffect, useMemo, useState } from "react";

import * as api from "@/lib/api";
import {
  continuityBanner,
  type ContinuityBannerView,
  type SessionContinuitySnapshot,
} from "@/lib/sessionContinuity";
import type { SessionSnapshot } from "@/lib/session";

/**
 * 为当前查看的会话派生上下文恢复横幅。
 *
 * live 快照优先；打开尚未连接的会话时，改为读取该会话持久化的 checkpoint。
 * `hasHistory` 由调用方按当前 transcript 提供，避免把空会话误判为需要恢复。
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

  useEffect(() => {
    // live 快照缺少原因码时（刚创建或旧 payload）仍读取持久化 checkpoint 作为补充。
    if (!sessionId || liveContinuity?.reason) {
      setPersisted(null);
      return;
    }
    let cancelled = false;
    void api
      .sessionContinuityState(sessionId)
      .then((value) => {
        if (!cancelled) setPersisted(value);
      })
      .catch(() => {
        if (!cancelled) setPersisted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, liveContinuity]);

  const busy =
    session.state === "connecting" ||
    session.state === "streaming" ||
    session.state === "awaiting_permission";
  // 没有原因码的 live 快照只是占位（刚创建或连接失败），持久化记录才反映真实状态。
  const continuity = useMemo(
    () =>
      liveContinuity?.reason ? liveContinuity : (persisted ?? liveContinuity),
    [liveContinuity, persisted],
  );
  return useMemo(
    () => continuityBanner(continuity, hasHistory, busy),
    [continuity, hasHistory, busy],
  );
}
