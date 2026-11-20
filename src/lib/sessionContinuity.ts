/**
 * 会话上下文连续性视图。
 *
 * Host 的 checkpoint 只暴露状态码与覆盖计数；这里把它们翻译成可展示的横幅，
 * 让用户看到的 transcript 与模型实际收到的上下文边界保持一致。
 */
import type { MessageKey } from "@/i18n";

export type ContinuityStatus = "unverified" | "bootstrap_pending" | "verified";

/** `session://state` / `SessionSnapshot.continuity` 的安全子集。 */
export interface SessionContinuitySnapshot {
  status: ContinuityStatus;
  reason?: string | null;
  pendingPromptId?: string | null;
  bootstrapPromptId?: string | null;
  coveredMessageIds?: string[];
  coveredPromptCount?: number;
  bootstrapIncludedMessageIds?: string[];
  bootstrapOmittedFromMessageId?: string | null;
  bootstrapOmittedThroughMessageId?: string | null;
  bootstrapIncluded?: number;
  bootstrapOmitted?: number;
}

export type ContinuityBannerKind = "restored" | "pending" | "unverified";

export interface ContinuityBannerView {
  kind: ContinuityBannerKind;
  titleKey: MessageKey;
  detailKey: MessageKey;
  detailParams?: Record<string, string | number>;
}

/** 这些原因说明 Agent 历史与界面记录不一致，恢复不一定能自动完成。 */
const HISTORY_MISMATCH_REASONS = new Set([
  "checkpoint_missing",
  "checkpoint_corrupt",
  "agent_changed",
  "route_changed",
  "remote_unverified",
  "rewind_unverified",
  "history_missing",
  "history_empty",
  "history_partial",
  "history_mismatch",
  "history_corrupt",
  "history_ambiguous",
]);

/** 上一轮已发出但未确认落盘的回合；下一轮发送前会重新核验。 */
const TURN_PENDING_REASONS = new Set(["flush_unconfirmed", "turn_unconfirmed"]);

/**
 * 根据快照生成横幅。空会话、旧版 payload（无 continuity）或已核验且无 bootstrap 时不显示。
 *
 * @param continuity Host 快照中的连续性状态。
 * @param hasHistory 当前会话是否已有可见消息；为空时不提示恢复。
 * @param busy 会话正在连接或生成回复；此时不展示“待核验”，避免与流式输出争抢注意力。
 */
export function continuityBanner(
  continuity: SessionContinuitySnapshot | null | undefined,
  hasHistory: boolean,
  busy = false,
): ContinuityBannerView | null {
  if (!continuity || !hasHistory) return null;
  if (busy && continuity.status !== "verified") return null;
  if (continuity.status === "verified") {
    const included = continuity.bootstrapIncluded ?? 0;
    if (included <= 0) return null;
    const omitted = continuity.bootstrapOmitted ?? 0;
    return omitted > 0
      ? {
          kind: "restored",
          titleKey: "continuity.restored.title",
          detailKey: "continuity.restored.omitted",
          detailParams: { included, omitted },
        }
      : {
          kind: "restored",
          titleKey: "continuity.restored.title",
          detailKey: "continuity.restored.included",
          detailParams: { included },
        };
  }

  const reason = continuity.reason ?? "";
  if (TURN_PENDING_REASONS.has(reason)) {
    return {
      kind: "pending",
      titleKey: "continuity.pending.turnTitle",
      detailKey: "continuity.pending.turnBody",
    };
  }
  if (HISTORY_MISMATCH_REASONS.has(reason)) {
    return {
      kind: "unverified",
      titleKey: "continuity.unverified.title",
      detailKey: "continuity.unverified.body",
    };
  }
  if (!reason || reason === "no_prompt_yet") {
    // 旧版或刚创建的 checkpoint 可能没有原因码；只要有可见历史就按待核验处理。
    return reason === "no_prompt_yet"
      ? null
      : {
          kind: "pending",
          titleKey: "continuity.pending.title",
          detailKey: "continuity.pending.body",
        };
  }
  return {
    kind: "pending",
    titleKey: "continuity.pending.title",
    detailKey: "continuity.pending.body",
  };
}
