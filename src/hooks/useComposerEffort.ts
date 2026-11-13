/**
 * Composer effort writes for one chat. Picks persist before the visible
 * selection moves; a model/catalog change may reconcile the stored id to the
 * model's default and persist that too so the next spawn matches the chip.
 */

import { useCallback, type MutableRefObject } from "react";
import * as api from "@/lib/api";
import { queueComposerPreferenceApply } from "@/lib/composerPrefsBarrier";
import { type EffortOption } from "@/lib/grokCatalog";
import {
  classifyModelEffortError,
  modelEffortErrorMessageKey,
} from "@/lib/modelEffortApply";
import { saveSessionEffort } from "@/lib/sessionEffort";
import type { MessageKey } from "@/i18n";

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number | undefined | null>,
) => string;

export function useComposerEffort(opts: {
  effort: string;
  effortOptions: EffortOption[];
  setEffort: (effort: string) => void;
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
  queueRef: MutableRefObject<Promise<void>>;
  showToast: (message: string, ms?: number) => void;
  translate: Translate;
}) {
  const {
    effort,
    effortOptions,
    setEffort,
    projectId,
    sessionId,
    queueRef,
    showToast,
    translate,
  } = opts;

  const reportError = useCallback(
    (error: unknown) => {
      console.warn("composer effort save failed", error);
      showToast(
        translate(
          modelEffortErrorMessageKey(
            classifyModelEffortError(error),
          ) as MessageKey,
        ),
        4000,
      );
    },
    [showToast, translate],
  );

  const handleEffortPick = useCallback(
    (nextEffort: string) => {
      const next = nextEffort.trim();
      if (!next || !effortOptions.some((option) => option.id === next)) {
        showToast(
          translate(modelEffortErrorMessageKey("invalid_effort") as MessageKey),
          4000,
        );
        return;
      }
      if (next === effort) return;
      queueRef.current = queueComposerPreferenceApply(
        queueRef.current,
        async () => {
          const result = await saveSessionEffort({
            effort: next,
            save: (value) =>
              api.composerPrefsSet({
                projectId: projectId ?? null,
                sessionId: sessionId ?? null,
                effort: value,
              }),
            apply: setEffort,
          });
          if (!result.ok) reportError(result.error);
        },
        reportError,
      );
    },
    [effort, effortOptions, projectId, queueRef, sessionId, setEffort, reportError, showToast, translate],
  );

  /** Persist a reconciled default after a model/catalog change. */
  const persistReconciledEffort = useCallback(
    (next: string) => {
      if (!api.isTauri()) return;
      void api
        .composerPrefsSet({
          projectId: projectId ?? null,
          sessionId: sessionId ?? null,
          effort: next,
        })
        .catch(reportError);
    },
    [projectId, sessionId, reportError],
  );

  return { handleEffortPick, persistReconciledEffort };
}
