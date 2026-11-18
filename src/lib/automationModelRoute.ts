import type { ComposerModelPick } from "@/lib/composerModelGroups";
import { pickDefaultModelId, type ModelOption } from "@/lib/grokCatalog";
import {
  pickSessionEffort,
  resolvePickedModelEfforts,
  resolveSessionEffortOptions,
  type SessionEffortProvider,
} from "@/lib/sessionEffort";

/** Serialize a model pick into one `Select` option value. */
export function automationModelValue(pick: ComposerModelPick): string {
  return JSON.stringify(pick);
}

/** Official ids from the live catalog plus the static fallback. */
export function officialAutomationModelIds(
  live: readonly { id: string }[],
  fallback: readonly { id: string }[],
): string[] {
  return Array.from(
    new Set([...live.map((m) => m.id), ...fallback.map((m) => m.id)]),
  );
}

/** Parse one `Select` option value; invalid legacy values are ignored. */
export function parseAutomationModelValue(
  value: string,
): ComposerModelPick | null {
  try {
    const raw: unknown = JSON.parse(value);
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const modelId = typeof row.modelId === "string" ? row.modelId.trim() : "";
    if (!modelId) return null;
    if (row.kind === "official") {
      return { kind: "official", modelId };
    }
    const providerId =
      typeof row.providerId === "string" ? row.providerId.trim() : "";
    if (row.kind === "custom" && providerId) {
      return { kind: "custom", providerId, modelId };
    }
    return null;
  } catch {
    return null;
  }
}

type AutomationProviderFields = {
  providerId?: string | null;
  modelId?: string | null;
};

type AutomationProviderModels = {
  id: string;
  model: string;
  models?: readonly { id: string }[];
};

/** Provider that uniquely lists `model`; ambiguous matches stay unresolved. */
function uniqueProviderForModel(
  model: string,
  providers: readonly AutomationProviderModels[],
): string | null {
  const matches = providers.filter(
    (p) =>
      p.id !== model &&
      (p.model === model ||
        (p.models ?? []).some((entry) => entry.id === model)),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * Route a scheduled run must use. An explicit provider wins; official catalog
 * models resolve to `official`; a model listed by exactly one custom provider
 * resolves to it. `null` keeps the active route (legacy unknown models).
 */
export function effectiveAutomationProviderId(
  auto: Pick<AutomationProviderFields, "providerId" | "modelId">,
  officialModelIds: readonly string[],
  providers: readonly AutomationProviderModels[] = [],
): string | null {
  const explicit = auto.providerId?.trim();
  if (explicit) return explicit;
  const model = auto.modelId?.trim();
  if (!model) return null;
  if (officialModelIds.includes(model)) return "official";
  return uniqueProviderForModel(model, providers);
}


/** 按 automation 运行时的 provider/model 档位校验并回退过期值。 */
export function resolveAutomationRunEffort(opts: {
  providerId: string | null;
  modelId: string;
  requestedEffort?: string | null;
  providers: ReadonlyArray<SessionEffortProvider>;
  officialModels: ModelOption[];
}): string | undefined {
  const requested = opts.requestedEffort?.trim() ?? "";
  if (!requested) return undefined;
  if (!opts.providerId) return requested;
  const provider =
    opts.providerId === "official"
      ? null
      : opts.providers.find((candidate) => candidate.id === opts.providerId);
  if (opts.providerId !== "official" && !provider) return requested;
  const modelId =
    opts.modelId.trim() ||
    provider?.model.trim() ||
    pickDefaultModelId(opts.officialModels);
  const resolution =
    opts.providerId === "official"
      ? resolveSessionEffortOptions({
          source: "official",
          modelId,
          officialModels: opts.officialModels,
        })
      : resolvePickedModelEfforts({
          pick: {
            kind: "custom",
            providerId: opts.providerId,
            modelId,
          },
          providers: opts.providers,
          officialModels: opts.officialModels,
        });
  if (!resolution?.supported || resolution.options.length === 0) {
    return undefined;
  }
  return pickSessionEffort(resolution.options, requested);
}


/** 按当前可用 provider 规范化已保存的 automation 路由。 */
export function resolveAutomationRunRoute(opts: {
  providerId?: string | null;
  modelId?: string | null;
  officialModelIds: readonly string[];
  officialDefaultModelId: string;
  providers: readonly AutomationProviderModels[];
}): { providerId: string | null; modelId: string } {
  const requestedProviderId = effectiveAutomationProviderId(
    opts,
    opts.officialModelIds,
    opts.providers,
  );
  const providerWasRemoved =
    requestedProviderId != null &&
    requestedProviderId !== "official" &&
    !opts.providers.some((provider) => provider.id === requestedProviderId);
  if (!requestedProviderId) {
    return { providerId: null, modelId: opts.modelId?.trim() ?? "" };
  }
  const normalized = normalizeAutomationRoute({
    providerId: providerWasRemoved ? "official" : requestedProviderId,
    modelId: providerWasRemoved ? "" : opts.modelId ?? "",
    officialModelIds: opts.officialModelIds,
    officialDefaultModelId: opts.officialDefaultModelId,
    providers: opts.providers,
  });
  return {
    providerId: normalized.providerId || (providerWasRemoved ? "official" : requestedProviderId),
    modelId: normalized.modelId,
  };
}

/**
 * Provider to show while editing. Old rows had no provider field; official
 * catalog models resolve to `official`, and a model listed by exactly one
 * provider resolves to that provider. `""` means "keep the active route" so
 * saving an ambiguous legacy row does not pin a guessed provider.
 */
export function inferAutomationProviderId(opts: {
  providerId?: string | null;
  modelId?: string | null;
  officialModelIds: readonly string[];
  providers: readonly AutomationProviderModels[];
  /** Used when the row has no model at all. */
  fallbackProviderId?: string;
}): string {
  const explicit = opts.providerId?.trim();
  if (explicit) return explicit;
  const model = opts.modelId?.trim();
  if (!model) return opts.fallbackProviderId?.trim() || "official";
  if (opts.officialModelIds.includes(model)) return "official";
  return uniqueProviderForModel(model, opts.providers) ?? "";
}

/**
 * Keep the provider/model pair one the picker can render. A model the chosen
 * provider does not list falls back to that provider's own model; an official
 * model that is no longer in the catalog falls back to the official default.
 * An unknown provider becomes the active route (`""`).
 */
export function normalizeAutomationRoute(opts: {
  providerId: string;
  modelId: string;
  officialModelIds: readonly string[];
  officialDefaultModelId: string;
  providers: readonly AutomationProviderModels[];
}): { providerId: string; modelId: string } {
  const providerId = opts.providerId.trim();
  const modelId = opts.modelId.trim();
  if (!providerId) return { providerId: "", modelId };
  if (providerId === "official") {
    const next =
      modelId && opts.officialModelIds.includes(modelId)
        ? modelId
        : opts.officialDefaultModelId;
    return { providerId, modelId: next };
  }
  const provider = opts.providers.find((p) => p.id === providerId);
  if (!provider) return { providerId: "", modelId };
  const models = [provider.model, ...(provider.models ?? []).map((m) => m.id)]
    .map((m) => m.trim())
    .filter(Boolean);
  const next = models.includes(modelId)
    ? modelId
    : provider.model.trim() || models[0] || modelId;
  return { providerId, modelId: next };
}
