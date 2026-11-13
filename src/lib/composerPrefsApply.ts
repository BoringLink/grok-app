/**
 * Model + effort chosen when a chat's stored composer prefs are applied.
 * Official ids use the Grok catalog. A custom provider id is checked against
 * that provider's models, and effort is checked against that model's ladder.
 */

import type { CustomProvider } from "@/lib/api/providers";
import {
  findModel,
  GROK_BUILD_MODELS,
  isValidEffort,
  isValidModelId,
  pickDefaultEffort,
  pickDefaultModelId,
  type EffortOption,
  type ModelOption,
} from "@/lib/grokCatalog";
import { pickSessionEffort, resolveSessionEffortOptions } from "@/lib/sessionEffort";

export type ComposerPrefsSelectionInput = {
  modelId?: string | null;
  effort?: string | null;
  providerId?: string | null;
};

export type ComposerPrefsProvider = Pick<
  CustomProvider,
  "id" | "model" | "models" | "efforts" | "baseUrl" | "modelCatalogCorrupt"
> & {
  /** Missing means generic. Every catalog id is selectable (#1394). */
  providerMode?: CustomProvider["providerMode"];
};

function isCustomProviderId(providerId: string | null | undefined): boolean {
  const id = providerId?.trim() ?? "";
  return id.length > 0 && id.toLowerCase() !== "official";
}

/**
 * Selectable rows for one provider. A host that sends `models` owns the list,
 * and `[]` is an explicit clear; only a missing catalog keeps the
 * legacy channel `model` row.
 */
function providerModelList(provider: ComposerPrefsProvider) {
  if (provider.models != null) return provider.models;
  const configured = provider.model?.trim() ?? "";
  return configured ? [{ id: configured, name: configured }] : [];
}

function pickEffort(
  effort: string | null | undefined,
  modelOrEfforts: ModelOption | EffortOption[] | null | undefined,
): string {
  const id = (effort ?? "").trim();
  if (isValidEffort(id, modelOrEfforts ?? null)) return id;
  if (Array.isArray(modelOrEfforts)) {
    return pickDefaultEffort(null, modelOrEfforts);
  }
  return pickDefaultEffort(modelOrEfforts ?? null);
}

export type ComposerPrefsDraftPick = {
  providerId?: string | null;
  modelId?: string | null;
  effort?: string | null;
};

/**
 * True when a new chat's pick belongs to the route that chat picked. The draft
 * carries its own provider, because the resolved prefs do not know it yet.
 */
function draftModelIdIsKnown(
  modelId: string,
  draftProviderId: string | null | undefined,
  providers: readonly ComposerPrefsProvider[],
  catalog: ModelOption[],
): boolean {
  if (!isCustomProviderId(draftProviderId)) {
    return isValidModelId(modelId, catalog);
  }
  const provider = providers.find((p) => p.id === draftProviderId?.trim());
  // List not back yet: nothing disproves the pick, so keep it.
  if (!provider) return providers.length === 0;
  return providerModelList(provider).some((m) => m.id === modelId);
}

/**
 * A saved model id that a corrupt catalog's partial read no longer lists.
 * The host keeps the session's generic child section, so the stored id is
 * still routable and must not be replaced by the channel `model`.
 */
function keepsUnlistedModelOnCorrupt(
  provider: ComposerPrefsProvider,
  storedModel: string,
): boolean {
  if (provider.modelCatalogCorrupt !== true || !storedModel) return false;
  return !providerModelList(provider).some((m) => m.id === storedModel);
}

function resolvedCustomModel(
  provider: ComposerPrefsProvider,
  storedModel: string,
): string {
  const selectable = providerModelList(provider);
  // An explicitly cleared catalog keeps the child sections older sessions
  // still route on, so a saved pick survives; a chat without one falls
  // through to the official default instead of the cleared channel `model`.
  if (provider.models?.length === 0) return storedModel;
  if (storedModel && selectable.some((m) => m.id === storedModel)) {
    return storedModel;
  }
  if (keepsUnlistedModelOnCorrupt(provider, storedModel)) return storedModel;
  return provider.model?.trim() || selectable[0]?.id || "";
}

function customSelection(
  provider: ComposerPrefsProvider,
  storedModel: string,
  effort: string | null | undefined,
): { modelId: string; effort: string } | null {
  const nextModelId = resolvedCustomModel(provider, storedModel);
  if (!nextModelId) return null;
  const resolution = resolveSessionEffortOptions({
    source: "custom",
    // A corrupt partial read has no row for the stored id; the channel
    // ladder stays in charge instead of borrowing another row's efforts.
    provider: keepsUnlistedModelOnCorrupt(provider, storedModel)
      ? { ...provider, models: [] }
      : provider,
    modelId: nextModelId,
  });
  return {
    modelId: nextModelId,
    effort: pickSessionEffort(resolution.options, effort),
  };
}

export type ComposerPrefsSelection = {
  modelId: string;
  effort: string;
  /**
   * Route override for the composer chip. `null` means the official route;
   * `undefined` means the caller keeps the route it already paints.
   */
  providerId?: string | null;
};

export function resolveComposerPrefsSelection(opts: {
  prefs: ComposerPrefsSelectionInput;
  catalog: ModelOption[];
  providers?: readonly ComposerPrefsProvider[];
  /** False before the first provider list arrives; an empty loaded list is final. */
  providersLoaded?: boolean;
  /** SSH sessions are pinned to the official route. */
  forceOfficial?: boolean;
  /**
   * A chat that has not been created yet keeps its pick in memory only, so a
   * resolve — which reads the global / project defaults — would otherwise put
   * the model back to the default. The provider is already restored this way.
   */
  draft?: ComposerPrefsDraftPick | null;
}): ComposerPrefsSelection {
  const catalog = opts.catalog.length > 0 ? opts.catalog : GROK_BUILD_MODELS;
  const providers = opts.providers ?? [];
  const providersLoaded = opts.providersLoaded === true;
  if (opts.forceOfficial) {
    const requestedModelId = opts.prefs.modelId?.trim() ?? "";
    const modelId = isValidModelId(requestedModelId, catalog)
      ? requestedModelId
      : pickDefaultModelId(catalog);
    return {
      modelId,
      effort: pickEffort(opts.prefs.effort, findModel(modelId, catalog)),
      providerId: null,
    };
  }
  const providerId = opts.prefs.providerId?.trim() ?? "";

  const draftModelId = opts.draft?.modelId?.trim() ?? "";
  if (draftModelId && isCustomProviderId(opts.draft?.providerId)) {
    const drafted = providers.find((p) => p.id === opts.draft?.providerId?.trim());
    if (!drafted) {
      // List not back yet: nothing disproves the pick, so keep it.
      if (!providersLoaded && providers.length === 0) {
        const draftEffort = opts.draft?.effort?.trim() ?? "";
        return {
          modelId: draftModelId,
          effort: draftEffort || pickDefaultEffort(null),
        };
      }
    } else {
      const picked = customSelection(drafted, draftModelId, opts.draft?.effort);
      if (picked) return picked;
    }
  } else if (
    draftModelId &&
    draftModelIdIsKnown(
      draftModelId,
      opts.draft?.providerId,
      providers,
      catalog,
    )
  ) {
    const draftEffort = opts.draft?.effort?.trim() ?? "";
    return {
      modelId: draftModelId,
      effort:
        draftEffort || pickDefaultEffort(findModel(draftModelId, catalog) ?? null),
    };
  }

  if (isCustomProviderId(providerId)) {
    const provider = providers.find((p) => p.id === providerId);
    const storedModel = opts.prefs.modelId?.trim() ?? "";
    // List not back yet: keep the disk id so the chip does not flash official.
    if (!provider) {
      if (!providersLoaded && storedModel) {
        const storedEffort = (opts.prefs.effort ?? "").trim();
        return {
          modelId: storedModel,
          effort: storedEffort || pickDefaultEffort(null),
        };
      }
      // Provider deleted / empty list: official takes over on both sides.
      return {
        modelId: pickDefaultModelId(catalog),
        effort: pickEffort(opts.prefs.effort, null),
        providerId: null,
      };
    }
    const picked = customSelection(provider, storedModel, opts.prefs.effort);
    if (picked) return picked;
    // Nothing on this provider is selectable, so the official route has to
    // take over; otherwise the chip paints official while the send still
    // routes to the provider.
    return {
      modelId: pickDefaultModelId(catalog),
      effort: pickEffort(opts.prefs.effort, null),
      providerId: null,
    };
  }

  const nextModelId =
    opts.prefs.modelId && isValidModelId(opts.prefs.modelId, catalog)
      ? opts.prefs.modelId
      : pickDefaultModelId(catalog);
  return {
    modelId: nextModelId,
    effort: pickEffort(opts.prefs.effort, findModel(nextModelId, catalog)),
  };
}
