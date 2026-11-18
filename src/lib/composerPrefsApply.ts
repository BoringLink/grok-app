/**
 * Model + effort chosen when a chat's stored composer prefs are applied.
 * Official ids use the Grok catalog. A custom provider id is checked against
 * that provider's models, and effort is checked against that model's ladder.
 */

import type { CustomProvider } from "@/lib/api/providers";
import type { DraftComposerRoute } from "@/lib/draftComposerRoute";
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

/** 未创建会话时保留草稿模式；会话完成物化后使用该会话已保存的模式。 */
export function resolveComposerModeForView(opts: {
  prefsMode?: string | null;
  draftMode?: string | null;
  sessionId?: string | null;
}): string {
  if (opts.sessionId == null && opts.draftMode) return opts.draftMode;
  return opts.prefsMode || "agent";
}

export type ComposerPrefsSelectionInput = {
  modelId?: string | null;
  effort?: string | null;
  providerId?: string | null;
  sessionModelId?: string | null;
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
  modelId: string,
  sessionModelId: string | null | undefined,
): boolean {
  const persistedModelId = sessionModelId?.trim() ?? "";
  if (
    provider.modelCatalogCorrupt !== true ||
    !persistedModelId ||
    persistedModelId !== modelId
  ) {
    return false;
  }
  return !providerModelList(provider).some((model) => model.id === modelId);
}

function resolvedCustomModel(
  provider: ComposerPrefsProvider,
  inheritedModelId: string,
  sessionModelId?: string | null,
): string {
  const selectable = providerModelList(provider);
  const requestedModelId = sessionModelId?.trim() || inheritedModelId;
  // An explicitly cleared catalog keeps child sections only for a saved session.
  if (provider.models?.length === 0) return sessionModelId?.trim() ?? "";
  if (requestedModelId && selectable.some((model) => model.id === requestedModelId)) {
    return requestedModelId;
  }
  if (keepsUnlistedModelOnCorrupt(provider, requestedModelId, sessionModelId)) {
    return requestedModelId;
  }
  const activeModel = provider.model?.trim() ?? "";
  if (activeModel && selectable.some((model) => model.id === activeModel)) {
    return activeModel;
  }
  return selectable[0]?.id || "";
}

function customSelection(
  provider: ComposerPrefsProvider,
  storedModel: string,
  effort: string | null | undefined,
  sessionModelId?: string | null,
): { modelId: string; effort: string; effortSupported?: false } | null {
  const nextModelId = resolvedCustomModel(provider, storedModel, sessionModelId);
  if (!nextModelId) return null;
  const resolution = resolveSessionEffortOptions({
    source: "custom",
    // A corrupt partial read has no row for the persisted id. Do not borrow the
    // channel ladder; that chat keeps the generic fallback for its saved model.
    provider: keepsUnlistedModelOnCorrupt(provider, nextModelId, sessionModelId)
      ? { ...provider, models: [] }
      : provider,
    modelId: nextModelId,
  });
  if (!resolution.supported) {
    // Keep the stored id for a later supporting model, but never present or
    // forward it as this model's effort.
    return {
      modelId: nextModelId,
      effort: (effort ?? "").trim(),
      effortSupported: false,
    };
  }
  return {
    modelId: nextModelId,
    effort: pickSessionEffort(resolution.options, effort),
  };
}

export type ComposerPrefsSelection = {
  modelId: string;
  effort: string;
  /**
   * False when the selected model explicitly rejects reasoning effort. The
   * stored id stays in `effort` for a later supporting model, but callers must
   * not present or persist it as this model's pick.
   */
  effortSupported?: boolean;
  /**
   * Route override for the composer chip. `null` means the official route;
   * `undefined` means the caller keeps the route it already paints.
   */
  providerId?: string | null;
};

/** 按当前生效的会话/草稿路由，解析需要展示的推理档位。 */
export function resolveComposerPrefsDraftEffort(opts: {
  selection: ComposerPrefsSelection;
  storedEffort: string | null | undefined;
  draftRoute: DraftComposerRoute | null;
  forceOfficial: boolean;
}): { effort: string; draftRouteMatches: boolean } {
  const draftRouteMatches =
    opts.draftRoute != null &&
    !opts.forceOfficial &&
    opts.draftRoute.modelId === opts.selection.modelId &&
    opts.draftRoute.providerId === (opts.selection.providerId ?? "official");
  if (draftRouteMatches && opts.draftRoute) {
    return {
      effort:
        opts.draftRoute.effort ??
        (opts.selection.effortSupported === false ? "" : opts.selection.effort),
      draftRouteMatches: true,
    };
  }
  return {
    effort: (opts.storedEffort ?? "").trim(),
    draftRouteMatches: false,
  };
}

/** 当前 official fallback 的模型和 effort 必须来自同一份目录。 */
function resolveOfficialFallback(
  effort: string | null | undefined,
  catalog: ModelOption[],
): ComposerPrefsSelection {
  const modelId = pickDefaultModelId(catalog);
  return {
    modelId,
    effort: pickEffort(effort, findModel(modelId, catalog)),
    providerId: null,
  };
}

/** 用继承的官方 model id 回退，同时按该模型校验effort。 */
function resolveOfficialFallbackForModel(
  requestedModelId: string | null | undefined,
  effort: string | null | undefined,
  catalog: ModelOption[],
): ComposerPrefsSelection {
  const requested = requestedModelId?.trim() ?? "";
  const modelId = isValidModelId(requested, catalog)
    ? requested
    : pickDefaultModelId(catalog);
  return {
    modelId,
    effort: pickEffort(effort, findModel(modelId, catalog)),
    providerId: null,
  };
}

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
          providerId: opts.draft?.providerId,
        };
      }
    } else {
      const picked = customSelection(
        drafted,
        draftModelId,
        opts.draft?.effort,
        draftModelId,
      );
      if (picked) return { ...picked, providerId: drafted.id };
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
      providerId: null,
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
          effort: storedEffort,
          effortSupported: false,
        };
      }
      // Provider deleted / empty list: official takes over on both sides.
      return resolveOfficialFallback(opts.prefs.effort, catalog);
    }
    if (provider.models?.length === 0 && !opts.prefs.sessionModelId?.trim()) {
      return resolveOfficialFallbackForModel(
        opts.prefs.modelId,
        opts.prefs.effort,
        catalog,
      );
    }
    const picked = customSelection(
      provider,
      storedModel,
      opts.prefs.effort,
      opts.prefs.sessionModelId,
    );
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
