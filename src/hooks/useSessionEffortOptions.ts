/**
 * 按当前聊天解析推理档位；自定义 provider 目录未就绪或模型不支持时，
 * 暂停协调，避免旧偏好覆盖当前选择。
 */

import { useEffect, useMemo } from "react";
import type { ModelOption } from "@/lib/grokCatalog";
import {
  pickSessionEffort,
  resolveSessionEffortOptions,
  type SessionEffortProvider,
} from "@/lib/sessionEffort";

/** 按当前会话的 provider/model 解析档位，并在有效目录变化时协调已保存值。 */
export function useSessionEffortOptions(opts: {
  source: "official" | "custom";
  provider: SessionEffortProvider | null;
  modelId: string;
  officialModels: ModelOption[];
  effort: string;
  /** 等待当前会话偏好恢复后，再协调目录中已不存在的档位。 */
  reconcileEnabled?: boolean;
  setEffort: (effort: string) => void;
  /** Persist a default this model requires before changing the visible pick. */
  onReconcile?: (effort: string) => void | Promise<boolean>;
  /** 将意外的协调失败反馈给 Composer。 */
  onReconcileError?: (error: unknown) => void;
}) {
  const resolution = useMemo(
    () =>
      resolveSessionEffortOptions({
        source: opts.source,
        provider: opts.provider,
        modelId: opts.modelId,
        officialModels: opts.officialModels,
      }),
    [opts.source, opts.provider, opts.modelId, opts.officialModels],
  );
  const { options, pending, supported } = resolution;
  const { effort, setEffort, onReconcile } = opts;

  useEffect(() => {
    if (opts.reconcileEnabled === false || pending || !supported || options.length === 0) return;
    if (options.some((option) => option.id === effort)) return;
    const next = pickSessionEffort(options, effort);
    if (!onReconcile) {
      setEffort(next);
      return;
    }
    let active = true;
    const reportError = (error: unknown) => {
      if (opts.onReconcileError) {
        opts.onReconcileError(error);
        return;
      }
      console.warn("composer effort reconciliation failed", {
        source: opts.source,
        providerId: opts.provider?.id ?? null,
        modelId: opts.modelId,
        error,
      });
    };
    try {
      const saved = onReconcile(next);
      if (saved && typeof saved.then === "function") {
        void saved.then(
          (succeeded) => {
            if (active && succeeded) setEffort(next);
          },
          (error: unknown) => {
            reportError(error);
          },
        );
      } else {
        setEffort(next);
      }
    } catch (error) {
      reportError(error);
    }
    return () => {
      active = false;
    };
  }, [
    effort,
    onReconcile,
    options,
    opts.onReconcileError,
    opts.modelId,
    opts.provider?.id,
    opts.reconcileEnabled,
    opts.source,
    pending,
    setEffort,
    supported,
  ]);

  return resolution;
}
