/**
 * 为当前会话保存推理档位。保存完成后再更新选中态；目录变化导致旧档位失效时，
 * 将模型默认档位排入同一保存队列，确保下一次 spawn 与界面一致。
 */

import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from "react";
import * as api from "@/lib/api";
import { queueComposerPreferenceApply } from "@/lib/composerPrefsBarrier";
import { type EffortOption } from "@/lib/grokCatalog";
import {
  classifyModelEffortError,
  modelEffortErrorMessageKey,
} from "@/lib/modelEffortApply";
import { saveSessionEffort } from "@/lib/sessionEffort";
import type { MessageKey } from "@/i18n";
import type { DraftComposerRoute } from "@/lib/draftComposerRoute";

/** Composer 错误提示的本地化翻译函数。 */
export type ComposerEffortTranslate = (
  key: MessageKey,
  vars?: Record<string, string | number | undefined | null>,
) => string;

/** 为当前会话串行保存推理档位，并拒绝跨会话应用旧请求。 */
export function useComposerEffort(opts: {
  effort: string;
  effortOptions: EffortOption[];
  setEffort: (effort: string) => void;
  projectId: string | null | undefined;
  providerId: string | null | undefined;
  modelId: string;
  sessionId: string | null | undefined;
  draftRouteRef?: MutableRefObject<DraftComposerRoute | null>;
  queueRef: MutableRefObject<Promise<void>>;
  showToast: (message: string, ms?: number) => void;
  translate: ComposerEffortTranslate;
}) {
  const {
    effort,
    effortOptions,
    setEffort,
    providerId,
    modelId,
    queueRef,
    showToast,
    translate,
  } = opts;
  const { projectId, sessionId, draftRouteRef } = opts;
  const targetGenerationRef = useRef(0);
  const targetRef = useRef({
    projectId: projectId ?? null,
    sessionId: sessionId ?? null,
    providerId,
    modelId,
  });
  const latestEffortRef = useRef(effort);
  const committedEffortRef = useRef(effort);
  const currentEffortRef = useRef(effort);
  const pendingEffortWritesRef = useRef(0);
  useLayoutEffect(() => {
    const nextTarget = {
      projectId: projectId ?? null,
      sessionId: sessionId ?? null,
      providerId,
      modelId,
    };
    const targetChanged =
      targetRef.current.projectId !== nextTarget.projectId ||
      targetRef.current.sessionId !== nextTarget.sessionId ||
      targetRef.current.providerId !== nextTarget.providerId ||
      targetRef.current.modelId !== nextTarget.modelId;
    if (targetChanged) targetGenerationRef.current += 1;
    targetRef.current = nextTarget;
    currentEffortRef.current = effort;
    if (targetChanged || pendingEffortWritesRef.current === 0) {
      latestEffortRef.current = effort;
      committedEffortRef.current = effort;
    }
  }, [effort, modelId, projectId, providerId, sessionId]);
  const isCurrentTarget = useCallback(
    (
      targetSessionId: string | null | undefined,
      targetProjectId: string | null | undefined,
      targetDraftRoute: DraftComposerRoute | null = null,
      targetModelId: string = modelId,
      targetProviderId: string | null | undefined = providerId,
    ) =>
      targetRef.current.sessionId === (targetSessionId ?? null) &&
      targetRef.current.projectId === (targetProjectId ?? null) &&
      targetRef.current.modelId === targetModelId &&
      targetRef.current.providerId === targetProviderId &&
      (targetSessionId != null ||
        ((draftRouteRef?.current?.providerId ?? null) ===
          (targetDraftRoute?.providerId ?? null) &&
          (draftRouteRef?.current?.modelId ?? null) ===
            (targetDraftRoute?.modelId ?? null))),
    [draftRouteRef, modelId, providerId],
  );
  const getLatestEffort = useCallback(() => latestEffortRef.current, []);

  const reportError = useCallback(
    (error: unknown) => {
      console.warn("composer effort save failed", {
        projectId: projectId ?? null,
        sessionId: sessionId ?? null,
        providerId: providerId ?? null,
        modelId,
        error,
      });
      showToast(
        translate(
          modelEffortErrorMessageKey(
            classifyModelEffortError(error),
          ),
        ),
        4000,
      );
    },
    [modelId, projectId, providerId, sessionId, showToast, translate],
  );

  const handleEffortPick = useCallback(
    (nextEffort: string): Promise<boolean> => {
      const next = nextEffort.trim();
      if (!next || !effortOptions.some((option) => option.id === next)) {
        showToast(
          translate(modelEffortErrorMessageKey("invalid_effort")),
          4000,
        );
        return Promise.resolve(false);
      }
      if (next === latestEffortRef.current) return Promise.resolve(true);
      latestEffortRef.current = next;
      pendingEffortWritesRef.current += 1;
      const targetDraftRoute = sessionId == null ? draftRouteRef?.current ?? null : null;
      const targetSessionId = sessionId ?? null;
      const targetGeneration = targetGenerationRef.current;
      let resolveWrite: (saved: boolean) => void = () => {};
      const writeResult = new Promise<boolean>((resolve) => {
        resolveWrite = resolve;
      });
      queueRef.current = queueComposerPreferenceApply(
        queueRef.current,
        async () => {
          let saved = false;
          try {
            const currentSessionId = targetRef.current.sessionId;
            if (targetSessionId === null && currentSessionId !== null) return;
            if (
              currentSessionId === targetSessionId &&
              !isCurrentTarget(
                targetSessionId,
                projectId,
                targetDraftRoute,
                modelId,
                providerId,
              )
            ) {
              return;
            }
            const result = await saveSessionEffort({
              effort: next,
              save: (value) =>
                api.composerPrefsSet({
                  projectId: projectId ?? null,
                  sessionId: sessionId ?? null,
                  providerId: sessionId ? undefined : providerId ?? "official",
                  modelId: sessionId ? undefined : modelId,
                  effort: value,
                }),
              apply: (value) => {
                if (
                  targetGenerationRef.current !== targetGeneration ||
                  latestEffortRef.current !== value ||
                  !isCurrentTarget(targetSessionId, projectId, targetDraftRoute, modelId, providerId)
                ) {
                  return;
                }
                committedEffortRef.current = value;
                setEffort(value);
              },
            });
            if (!result.ok) {
              if (targetGenerationRef.current === targetGeneration) {
                reportError(result.error);
              } else {
                console.warn("stale composer effort save failed", {
                  projectId,
                  sessionId,
                  providerId,
                  modelId,
                  error: result.error,
                });
              }
            } else {
              saved = true;
            }
          } finally {
            pendingEffortWritesRef.current -= 1;
            if (
              targetGenerationRef.current === targetGeneration &&
              pendingEffortWritesRef.current === 0
            ) {
              latestEffortRef.current = isCurrentTarget(
                targetSessionId,
                projectId,
                targetDraftRoute,
                modelId,
                providerId,
              )
                ? committedEffortRef.current
                : currentEffortRef.current;
            }
            resolveWrite(saved);
          }
        },
        reportError,
      );
      return writeResult;
    },
    [effortOptions, projectId, providerId, modelId, queueRef, sessionId, setEffort, isCurrentTarget, reportError, showToast, translate],
  );

  /** 将当前目录默认档位写入同一 per-session 队列。 */
  const persistReconciledEffort = useCallback(
    (next: string): Promise<boolean> => {
      if (!api.isTauri()) return Promise.resolve(true);
      let saved = false;
      const targetGeneration = targetGenerationRef.current;
      const targetDraftRoute =
        sessionId == null ? draftRouteRef?.current ?? null : null;
      const apply = queueComposerPreferenceApply(
        queueRef.current,
        async () => {
          if (targetGenerationRef.current !== targetGeneration) return;
          const currentSessionId = targetRef.current.sessionId;
          if (sessionId == null && currentSessionId != null) return;
          if (
            currentSessionId === sessionId &&
            !isCurrentTarget(
              sessionId,
              projectId,
              targetDraftRoute,
              modelId,
              providerId,
            )
          ) {
            return;
          }
          const latestEffort = getLatestEffort();
          if (
            latestEffort !== next &&
            effortOptions.some((option) => option.id === latestEffort)
          ) {
            return;
          }
          await api.composerPrefsSet({
            projectId: projectId ?? null,
            sessionId: sessionId ?? null,
            providerId: sessionId ? undefined : providerId ?? "official",
            modelId: sessionId ? undefined : modelId,
            effort: next,
          });
          if (targetGenerationRef.current !== targetGeneration) return;
          saved = true;
        },
        reportError,
      );
      queueRef.current = apply;
      return apply.then(() => saved);
    },
    [effortOptions, projectId, providerId, modelId, draftRouteRef, getLatestEffort, isCurrentTarget, queueRef, sessionId, reportError],
  );

  return { handleEffortPick, persistReconciledEffort, isCurrentTarget, getLatestEffort };
}
