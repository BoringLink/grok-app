import { useCallback, useLayoutEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { MessageKey } from "@/i18n";
import * as api from "@/lib/api";
import { queueComposerPreferenceApply } from "@/lib/composerPrefsBarrier";

type Translate = (key: MessageKey) => string;
type ComposerPrefField = "mode" | "permissionPolicy";

/** 串行保存 composer 的 mode/policy，并在目标上下文仍有效时更新状态。 */
export function useComposerPrefWrites(opts: {
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
  mode: string;
  setMode: Dispatch<SetStateAction<string>>;
  setPolicy: Dispatch<SetStateAction<string>>;
  queueRef: MutableRefObject<Promise<void>>;
  showToast: (message: string, ms?: number) => void;
  translate: Translate;
}): {
  persistMode: (mode: string) => void;
  persistPolicy: (policy: string) => void;
  resetDraftMode: () => void;
  draftModeRef: MutableRefObject<string | null>;
} {
  const targetRef = useRef({
    projectId: opts.projectId ?? null,
    sessionId: opts.sessionId ?? null,
  });
  const draftModeRef = useRef<string | null>(null);
  const draftModeDefaultRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  useLayoutEffect(() => {
    const projectId = opts.projectId ?? null;
    const sessionId = opts.sessionId ?? null;
    const targetChanged =
      targetRef.current.projectId !== projectId ||
      targetRef.current.sessionId !== sessionId;
    if (targetChanged) generationRef.current += 1;
    if (sessionId !== null || targetRef.current.projectId !== projectId) {
      draftModeRef.current = null;
      draftModeDefaultRef.current = null;
    }
    targetRef.current = { projectId, sessionId };
  }, [opts.projectId, opts.sessionId]);
  const reportError = useCallback(
    (field: ComposerPrefField, error: unknown) => {
      console.warn(`composer ${field} save failed`, {
        projectId: opts.projectId ?? null,
        sessionId: opts.sessionId ?? null,
        error,
      });
      opts.showToast(opts.translate("error.deck.generic.problem"), 4000);
    },
    [opts.projectId, opts.sessionId, opts.showToast, opts.translate],
  );
  const persist = useCallback(
    (field: ComposerPrefField, value: string) => {
      const projectId = opts.projectId ?? null;
      const sessionId = opts.sessionId ?? null;
      const generation = generationRef.current;
      if (
        field === "mode" &&
        sessionId === null &&
        draftModeDefaultRef.current === null
      ) {
        draftModeDefaultRef.current = opts.mode;
      }
      if (!api.isTauri()) {
        if (field === "mode") {
          opts.setMode(value);
          if (sessionId === null) draftModeRef.current = value;
        } else {
          opts.setPolicy(value);
        }
        return;
      }
      let saved = false;
      let persistedValue = value;
      const write = queueComposerPreferenceApply(
        opts.queueRef.current,
        async () => {
          const prefs = await api.composerPrefsSet({
            projectId,
            sessionId,
            mode: field === "mode" ? value : null,
            permissionPolicy: field === "permissionPolicy" ? value : null,
          });
          persistedValue =
            field === "mode" ? value : prefs.permissionPolicy;
          saved = true;
          if (
            generationRef.current === generation &&
            targetRef.current.projectId === projectId &&
            targetRef.current.sessionId === sessionId &&
            field === "mode" &&
            sessionId === null
          ) {
            draftModeRef.current = value;
          }
        },
        (error) => {
          if (generationRef.current === generation) reportError(field, error);
          else
            console.warn(`stale composer ${field} save failed`, {
              projectId,
              sessionId,
              error,
            });
        },
      );
      opts.queueRef.current = write;
      void write.then(() => {
        if (
          !saved ||
          generationRef.current !== generation ||
          targetRef.current.projectId !== projectId ||
          targetRef.current.sessionId !== sessionId
        ) {
          return;
        }
        if (field === "mode") opts.setMode(persistedValue);
        else opts.setPolicy(persistedValue);
      });
    },
    [
      opts.projectId,
      opts.mode,
      opts.queueRef,
      opts.sessionId,
      opts.setMode,
      opts.setPolicy,
      reportError,
    ],
  );
  const resetDraftMode = useCallback(() => {
    generationRef.current += 1;
    const defaultMode =
      draftModeDefaultRef.current ?? (opts.mode === "plan" ? "agent" : opts.mode);
    draftModeRef.current = null;
    draftModeDefaultRef.current = null;
    opts.setMode(defaultMode);
  }, [opts.mode, opts.setMode]);
  return {
    draftModeRef,
    resetDraftMode,
    persistMode: useCallback((mode: string) => persist("mode", mode), [persist]),
    persistPolicy: useCallback(
      (policy: string) => persist("permissionPolicy", policy),
      [persist],
    ),
  };
}
