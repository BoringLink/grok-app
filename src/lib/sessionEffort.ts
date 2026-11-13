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
  DEFAULT_EFFORT,
  effortOptionsFromProvider,
  effortsForModel,
  findModel,
  pickDefaultEffort,
  type EffortOption,
  type ModelOption,
} from "@/lib/grokCatalog";
import {
  defaultProviderModelEfforts,
  effectiveModelSupportsReasoningEffort,
  normalizeModelEfforts,
} from "@/lib/providerModelConfig";
import { alignGrokPresetEfforts } from "@/lib/providerPresets";

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

function customModelEfforts(
  provider: SessionEffortProvider,
  modelId: string,
): ProviderEffortEntry[] {
  const id = modelId.trim();
  const model = id
    ? provider.models?.find((entry) => entry.id.trim() === id) ?? null
    : null;
  const raw =
    model?.efforts && model.efforts.length > 0
      ? model.efforts
      : provider.efforts;
  const aligned = alignGrokPresetEfforts({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    efforts: raw,
  });
  return normalizeModelEfforts(aligned ?? raw ?? []);
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
  if (options.length === 0) return id || DEFAULT_EFFORT;
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
