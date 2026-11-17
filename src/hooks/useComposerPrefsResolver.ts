import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import * as api from "@/lib/api";
import type { ModelOption } from "@/lib/grokCatalog";
import { resolveComposerPrefsAfterBarrier } from "@/lib/composerPrefsBarrier";

type ApplyComposerPrefs = (
  prefs: api.ComposerPrefs,
  models: ModelOption[],
  context?: { sessionId: string | null; forceOfficial?: boolean },
) => void;

type ResolveContext = {
  projectId: string | null;
  sessionId: string | null;
  forceOfficial: boolean;
  prefsScope: string;
  models: ModelOption[];
};

/** 按当前会话上下文解析偏好，并丢弃过期请求的结果。 */
export function useComposerPrefsResolver(opts: {
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
  forceOfficial: boolean;
  /** 偏好作用域变化后，需重新解析当前会话的偏好。 */
  prefsScope: string;
  models: ModelOption[];
  barrierRef: MutableRefObject<Promise<void>>;
  setAfterProviderList: (run: (() => void) | null) => void;
  apply: ApplyComposerPrefs;
  onError: (error: unknown) => void;
}): boolean {
  const isTauri = api.isTauri();
  const context = useMemo<ResolveContext>(
    () => ({
      projectId: opts.projectId ?? null,
      sessionId: opts.sessionId ?? null,
      forceOfficial: opts.forceOfficial,
      prefsScope: opts.prefsScope,
      models: opts.models,
    }),
    [
      opts.forceOfficial,
      opts.models,
      opts.prefsScope,
      opts.projectId,
      opts.sessionId,
    ],
  );
  const [resolvedContext, setResolvedContext] =
    useState<ResolveContext | null>(null);

  useEffect(() => {
    if (!isTauri) {
      setResolvedContext(context);
      return;
    }
    let active = true;
    let latestRequest = 0;
    const run = () => {
      const requestId = ++latestRequest;
      const barrier = opts.barrierRef.current;
      void resolveComposerPrefsAfterBarrier({
        barrier,
        currentBarrier: () => opts.barrierRef.current,
        isActive: () => active && requestId === latestRequest,
        resolve: () =>
          api.composerPrefsResolve({
            projectId: context.projectId,
            sessionId: context.sessionId,
          }),
        apply: (prefs) =>
          opts.apply(prefs, context.models, {
            sessionId: context.sessionId,
            forceOfficial: context.forceOfficial,
          }),
        onError: opts.onError,
      }).then((resolved) => {
        if (!active || requestId !== latestRequest) return;
        if (!resolved && opts.barrierRef.current !== barrier) {
          run();
        } else if (resolved) {
          setResolvedContext(context);
        }
      });
    };
    opts.setAfterProviderList(run);
    run();
    return () => {
      active = false;
      opts.setAfterProviderList(null);
    };
  }, [
    context,
    isTauri,
    opts.apply,
    opts.barrierRef,
    opts.onError,
    opts.setAfterProviderList,
  ]);

  return !isTauri || resolvedContext === context;
}
