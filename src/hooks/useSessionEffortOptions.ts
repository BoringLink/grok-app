/**
 * Composer reasoning options for the chat on screen. Reconciles a stored id
 * that the current model no longer advertises with that model's default, but
 * leaves the pick alone while a custom provider catalog is still loading or
 * when the model rejects reasoning effort.
 */

import { useEffect, useMemo } from "react";
import type { ModelOption } from "@/lib/grokCatalog";
import {
  pickSessionEffort,
  resolveSessionEffortOptions,
  type SessionEffortProvider,
} from "@/lib/sessionEffort";

export function useSessionEffortOptions(opts: {
  source: "official" | "custom";
  provider: SessionEffortProvider | null;
  modelId: string;
  officialModels: ModelOption[];
  effort: string;
  setEffort: (effort: string) => void;
  /** Persist a default this model requires so the next spawn matches the chip. */
  onReconcile?: (effort: string) => void;
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
    if (pending || !supported || options.length === 0) return;
    if (options.some((option) => option.id === effort)) return;
    const next = pickSessionEffort(options, effort);
    setEffort(next);
    onReconcile?.(next);
  }, [effort, onReconcile, options, pending, setEffort, supported]);

  return resolution;
}
