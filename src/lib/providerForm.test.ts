import { describe, expect, it } from "vitest";
import type { CustomProvider } from "@/lib/api";
import {
  asFormModel,
  ccSwitchStatusKey,
  emptyForm,
  formFromPreset,
  formModelsPayload,
  hostOf,
  isModelCatalogLocked,
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
  it("normalizes contextWindow null and passes flags through", () => {
    const out = asFormModel({
      id: "m1",
      name: "M1",
      contextWindow: undefined,
      supportsVision: true,
      supportsVideo: false,
    } as Parameters<typeof asFormModel>[0]);
    expect(out.contextWindow).toBeNull();
    expect(out.supportsVision).toBe(true);
    expect(out.efforts).toBeUndefined();
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

  it("falls back to the legacy single model field", () => {
    const out = modelsFromProvider({
      id: "p",
      model: "legacy-id",
    } as Parameters<typeof modelsFromProvider>[0]);
    expect(out).toEqual([{ id: "legacy-id", name: "legacy-id" }]);
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

describe("formModelsPayload", () => {
  it("trims ids, falls back names, and drops blank rows", () => {
    const out = formModelsPayload([
      { id: " m1 ", name: "  " },
      { id: "   ", name: "Dropped" },
    ] as Parameters<typeof formModelsPayload>[0]);
    expect(out).toEqual([
      {
        id: "m1",
        name: "m1",
        contextWindow: null,
        supportsVision: undefined,
        supportsVideo: undefined,
        efforts: [],
      },
    ]);
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

  it("sends [] when the user clears the stored catalog", () => {
    const out = modelsForProviderSave({
      formModels: [],
      stored: corruptProvider,
    });
    expect(out).toEqual([]);
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
