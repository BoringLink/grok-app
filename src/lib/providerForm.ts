/**
 * Custom-provider form mapping: ProviderModelEntry / CustomProvider /
 * ProviderPreset → the panel's FormState, plus small label helpers.
 * Pure functions extracted from ProvidersPanel so the mapping is testable
 * without rendering the panel.
 */
import * as api from "@/lib/api";
import type { MessageKey } from "@/i18n";
import { withResolvedModelMetadata } from "@/lib/providerModelConfig";
import {
  alignGrokPresetEfforts,
  applyPresetEndpoint,
  defaultCustomChannelEfforts,
  type ProviderPreset,
} from "@/lib/providerPresets";

export type FormEffort = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type FormModel = {
  /** Upstream request body model id. */
  id: string;
  /** Display name shown on composer chip / menu. */
  name: string;
  contextWindow?: number | null;
  contextWindowSource?: api.ProviderModelFieldSource;
  /** Legacy flag; kept for a lossless save but not exposed in Settings. */
  supportsVision?: boolean;
  /** Legacy flag; kept for a lossless save but not exposed in Settings. */
  supportsVideo?: boolean;
  efforts?: FormEffort[];
  effortsSource?: api.ProviderModelFieldSource;
  supportsReasoningEffort?: boolean;
  supportsReasoningEffortSource?: api.ProviderModelFieldSource;
};

export function toFormEfforts(
  list?: Array<{ id: string; name?: string; isDefault?: boolean }>,
): FormEffort[] | undefined {
  if (!list?.length) return list ? [] : undefined;
  return list.map((e) => ({
    id: e.id,
    name: e.name?.trim() || e.id,
    isDefault: !!e.isDefault,
  }));
}

export function asFormModel(m: api.ProviderModelEntry): FormModel {
  const resolved = withResolvedModelMetadata(m);
  return {
    id: resolved.id,
    name: resolved.name,
    contextWindow: resolved.contextWindow ?? null,
    contextWindowSource: resolved.contextWindowSource,
    supportsVision: resolved.supportsVision,
    supportsVideo: resolved.supportsVideo,
    efforts: toFormEfforts(resolved.efforts),
    effortsSource: resolved.effortsSource,
    supportsReasoningEffort: resolved.supportsReasoningEffort ?? true,
    supportsReasoningEffortSource: resolved.supportsReasoningEffortSource,
  };
}

export type FormState = {
  id: string;
  name: string;
  baseUrl: string;
  /** When true, host keeps baseUrl as-is (no auto `/v1`). */
  baseUrlFullPath: boolean;
  apiKey: string;
  apiBackend: string;
  providerMode: "generic" | "grok_build_proxy";
  models: FormModel[];
  efforts: FormEffort[];
  /** Extra rules appended to the system prompt on this channel. */
  appendPrompt: string;
  /** Legacy channel image flag; preserved but no longer editable. */
  supportsVision: boolean;
  /** External signup URL for “Get API Key” (from preset). */
  apiKeyUrl: string | null;
  extraHeaders: { name: string; value: string }[];
  /** Prefill / keep per-channel context_window. Null = omit on create. */
  contextWindow: number | null;
};

export type RightMode = "empty" | "pick" | "create" | "edit" | "official";
export type Selection = null | "official" | string;

export const emptyForm = (): FormState => ({
  id: "",
  name: "",
  baseUrl: "",
  baseUrlFullPath: false,
  apiKey: "",
  apiBackend: "responses",
  providerMode: "generic",
  appendPrompt: "",
  supportsVision: false,
  models: [],
  efforts: defaultCustomChannelEfforts().map((e) => ({
    id: e.id,
    name: e.name || e.id,
    isDefault: !!e.isDefault,
  })),
  apiKeyUrl: null,
  extraHeaders: [],
  contextWindow: null,
});

export function modelsFromProvider(p: api.CustomProvider): FormModel[] {
  // The host always emits the App catalog, including an explicit empty clear
  // (`[]`). Only a missing array means a legacy single-model provider.
  if (Array.isArray(p.models)) {
    return p.models.map((m) =>
      asFormModel({
        ...m,
        name: m.name?.trim() || m.id,
      }),
    );
  }
  const id = p.model?.trim() ?? "";
  if (!id) return [];
  return [asFormModel({ id, name: id })];
}

/**
 * Index of the first model row whose id is blank after trimming, or `-1`.
 *
 * An empty catalog is only valid when the user removed every row; a blank id
 * is a half-finished edit and must block the save instead of shrinking or
 * clearing the stored catalog.
 */
export function blankModelIdIndex(models: FormModel[]): number {
  return models.findIndex((m) => !m.id.trim());
}

/**
 * Canonical `providers_upsert` catalog rows for the current form values.
 *
 * Throws on a blank row: callers must reject it first via
 * {@link blankModelIdIndex}. Normalizing it away would produce a smaller
 * catalog, or `[]`, which the host reads as an explicit clear.
 */
export function formModelsPayload(models: FormModel[]): api.ProviderModelEntry[] {
  if (blankModelIdIndex(models) >= 0) {
    throw new Error("model rows require a non-empty id");
  }
  return models.map((m) => {
    const resolved = withResolvedModelMetadata({
      id: m.id.trim(),
      name: m.name.trim() || m.id.trim(),
      contextWindow: m.contextWindow ?? null,
      contextWindowSource: m.contextWindowSource,
      supportsVision: m.supportsVision,
      supportsVideo: m.supportsVideo,
      efforts: (m.efforts ?? [])
        .map((e) => ({
          id: e.id.trim(),
          name: e.name.trim() || e.id.trim(),
          isDefault: !!e.isDefault,
        }))
        .filter((e) => e.id),
      effortsSource: m.effortsSource,
      supportsReasoningEffort: m.supportsReasoningEffort,
      supportsReasoningEffortSource: m.supportsReasoningEffortSource,
    });
    return {
      id: resolved.id,
      name: resolved.name,
      contextWindow: resolved.contextWindow ?? null,
      contextWindowSource: resolved.contextWindowSource,
      supportsVision: resolved.supportsVision,
      supportsVideo: resolved.supportsVideo,
      efforts: resolved.efforts ?? [],
      effortsSource: resolved.effortsSource,
      // An absent field preserves the legacy default (supported).
      supportsReasoningEffort: resolved.supportsReasoningEffort ?? true,
      supportsReasoningEffortSource:
        resolved.supportsReasoningEffortSource ?? "fallback",
    };
  });
}

/** Order-sensitive equality for canonical catalog rows. */
function sameCatalog(
  a: api.ProviderModelEntry[],
  b: api.ProviderModelEntry[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Row-level identity (id, name, order). Per-model metadata is excluded because
 * a corrupt read only supplies fallback rows with no stored metadata; a change
 * there is not a catalog repair.
 */
function sameCatalogRows(
  a: api.ProviderModelEntry[],
  b: api.ProviderModelEntry[],
): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => row.id === b[i]?.id && row.name === b[i]?.name)
  );
}

/**
 * `models` to send on save. `undefined` leaves the stored `app_models` alone,
 * which is the only safe choice when the stored value is unreadable and the
 * user changed another field: re-sending the read fallback row would overwrite
 * it. Metadata-only changes (context window, legacy caps, efforts) also stay out of a
 * corrupt provider's payload for the same reason. A create that collides with
 * an existing id is an update, so it follows the same comparison. Without a
 * stored provider there is no baseline to compare against, so the rows
 * (including `[]`) are sent as-is.
 */
export function modelsForProviderSave(opts: {
  formModels: FormModel[];
  stored: api.CustomProvider | undefined;
}): api.ProviderModelEntry[] | undefined {
  const next = formModelsPayload(opts.formModels);
  if (!opts.stored) return next;
  const storedCatalog = formModelsPayload(modelsFromProvider(opts.stored));
  const unchanged =
    opts.stored.modelCatalogCorrupt === true
      ? sameCatalogRows(next, storedCatalog)
      : sameCatalog(next, storedCatalog);
  return unchanged ? undefined : next;
}

/**
 * `true` when this save keeps an unreadable `app_models` value on disk.
 *
 * The visible rows are then only the read-recovery result, not the stored
 * catalog. Deriving the channel model or its metadata (context window, vision,
 * efforts) from them would retarget the provider on an unrelated name / key
 * save, so the caller must keep the stored channel instead.
 */
export function keepsStoredChannel(opts: {
  stored: api.CustomProvider | undefined;
  modelsToSave: api.ProviderModelEntry[] | undefined;
}): boolean {
  return (
    opts.stored?.modelCatalogCorrupt === true && opts.modelsToSave === undefined
  );
}

/**
 * Per-model settings stay off until a corrupt provider's catalog is explicitly
 * replaced in the model list; the read fallback row carries none of the
 * original catalog. A create collision stays locked until the save makes the
 * stored catalog readable again.
 */
export function isModelCatalogLocked(opts: {
  stored: api.CustomProvider | undefined;
  isCreate: boolean;
  formModels: FormModel[];
}): boolean {
  if (opts.stored?.modelCatalogCorrupt !== true) return false;
  if (opts.isCreate) return true;
  // A blank row cannot be saved and already differs from the stored fallback,
  // so keep per-model controls usable while the user fixes or removes it.
  if (blankModelIdIndex(opts.formModels) >= 0) return false;
  return sameCatalogRows(
    formModelsPayload(opts.formModels),
    formModelsPayload(modelsFromProvider(opts.stored)),
  );
}

export function effortsFromProvider(p: api.CustomProvider): FormEffort[] {
  const aligned = alignGrokPresetEfforts({
    providerId: p.id,
    baseUrl: p.baseUrl,
    efforts: p.efforts,
  });
  const source = aligned ?? p.efforts;
  if (source?.length) {
    return source.map((e) => ({
      id: e.id,
      name: e.name?.trim() || e.id,
      isDefault: !!e.isDefault,
    }));
  }
  return defaultCustomChannelEfforts().map((e) => ({
    id: e.id,
    name: e.name || e.id,
    isDefault: !!e.isDefault,
  }));
}

export function formFromPreset(preset: ProviderPreset, endpointId?: string): FormState {
  const applied = applyPresetEndpoint(
    preset,
    endpointId ?? preset.defaultEndpointId,
  );
  return {
    id: preset.suggestedId,
    name: preset.name,
    baseUrl: applied.baseUrl,
    // Most presets ship with `/v1`; Volcengine Ark / Zhipu roots are already complete.
    baseUrlFullPath: applied.baseUrlFullPath,
    apiKey: "",
    apiBackend: preset.apiBackend,
    providerMode: "generic",
    // Presets carry no channel rules — opt-in per provider.
    appendPrompt: "",
    supportsVision: !!preset.supportsVision,
    models: preset.models.map((m) =>
      asFormModel({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow ?? preset.contextWindow ?? null,
        // Preset metadata is a non-user default: a live fetch may replace it.
        contextWindowSource: "fallback",
        supportsVision: m.supportsVision ?? preset.supportsVision,
        supportsVideo: m.supportsVideo,
        efforts: (m.efforts?.length ? m.efforts : preset.efforts).map((e) => ({
          id: e.id,
          name: e.name || e.id,
          isDefault: !!e.isDefault,
        })),
        effortsSource: "fallback",
        supportsReasoningEffort: true,
        supportsReasoningEffortSource: "fallback",
      }),
    ),
    efforts: preset.efforts.map((e) => ({
      id: e.id,
      name: e.name || e.id,
      isDefault: !!e.isDefault,
    })),
    apiKeyUrl: applied.apiKeyUrl,
    extraHeaders: [],
    contextWindow:
      preset.contextWindow && preset.contextWindow > 0
        ? preset.contextWindow
        : null,
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function ccSwitchStatusKey(status: string): MessageKey {
  switch (status) {
    case "importable":
      return "prov.ccSwitch.status.importable";
    case "official":
      return "prov.ccSwitch.status.official";
    case "missing_key":
      return "prov.ccSwitch.status.missing_key";
    case "proxy_managed":
      return "prov.ccSwitch.status.proxy_managed";
    case "exists":
      return "prov.ccSwitch.status.exists";
    case "invalid":
    default:
      return "prov.ccSwitch.status.invalid";
  }
}
