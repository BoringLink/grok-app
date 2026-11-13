/**
 * Reasoning effort options for the model / provider a chat is actually routed
 * to. Options keep the catalog's raw ids and order; the composer never maps a
 * custom variant onto a shared four-level ladder.
 *
 * `none` is an Off state only when the model's own catalog advertises it. A
 * model that merely supports reasoning does not gain an Off row: the CLI can
 * only pass through values the model advertises.
 */

import type { CustomProvider, ProviderEffortEntry } from "@/lib/api";
import {
  effortOptionsFromProvider,
  effortsForModel,
  findModel,
  isValidModelId,
  pickDefaultEffort,
  type EffortOption,
  type ModelOption,
} from "@/lib/grokCatalog";
import {
  defaultProviderModelEfforts,
  effectiveModelSupportsReasoningEffort,
  normalizeModelEfforts,
} from "@/lib/providerModelConfig";

export type SessionEffortResolution = {
  /** Raw catalog ids in advertised order. Empty when unsupported or loading. */
  options: EffortOption[];
  /** False only when the selected model explicitly rejects reasoning effort. */
  supported: boolean;
  /** True while the custom provider catalog has not loaded yet. */
  pending: boolean;
};

export type SessionEffortProvider = Pick<
  CustomProvider,
  "id" | "baseUrl" | "model" | "models" | "efforts"
>;

export type SessionEffortRoute = {
  source: "official" | "custom";
  provider?: SessionEffortProvider | null;
  modelId: string;
  officialModels?: ModelOption[];
};

export type SessionEffortPick =
  | { kind: "official"; modelId: string }
  | { kind: "custom"; providerId: string; modelId: string };

/** Options for a composer model pick, or null when the pick is unknown. */
export function resolvePickedModelEfforts(input: {
  pick: SessionEffortPick;
  providers: ReadonlyArray<SessionEffortProvider>;
  officialModels: ModelOption[];
}): SessionEffortResolution | null {
  const pick = input.pick;
  if (pick.kind === "official") {
    if (!isValidModelId(pick.modelId, input.officialModels)) return null;
    return resolveSessionEffortOptions({
      source: "official",
      modelId: pick.modelId,
      officialModels: input.officialModels,
    });
  }
  const provider = input.providers.find(
    (candidate) => candidate.id === pick.providerId,
  );
  if (!provider) return null;
  return resolveSessionEffortOptions({
    source: "custom",
    provider,
    modelId: pick.modelId,
  });
}

function customModelEfforts(
  provider: SessionEffortProvider,
  modelId: string,
): ProviderEffortEntry[] {
  const id = modelId.trim();
  const model = id
    ? provider.models?.find((entry) => entry.id.trim() === id) ?? null
    : null;
  // Session resolution is a raw pass-through: no preset remapping (`max`
  // must stay `max`, vendor ids stay untouched).
  const raw =
    model?.efforts && model.efforts.length > 0
      ? model.efforts
      : provider.efforts;
  return normalizeModelEfforts(raw ?? []);
}

/** Options the composer shows for one session's resolved route. */
export function resolveSessionEffortOptions(
  input: SessionEffortRoute,
): SessionEffortResolution {
  if (input.source === "official") {
    return {
      options: effortsForModel(
        findModel(input.modelId, input.officialModels),
      ),
      supported: true,
      pending: false,
    };
  }
  const provider = input.provider;
  if (!provider) {
    return { options: [], supported: true, pending: true };
  }
  const id = input.modelId.trim();
  const model = id
    ? provider.models?.find((entry) => entry.id.trim() === id) ?? null
    : null;
  if (model && !effectiveModelSupportsReasoningEffort(model).value) {
    return { options: [], supported: false, pending: false };
  }
  const efforts = customModelEfforts(provider, input.modelId);
  const source = efforts.length > 0 ? efforts : defaultProviderModelEfforts();
  const options =
    effortOptionsFromProvider(source) ??
    effortOptionsFromProvider(defaultProviderModelEfforts());
  return {
    options: options ?? [],
    supported: true,
    pending: false,
  };
}

/**
 * Exact raw id when the model advertises it, else the catalog default
 * (`isDefault` flag, then `medium`, then the first option). An empty ladder
 * keeps the caller's stored id: the model exposes no choice to reset to.
 */
export function pickSessionEffort(
  options: EffortOption[],
  requested?: string | null,
): string {
  const id = requested?.trim() ?? "";
  if (id && options.some((option) => option.id === id)) return id;
  // No advertised options means no effective effort; an empty ladder must
  // never fabricate the static fallback as if it were selectable.
  if (options.length === 0) return id;
  return pickDefaultEffort(null, options);
}

export type SessionEffortSaveResult =
  | { ok: true; effort: string }
  | { ok: false; error: unknown };

/**
 * Persist one effort pick before moving the composer. A rejected save leaves
 * the visible selection untouched so the chip never claims an unsaved value.
 */
export async function saveSessionEffort(opts: {
  effort: string;
  save: (effort: string) => Promise<unknown>;
  apply: (effort: string) => void;
}): Promise<SessionEffortSaveResult> {
  try {
    await opts.save(opts.effort);
    opts.apply(opts.effort);
    return { ok: true, effort: opts.effort };
  } catch (error) {
    return { ok: false, error };
  }
}
