import { describe, expect, it } from "vitest";
import type { CustomProvider } from "@/lib/api";
import {
  asFormModel,
  blankModelIdIndex,
  ccSwitchStatusKey,
  emptyForm,
  formFromPreset,
  formModelsPayload,
  hostOf,
  isModelCatalogLocked,
  keepsStoredChannel,
  modelsForProviderSave,
  modelsFromProvider,
  toFormEfforts,
} from "./providerForm";
import { PROVIDER_PRESETS } from "@/lib/providerPresets";

describe("toFormEfforts", () => {
  it("maps entries and trims empty names to ids", () => {
    const out = toFormEfforts([
      { id: "high", name: "  " },
      { id: "low", name: "Low", isDefault: true },
    ]);
    expect(out).toEqual([
      { id: "high", name: "high", isDefault: false },
      { id: "low", name: "Low", isDefault: true },
    ]);
  });

  it("keeps undefined for absent lists and [] for empty ones", () => {
    expect(toFormEfforts(undefined)).toBeUndefined();
    expect(toFormEfforts([])).toEqual([]);
  });
});

describe("asFormModel", () => {
  it("materializes the 1M / four-level defaults and keeps legacy flags", () => {
    const out = asFormModel({
      id: "m1",
      name: "M1",
      contextWindow: undefined,
      supportsVision: true,
      supportsVideo: false,
    } as Parameters<typeof asFormModel>[0]);
    expect(out.contextWindow).toBe(1_000_000);
    expect(out.contextWindowSource).toBe("fallback");
    expect(out.supportsVision).toBe(true);
    expect(out.supportsVideo).toBe(false);
    expect(out.efforts?.map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(out.efforts?.find((effort) => effort.isDefault)?.id).toBe("medium");
    expect(out.effortsSource).toBe("fallback");
    expect(out.supportsReasoningEffort).toBe(true);
    expect(out.supportsReasoningEffortSource).toBe("fallback");
  });

  it("keeps an existing value without a source marker as user-set", () => {
    // 无用户档位时，显式 supportsReasoningEffort 原样保留为 user-set。
    const out = asFormModel({
      id: "m1",
      name: "M1",
      contextWindow: 128_000,
      supportsReasoningEffort: false,
    });
    expect(out.contextWindowSource).toBe("user");
    expect(out.supportsReasoningEffort).toBe(false);
    expect(out.supportsReasoningEffortSource).toBe("user");
  });

  it("user-configured efforts imply reasoning support", () => {
    // 新语义：模型行配置了用户档位即表示支持扩展推理（catalog.md）。
    const out = asFormModel({
      id: "m1",
      name: "M1",
      contextWindow: 128_000,
      efforts: [{ id: "maximum", name: "Maximum", isDefault: true }],
      supportsReasoningEffort: false,
    });
    expect(out.effortsSource).toBe("user");
    expect(out.supportsReasoningEffort).toBe(true);
    expect(out.supportsReasoningEffortSource).toBe("user");
  });
});

describe("modelsFromProvider", () => {
  it("uses explicit models when present", () => {
    const out = modelsFromProvider({
      id: "p",
      models: [{ id: "a" }, { id: "b", name: "B" }],
    } as Parameters<typeof modelsFromProvider>[0]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
    expect(out[1]?.name).toBe("B");
  });

  it("falls back to the legacy single model field with metadata defaults", () => {
    const out = modelsFromProvider({
      id: "p",
      model: "legacy-id",
    } as Parameters<typeof modelsFromProvider>[0]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "legacy-id",
      name: "legacy-id",
      contextWindow: 1_000_000,
      contextWindowSource: "fallback",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "fallback",
    });
    expect(out[0]?.efforts?.map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("keeps an explicitly cleared catalog empty", () => {
    const out = modelsFromProvider({
      id: "p",
      model: "legacy-id",
      models: [],
    } as unknown as Parameters<typeof modelsFromProvider>[0]);
    expect(out).toEqual([]);
  });

  it("returns empty when the provider has no model at all", () => {
    const out = modelsFromProvider({ id: "p" } as Parameters<
      typeof modelsFromProvider
    >[0]);
    expect(out).toEqual([]);
  });
});

describe("blankModelIdIndex", () => {
  it("returns -1 when every row has a usable id", () => {
    expect(
      blankModelIdIndex([
        { id: "m1", name: "M1" },
        { id: " m2 ", name: "" },
      ]),
    ).toBe(-1);
  });

  it("reports the first row whose id is blank after trimming", () => {
    expect(
      blankModelIdIndex([
        { id: "m1", name: "M1" },
        { id: "   ", name: "Blank" },
        { id: "", name: "" },
      ]),
    ).toBe(1);
  });

  it("treats an empty catalog as valid (explicit clear)", () => {
    expect(blankModelIdIndex([])).toBe(-1);
  });
});

describe("formModelsPayload", () => {
  it("trims ids, falls back names, and keeps every valid row", () => {
    const out = formModelsPayload([
      { id: " m1 ", name: "  " },
      { id: "m2", name: "M2" },
    ] as Parameters<typeof formModelsPayload>[0]);
    const defaults = {
      contextWindow: 1_000_000,
      contextWindowSource: "fallback",
      supportsVision: undefined,
      supportsVideo: undefined,
      efforts: [
        { id: "low", name: "low", isDefault: false },
        { id: "medium", name: "medium", isDefault: true },
        { id: "high", name: "high", isDefault: false },
        { id: "xhigh", name: "xhigh", isDefault: false },
      ],
      effortsSource: "fallback",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "fallback",
    };
    expect(out).toEqual([
      { id: "m1", name: "m1", ...defaults },
      { id: "m2", name: "M2", ...defaults },
    ]);
  });

  it("refuses a blank row instead of shrinking the catalog", () => {
    expect(() =>
      formModelsPayload([
        { id: "m1", name: "M1" },
        { id: "   ", name: "Dropped" },
      ]),
    ).toThrow(/non-empty id/);
    // A single blank row must not normalize into the explicit-clear path.
    expect(() => formModelsPayload([{ id: "", name: "" }])).toThrow(
      /non-empty id/,
    );
  });

  it("keeps [] as the explicit clear", () => {
    expect(formModelsPayload([])).toEqual([]);
  });
});

describe("modelsForProviderSave", () => {
  const corruptProvider = {
    id: "relay",
    model: "m1",
    baseUrl: "https://relay.example/v1",
    name: "Relay",
    hasApiKey: true,
    apiBackend: "chat_completions",
    providerMode: "generic",
    isDefault: false,
    models: [{ id: "m1", name: "m1" }],
    modelCatalogCorrupt: true,
  } as CustomProvider;

  it("omits models when a corrupt catalog was not edited", () => {
    // The rows the host returned are only the read fallback. Omission keeps
    // the original `app_models` text on disk.
    const out = modelsForProviderSave({
      formModels: modelsFromProvider(corruptProvider),
      stored: corruptProvider,
    });
    expect(out).toBeUndefined();
  });

  it("sends the edited rows when the user repairs the catalog", () => {
    const out = modelsForProviderSave({
      formModels: [{ id: "m2", name: "M2" }],
      stored: corruptProvider,
    });
    expect(out?.map((m) => m.id)).toEqual(["m2"]);
  });

  it("omits models when recovered rows from a partially invalid catalog are untouched", () => {
    // The host returns readable rows from a partially invalid array, but the
    // stored value is still unreadable: an unchanged form is not a repair.
    const partial = {
      ...corruptProvider,
      models: [
        { id: "m1", name: "M1" },
        { id: "m2", name: "M2" },
      ],
    } as CustomProvider;
    const out = modelsForProviderSave({
      formModels: modelsFromProvider(partial),
      stored: partial,
    });
    expect(out).toBeUndefined();
  });

  it("sends [] when the user clears the stored catalog", () => {
    const out = modelsForProviderSave({
      formModels: [],
      stored: corruptProvider,
    });
    expect(out).toEqual([]);
  });

  it("refuses a blank row instead of dropping it from the payload", () => {
    expect(() =>
      modelsForProviderSave({
        formModels: [
          { id: "m1", name: "m1" },
          { id: "   ", name: "Half-typed" },
        ],
        stored: corruptProvider,
      }),
    ).toThrow(/non-empty id/);
  });

  it("sends every valid row of a mixed catalog", () => {
    const out = modelsForProviderSave({
      formModels: [
        { id: "m1", name: "m1" },
        { id: " m2 ", name: "" },
      ],
      stored: undefined,
    });
    expect(out?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("omits models for an untouched legacy provider", () => {
    const legacy = { id: "p", model: "legacy-id" } as CustomProvider;
    const out = modelsForProviderSave({
      formModels: modelsFromProvider(legacy),
      stored: legacy,
    });
    expect(out).toBeUndefined();
  });

  it("always sends the form catalog for a new provider", () => {
    const out = modelsForProviderSave({
      formModels: [{ id: "preset-a", name: "Preset A" }],
      stored: undefined,
    });
    expect(out?.map((m) => m.id)).toEqual(["preset-a"]);
  });

  it("sends [] for a new provider with no catalog rows", () => {
    const out = modelsForProviderSave({ formModels: [], stored: undefined });
    expect(out).toEqual([]);
  });

  it("omits the fallback on a create collision that left the catalog alone", () => {
    // Re-adding a preset hits `already exists` and turns into an update; the
    // untouched corrupt `app_models` must survive that overwrite.
    const out = modelsForProviderSave({
      formModels: modelsFromProvider(corruptProvider),
      stored: corruptProvider,
    });
    expect(out).toBeUndefined();
  });

  it("sends the preset catalog on a create collision that changes it", () => {
    const out = modelsForProviderSave({
      formModels: [
        { id: "m1", name: "m1" },
        { id: "m3", name: "M3" },
      ],
      stored: corruptProvider,
    });
    expect(out?.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("sends [] on a create collision that explicitly clears the catalog", () => {
    const out = modelsForProviderSave({
      formModels: [],
      stored: corruptProvider,
    });
    expect(out).toEqual([]);
  });

  it("omits models when only per-model metadata changed on a corrupt catalog", () => {
    // Gear edits seed from the read fallback, not from the unreadable original.
    const out = modelsForProviderSave({
      formModels: modelsFromProvider(corruptProvider).map((m) => ({
        ...m,
        contextWindow: 128000,
        supportsVision: true,
        efforts: [{ id: "high", name: "High", isDefault: true }],
      })),
      stored: corruptProvider,
    });
    expect(out).toBeUndefined();
  });

  it("sends per-model metadata edits for a readable catalog", () => {
    const healthy = { ...corruptProvider, modelCatalogCorrupt: false };
    const out = modelsForProviderSave({
      formModels: modelsFromProvider(healthy).map((m) => ({
        ...m,
        contextWindow: 128000,
      })),
      stored: healthy,
    });
    expect(out?.[0]?.contextWindow).toBe(128000);
  });
});

describe("isModelCatalogLocked", () => {
  const corruptProvider = {
    id: "relay",
    model: "m1",
    baseUrl: "https://relay.example/v1",
    name: "Relay",
    hasApiKey: true,
    apiBackend: "chat_completions",
    providerMode: "generic",
    isDefault: false,
    models: [{ id: "m1", name: "m1" }],
    modelCatalogCorrupt: true,
  } as CustomProvider;

  it("locks per-model settings while a corrupt catalog is untouched", () => {
    const locked = isModelCatalogLocked({
      stored: corruptProvider,
      isCreate: false,
      formModels: modelsFromProvider(corruptProvider),
    });
    expect(locked).toBe(true);
  });

  it("stays locked when only per-model metadata changes", () => {
    const locked = isModelCatalogLocked({
      stored: corruptProvider,
      isCreate: false,
      formModels: modelsFromProvider(corruptProvider).map((m) => ({
        ...m,
        contextWindow: 128000,
        supportsVision: true,
      })),
    });
    expect(locked).toBe(true);
  });

  it("unlocks after the catalog rows are explicitly edited", () => {
    expect(
      isModelCatalogLocked({
        stored: corruptProvider,
        isCreate: false,
        formModels: [{ id: "m2", name: "M2" }],
      }),
    ).toBe(false);
    expect(
      isModelCatalogLocked({
        stored: corruptProvider,
        isCreate: false,
        formModels: [{ id: "m1", name: "Renamed" }],
      }),
    ).toBe(false);
  });

  it("locks a create collision with a corrupt provider", () => {
    const locked = isModelCatalogLocked({
      stored: corruptProvider,
      isCreate: true,
      formModels: [{ id: "preset-model", name: "Preset model" }],
    });
    expect(locked).toBe(true);
  });

  it("allows settings for readable or new providers", () => {
    expect(
      isModelCatalogLocked({
        stored: { ...corruptProvider, modelCatalogCorrupt: false },
        isCreate: false,
        formModels: modelsFromProvider(corruptProvider),
      }),
    ).toBe(false);
    expect(
      isModelCatalogLocked({
        stored: undefined,
        isCreate: true,
        formModels: [{ id: "m1", name: "M1" }],
      }),
    ).toBe(false);
  });
});

describe("keepsStoredChannel", () => {
  const recovered = {
    id: "relay",
    model: "m1",
    baseUrl: "https://relay.example/v1",
    name: "Relay",
    hasApiKey: true,
    apiBackend: "chat_completions",
    providerMode: "generic",
    isDefault: false,
    models: [{ id: "m2", name: "M2" }],
    modelCatalogCorrupt: true,
  } as CustomProvider;

  it("keeps the stored channel while an unreadable catalog stays on disk", () => {
    expect(
      keepsStoredChannel({ stored: recovered, modelsToSave: undefined }),
    ).toBe(true);
  });

  it("derives the channel when the rows repair the catalog", () => {
    expect(
      keepsStoredChannel({
        stored: recovered,
        modelsToSave: [{ id: "m2", name: "M2" }],
      }),
    ).toBe(false);
  });

  it("derives the channel for a readable catalog", () => {
    expect(
      keepsStoredChannel({
        stored: { ...recovered, modelCatalogCorrupt: false },
        modelsToSave: undefined,
      }),
    ).toBe(false);
  });

  it("derives the channel for a new provider", () => {
    expect(
      keepsStoredChannel({ stored: undefined, modelsToSave: undefined }),
    ).toBe(false);
  });
});

describe("emptyForm", () => {
  it("seeds default custom-channel efforts and neutral defaults", () => {
    const f = emptyForm();
    expect(f.id).toBe("");
    expect(f.providerMode).toBe("generic");
    expect(f.apiBackend).toBe("responses");
    expect(f.efforts.length).toBeGreaterThan(0);
    expect(f.models).toEqual([]);
  });
});

describe("formFromPreset", () => {
  it("builds a form from a real preset with its default endpoint", () => {
    const preset = PROVIDER_PRESETS[0];
    const f = formFromPreset(preset);
    expect(f.id).toBe(preset.suggestedId);
    expect(f.name).toBe(preset.name);
    expect(f.baseUrl).toContain("http");
    expect(f.apiKey).toBe("");
    expect(f.models.length).toBe(preset.models.length);
  });
});

describe("hostOf", () => {
  it("extracts the host of valid urls and passes junk through", () => {
    expect(hostOf("https://api.example.com/v1")).toBe("api.example.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("ccSwitchStatusKey", () => {
  it("maps every known status and falls back to invalid", () => {
    expect(ccSwitchStatusKey("importable")).toBe("prov.ccSwitch.status.importable");
    expect(ccSwitchStatusKey("official")).toBe("prov.ccSwitch.status.official");
    expect(ccSwitchStatusKey("missing_key")).toBe("prov.ccSwitch.status.missing_key");
    expect(ccSwitchStatusKey("proxy_managed")).toBe("prov.ccSwitch.status.proxy_managed");
    expect(ccSwitchStatusKey("exists")).toBe("prov.ccSwitch.status.exists");
    expect(ccSwitchStatusKey("whatever")).toBe("prov.ccSwitch.status.invalid");
  });
});

describe("per-model metadata persistence", () => {
  it("keeps legacy vision/video flags while saving metadata", () => {
    const out = formModelsPayload([
      {
        id: "m1",
        name: "M1",
        contextWindow: 128000,
        contextWindowSource: "user",
        supportsVision: true,
        supportsVideo: false,
        efforts: [{ id: "high", name: "High", isDefault: true }],
        effortsSource: "user",
        supportsReasoningEffort: false,
        supportsReasoningEffortSource: "user",
      },
    ]);
    expect(out).toEqual([
      {
        id: "m1",
        name: "M1",
        contextWindow: 128000,
        contextWindowSource: "user",
        supportsVision: true,
        supportsVideo: false,
        efforts: [{ id: "high", name: "High", isDefault: true }],
        effortsSource: "user",
        // 用户档位存在 ⇒ 支持推理（新语义，providerModelConfig）。
        supportsReasoningEffort: true,
        supportsReasoningEffortSource: "user",
      },
    ]);
  });

  it("seeds preset rows with the approved fallbacks for API refresh", () => {
    const preset = PROVIDER_PRESETS[0];
    const form = formFromPreset(preset);
    expect(form.models.length).toBeGreaterThan(0);
    expect(form.models[0]?.contextWindow).toBe(
      preset.contextWindow ?? 1_000_000,
    );
    expect(form.models[0]?.contextWindowSource).toBe("fallback");
    expect(form.models[0]?.effortsSource).toBe("fallback");
    expect(form.models[0]?.supportsReasoningEffort).toBe(true);
    expect(form.models[0]?.supportsReasoningEffortSource).toBe("fallback");
  });
});
