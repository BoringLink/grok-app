import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from "react";
import type { EffortOption, ModelOption } from "@/lib/grokCatalog";
import type { SessionEffortProvider } from "@/lib/sessionEffort";
import type { DraftComposerRoute } from "@/lib/draftComposerRoute";
import {
  useComposerEffort,
  type ComposerEffortTranslate,
} from "./useComposerEffort";
import {
  classifyModelEffortError,
  modelEffortErrorMessageKey,
} from "@/lib/modelEffortApply";
import { useSessionEffortOptions } from "./useSessionEffortOptions";

/** 将会话档位解析、持久化与草稿路由同步收拢在一个 hook 中。 */
export function useSessionComposerEffort(opts: {
  source: "official" | "custom";
  provider: SessionEffortProvider | null;
  modelId: string;
  officialModels: ModelOption[];
  effort: string;
  /** 自定义 provider 目录加载失败（区别于仍在加载）。 */
  catalogFailed?: boolean;
  reconcileEnabled: boolean;
  setEffort: (effort: string) => void;
  updateDraftEffort: (sessionId: string | null | undefined, effort: string) => void;
  draftRouteRef: MutableRefObject<DraftComposerRoute | null>;
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
  queueRef: MutableRefObject<Promise<void>>;
  showToast: (message: string, ms?: number) => void;
  translate: ComposerEffortTranslate;
}): {
  options: EffortOption[];
  pending: boolean;
  failed: boolean;
  getLatestEffort: () => string;
  handleEffortPick: (nextEffort: string) => Promise<boolean>;
  persistReconciledEffort: (next: string) => Promise<boolean>;
  isCurrentTarget: (
    sessionId: string | null | undefined,
    projectId: string | null | undefined,
    draftRoute?: DraftComposerRoute | null,
    modelId?: string,
    providerId?: string | null,
  ) => boolean;
} {
  const applyEffort = useCallback(
    (nextEffort: string) => {
      opts.setEffort(nextEffort);
      opts.updateDraftEffort(opts.sessionId, nextEffort);
    },
    [opts.sessionId, opts.setEffort, opts.updateDraftEffort],
  );
  const persistReconciledRef = useRef<(next: string) => Promise<boolean>>(
    () => Promise.resolve(true),
  );
  const persistReconciled = useCallback(
    (next: string) => persistReconciledRef.current(next),
    [],
  );
  const reportReconcileError = useCallback(
    (error: unknown) => {
      console.warn("composer effort reconciliation failed", {
        providerId: opts.source === "official" ? "official" : opts.provider?.id ?? null,
        modelId: opts.modelId,
        sessionId: opts.sessionId ?? null,
        error,
      });
      opts.showToast(
        opts.translate(
          modelEffortErrorMessageKey(classifyModelEffortError(error)),
        ),
        4000,
      );
    },
    [opts.modelId, opts.provider?.id, opts.sessionId, opts.showToast, opts.source, opts.translate],
  );
  const resolution = useSessionEffortOptions({
    source: opts.source,
    provider: opts.provider,
    modelId: opts.modelId,
    officialModels: opts.officialModels,
    effort: opts.effort,
    setEffort: applyEffort,
    reconcileEnabled: opts.reconcileEnabled,
    catalogFailed: opts.catalogFailed,
    onReconcile: persistReconciled,
    onReconcileError: reportReconcileError,
  });
  const composerEffort = useComposerEffort({
    effort: opts.effort,
    effortOptions: resolution.options,
    setEffort: applyEffort,
    projectId: opts.projectId,
    providerId: opts.source === "official" ? "official" : opts.provider?.id,
    modelId: opts.modelId,
    sessionId: opts.sessionId,
    draftRouteRef: opts.draftRouteRef,
    queueRef: opts.queueRef,
    showToast: opts.showToast,
    translate: opts.translate,
  });
  useLayoutEffect(() => {
    persistReconciledRef.current = composerEffort.persistReconciledEffort;
  }, [composerEffort.persistReconciledEffort]);

  return {
    ...composerEffort,
    options: resolution.options,
    pending: resolution.pending,
    failed: resolution.failed,
  };
}
