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
 * exactly one row is marked default: the first API-marked row, else the first
 * non-`none` row (matching Composer/Host default semantics), else the first
 * row. That keeps `isDefault` pointing at an id that is actually in the list.
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
      : (out.find((effort) => effort.id.toLowerCase() !== "none")?.id ??
        out[0].id);
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
    value: window ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
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
    | "efforts"
    | "effortsSource"
    | "supportsReasoningEffort"
    | "supportsReasoningEffortSource"
    | "supportsReasoningOff"
  >,
): ResolvedModelValue<boolean> {
  const configuredEfforts = effectiveModelEfforts(model);
  if (
    configuredEfforts.value.length > 0 &&
    configuredEfforts.source !== "fallback"
  ) {
    return { value: true, source: configuredEfforts.source };
  }
  if (model.supportsReasoningOff === true) {
    return { value: true, source: "user" };
  }
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

/** Resolve whether the model's Off stop is available in Composer. */
export function effectiveModelSupportsReasoningOff(
  model: Pick<ProviderModelEntry, "supportsReasoningOff" | "efforts">,
): boolean {
  if (typeof model.supportsReasoningOff === "boolean") {
    return model.supportsReasoningOff;
  }
  return normalizeModelEfforts(model.efforts).some(
    (effort) => effort.id.toLowerCase() === "none",
  );
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
    ...(typeof model.supportsReasoningOff === "boolean"
      ? { supportsReasoningOff: model.supportsReasoningOff }
      : {}),
  };
}

/** 按精确 provider/model id 解析档位，不借用其它模型的 channel ladder。 */
export function configuredProviderModelEfforts(
  provider: Pick<CustomProvider, "model" | "models" | "efforts">,
  modelId?: string | null,
): ProviderEffortEntry[] {
  const id = (modelId ?? provider.model).trim();
  const model = provider.models?.find((entry) => entry.id.trim() === id);
  if (model?.efforts?.length) return model.efforts;
  const channelModelId = provider.model.trim();
  const legacyChannelLadder =
    channelModelId === id &&
    (provider.models == null ||
      (provider.models.length === 1 && provider.models[0]?.id.trim() === id));
  return legacyChannelLadder ? provider.efforts ?? [] : [];
}

/** 按 provider/model identity 解析档位，不借用其它目录行的 channel ladder。 */
export function resolveProviderEfforts(
  provider: Pick<CustomProvider, "model" | "models" | "efforts">,
  modelId?: string | null,
): ProviderEffortEntry[] {
  const id = (modelId ?? provider.model).trim();
  const model = provider.models?.find((entry) => entry.id.trim() === id);
  if (model && !effectiveModelSupportsReasoningEffort(model).value) return [];
  // 与 Host `custom_model_effort_ladder` 同一优先级：行内显式开启 Off 时
  // 该行视为独立配置，空档位走通用 fallback，不借旧式 channel 梯子。
  const rowConfiguredOff = model?.supportsReasoningOff === true;
  const raw =
    rowConfiguredOff && !model?.efforts?.length
      ? []
      : configuredProviderModelEfforts(provider, id);
  const ladder = raw.length > 0 ? raw : defaultProviderModelEfforts();
  const catalogAdvertisesOff = ladder.some(
    (effort) => effort.id.toLowerCase() === "none",
  );
  const supportsOff =
    typeof model?.supportsReasoningOff === "boolean"
      ? model.supportsReasoningOff
      : catalogAdvertisesOff;
  if (supportsOff && !catalogAdvertisesOff) {
    // Off 是最低档，置于滑块最左侧。
    return [{ id: "none" }, ...ladder];
  }
  if (!supportsOff && catalogAdvertisesOff) {
    return ladder.filter((effort) => effort.id.toLowerCase() !== "none");
  }
  return ladder;
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
              value: DEFAULT_CUSTOM_CONTEXT_WINDOW,
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
    nextEfforts.value.length > 0 && nextEfforts.source !== "fallback"
      ? { value: true, source: nextEfforts.source }
      : reasoning.source === "user"
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


