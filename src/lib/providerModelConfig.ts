/**
 * Resolve per-model metadata on a custom provider without dropping the
 * channel-level fields Grok Build still reads (`app_efforts`,
 * `context_window`, `app_supports_vision`).
 *
 * Context window and reasoning ladder carry a provenance marker so a live
 * `/models` refresh can update API/fallback values while leaving an explicit
 * user override alone. Legacy rows without a marker keep a non-empty value as
 * user-set.
 */

import type {
  CustomProvider,
  ProviderEffortEntry,
  ProviderModelEntry,
  ProviderModelFieldSource,
} from "@/lib/api";
import { DEFAULT_CUSTOM_CONTEXT_WINDOW } from "@/lib/grokCatalog";
import { alignGrokPresetEfforts } from "@/lib/providerPresets";

export type RemoteModelMetadata = {
  id: string;
  ownedBy?: string | null;
  supportsBackendSearch?: boolean | null;
  contextWindow?: number | null;
  supportsVision?: boolean | null;
  supportsVideo?: boolean | null;
  reasoningEfforts?: ProviderEffortEntry[] | null;
  supportsReasoningEffort?: boolean | null;
};

export type ResolvedModelValue<T> = {
  value: T;
  source: ProviderModelFieldSource;
};

/** Fallback used when neither the API nor the user supplied a context window. */
export const DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW =
  DEFAULT_CUSTOM_CONTEXT_WINDOW;

/**
 * Reasoning levels used when the API does not advertise a ladder. The ids are
 * sent verbatim as `reasoning_effort`; `medium` is the default.
 */
export function defaultProviderModelEfforts(): ProviderEffortEntry[] {
  return [
    { id: "low", name: "low", isDefault: false },
    { id: "medium", name: "medium", isDefault: true },
    { id: "high", name: "high", isDefault: false },
    { id: "xhigh", name: "xhigh", isDefault: false },
  ];
}

export function normalizeModelFieldSource(
  raw: unknown,
): ProviderModelFieldSource | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return value === "user" || value === "remote" || value === "fallback"
    ? value
    : null;
}

export function findProviderModel(
  provider: Pick<CustomProvider, "models" | "model">,
  modelId?: string | null,
): ProviderModelEntry | null {
  const models = provider.models ?? [];
  if (!models.length) return null;
  const want = (modelId ?? provider.model ?? "").trim();
  if (want) {
    const hit = models.find((m) => m.id.trim() === want);
    if (hit) return hit;
  }
  return models[0] ?? null;
}

function positiveWindow(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Normalize a reasoning ladder.
 *
 * Ids are preserved (trimmed only), blank/duplicate ids are dropped, and
 * exactly one row is marked default: the first API-marked row, else `medium`,
 * else the first valid row. That keeps `isDefault` pointing at an id that is
 * actually in the list.
 */
export function normalizeModelEfforts(
  efforts: ProviderEffortEntry[] | null | undefined,
): ProviderEffortEntry[] {
  const out: ProviderEffortEntry[] = [];
  const seen = new Set<string>();
  let apiDefault = "";
  for (const effort of efforts ?? []) {
    const id = (effort.id ?? "").trim();
    if (!id) continue;
    if (effort.isDefault && !apiDefault) apiDefault = id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: (effort.name ?? "").trim() || id,
      isDefault: false,
    });
  }
  if (out.length === 0) return out;
  const defaultId =
    apiDefault && seen.has(apiDefault)
      ? apiDefault
      : seen.has("medium")
        ? "medium"
        : out[0].id;
  return out.map((effort) => ({
    ...effort,
    isDefault: effort.id === defaultId,
  }));
}

export function effectiveModelContextWindow(
  model: Pick<ProviderModelEntry, "contextWindow" | "contextWindowSource">,
): ResolvedModelValue<number> {
  const window = positiveWindow(model.contextWindow);
  const explicit = normalizeModelFieldSource(model.contextWindowSource);
  return {
    value: window ?? DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW,
    source:
      window == null
        ? "fallback"
        : explicit === "user" || explicit === "remote" || explicit === "fallback"
          ? explicit
          : "user",
  };
}

export function effectiveModelEfforts(
  model: Pick<ProviderModelEntry, "efforts" | "effortsSource">,
): ResolvedModelValue<ProviderEffortEntry[]> {
  const efforts = normalizeModelEfforts(model.efforts);
  const explicit = normalizeModelFieldSource(model.effortsSource);
  if (efforts.length === 0) {
    return { value: defaultProviderModelEfforts(), source: "fallback" };
  }
  return {
    value: efforts,
    source:
      explicit === "user" || explicit === "remote" || explicit === "fallback"
        ? explicit
        : "user",
  };
}

export function effectiveModelSupportsReasoningEffort(
  model: Pick<
    ProviderModelEntry,
    "supportsReasoningEffort" | "supportsReasoningEffortSource"
  >,
): ResolvedModelValue<boolean> {
  const hasValue = typeof model.supportsReasoningEffort === "boolean";
  const explicit = normalizeModelFieldSource(
    model.supportsReasoningEffortSource,
  );
  return {
    value: hasValue ? !!model.supportsReasoningEffort : true,
    source:
      hasValue &&
      (explicit === "user" ||
        explicit === "remote" ||
        explicit === "fallback")
        ? explicit
        : hasValue
          ? "user"
          : "fallback",
  };
}

/**
 * Materialize the effective metadata and provenance markers on a catalog row.
 * Used when the form opens or the user adds a row, so every row can persist
 * the fallback it currently shows.
 */
export function withResolvedModelMetadata(
  model: ProviderModelEntry,
): ProviderModelEntry {
  const contextWindow = effectiveModelContextWindow(model);
  const efforts = effectiveModelEfforts(model);
  const reasoning = effectiveModelSupportsReasoningEffort(model);
  return {
    ...model,
    contextWindow: contextWindow.value,
    contextWindowSource: contextWindow.source,
    efforts: efforts.value,
    effortsSource: efforts.source,
    supportsReasoningEffort: reasoning.value,
    supportsReasoningEffortSource: reasoning.source,
  };
}

/** Channel efforts the composer should show for the active (or given) model. */
export function resolveProviderEfforts(
  provider: Pick<CustomProvider, "id" | "baseUrl" | "model" | "models" | "efforts">,
  modelId?: string | null,
): ProviderEffortEntry[] | undefined {
  const model = findProviderModel(provider, modelId);
  const raw =
    model?.efforts && model.efforts.length > 0
      ? model.efforts
      : provider.efforts;
  const aligned = alignGrokPresetEfforts({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    efforts: raw,
  });
  return aligned ?? raw;
}

export function resolveProviderContextWindow(
  provider: Pick<CustomProvider, "model" | "models" | "contextWindow">,
  modelId?: string | null,
): number | null {
  const model = findProviderModel(provider, modelId);
  return (
    positiveWindow(model?.contextWindow) ??
    positiveWindow(provider.contextWindow) ??
    null
  );
}

/**
 * Effective vision flag for the active model.
 * Explicit per-model true/false wins; otherwise channel flag.
 */
export function resolveProviderSupportsVision(
  provider: Pick<CustomProvider, "model" | "models" | "supportsVision">,
  modelId?: string | null,
): boolean {
  const model = findProviderModel(provider, modelId);
  if (model?.supportsVision === true) return true;
  if (model?.supportsVision === false) return false;
  return !!provider.supportsVision;
}

export function resolveProviderSupportsVideo(
  provider: Pick<CustomProvider, "model" | "models">,
  modelId?: string | null,
): boolean {
  return findProviderModel(provider, modelId)?.supportsVideo === true;
}

/** Copy the active model's extras onto channel fields for Host / CLI. */
export function materializeActiveModelChannel(opts: {
  provider: CustomProvider;
  modelId: string;
  models?: ProviderModelEntry[];
}): {
  efforts?: ProviderEffortEntry[];
  contextWindow?: number | null;
  supportsVision?: boolean;
} {
  const models = opts.models ?? opts.provider.models;
  const view = {
    ...opts.provider,
    models,
    model: opts.modelId,
  };
  const efforts = resolveProviderEfforts(view, opts.modelId);
  const contextWindow = resolveProviderContextWindow(view, opts.modelId);
  const supportsVision = resolveProviderSupportsVision(view, opts.modelId);
  return {
    efforts,
    contextWindow: contextWindow ?? undefined,
    supportsVision,
  };
}

/**
 * Apply live `/models` metadata onto a catalog row.
 *
 * User-set values win. API values update rows that came from the API, and
 * missing API values fall back to the App default. A row that the API did not
 * return is untouched. Legacy vision/video flags are deliberately not merged:
 * they are no longer user-editable Settings, so a refresh must not change them.
 */
export function mergeRemoteModelMetadata(
  model: ProviderModelEntry,
  remote: RemoteModelMetadata | null | undefined,
): ProviderModelEntry {
  if (!remote || remote.id.trim() !== model.id.trim()) return model;

  const context = effectiveModelContextWindow(model);
  const remoteWindow = positiveWindow(remote.contextWindow);
  const nextContext =
    context.source === "user"
      ? context
      : remoteWindow != null
        ? { value: remoteWindow, source: "remote" as const }
        : context.source === "fallback"
          ? context
          : {
              value: DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW,
              source: "fallback" as const,
            };

  const efforts = effectiveModelEfforts(model);
  const remoteEfforts = normalizeModelEfforts(remote.reasoningEfforts);
  const nextEfforts =
    efforts.source === "user"
      ? efforts
      : remoteEfforts.length > 0
        ? { value: remoteEfforts, source: "remote" as const }
        : efforts.source === "fallback"
          ? efforts
          : { value: defaultProviderModelEfforts(), source: "fallback" as const };

  const reasoning = effectiveModelSupportsReasoningEffort(model);
  const remoteReasoning =
    typeof remote.supportsReasoningEffort === "boolean"
      ? remote.supportsReasoningEffort
      : null;
  const nextReasoning =
    reasoning.source === "user"
      ? reasoning
      : remoteReasoning != null
        ? { value: remoteReasoning, source: "remote" as const }
        : { value: true, source: "fallback" as const };

  return {
    ...model,
    contextWindow: nextContext.value,
    contextWindowSource: nextContext.source,
    efforts: nextEfforts.value,
    effortsSource: nextEfforts.source,
    supportsReasoningEffort: nextReasoning.value,
    supportsReasoningEffortSource: nextReasoning.source,
  };
}

/**
 * `models` payload for a composer context-window change.
 *
 * `undefined` leaves the stored `app_models` alone: when the stored value is
 * unreadable, `models` only carries the legacy read fallback, and sending it
 * would replace the original text with a repaired catalog. The channel
 * `contextWindow` still lands, which is what the composer chip edits.
 *
 * An empty (but readable) catalog stays empty. Only a missing catalog falls
 * back to the channel model, so a user who cleared `app_models` never gets a
 * model row back from a context-window edit.
 */
export function modelsForContextWindow(
  provider: Pick<CustomProvider, "models" | "model" | "modelCatalogCorrupt">,
  tokens: number,
): ProviderModelEntry[] | undefined {
  if (provider.modelCatalogCorrupt === true) return undefined;
  if (provider.models?.length === 0) return [];
  return withModelContextWindow(provider.models, provider.model, tokens);
}

/** Patch the active model's context window inside a catalog (composer chip). */
export function withModelContextWindow(
  models: ProviderModelEntry[] | null | undefined,
  modelId: string,
  tokens: number,
): ProviderModelEntry[] {
  const list = models?.length ? models.slice() : [];
  const id = modelId.trim();
  if (!id) return list;
  const next = positiveWindow(tokens);
  let found = false;
  const patch = <T extends ProviderModelEntry>(model: T): T => ({
    ...model,
    contextWindow: next,
    contextWindowSource: next == null ? undefined : "user",
  });
  const mapped = list.map((model) => {
    if (model.id.trim() !== id) return model;
    found = true;
    return patch(model);
  });
  if (found) return mapped;
  return [...mapped, patch({ id, name: id })];
}
