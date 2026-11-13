import { describe, expect, it } from "vitest";
import { GROK_BUILD_MODELS } from "@/lib/grokCatalog";
import { resolveCustomRouteDisplay } from "@/lib/effectiveModel";
import { resolveComposerPrefsSelection } from "./composerPrefsApply";

const requesty = {
  id: "requesty",
  model: "grok-4.6",
  baseUrl: "https://router.requesty.ai/v1",
  efforts: [
    { id: "low", name: "low" },
    { id: "medium", name: "medium", isDefault: true },
    { id: "high", name: "high" },
    { id: "max", name: "max" },
  ],
  models: [
    { id: "grok-4.6", name: "Grok 4.6" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  ],
};

describe("resolveComposerPrefsSelection", () => {
  it("keeps a proxy catalog id that is not in the official catalog", () => {
    const proxy = { ...requesty, providerMode: "grok_build_proxy" as const };
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "gemini-3.5-flash",
        effort: "max",
        providerId: "requesty",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [proxy],
    });
    expect(next.modelId).toBe("gemini-3.5-flash");
    expect(next.effort).toBe("max");
    const shown = resolveCustomRouteDisplay(proxy, next.modelId);
    expect(shown?.chip).toEqual({
      name: "Gemini 3.5 Flash",
      model: "gemini-3.5-flash",
    });
    expect(shown?.requestModel).toBe("gemini-3.5-flash");
  });

  it("keeps a stored catalog id on a generic channel", () => {
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "gemini-3.5-flash",
        effort: "max",
        providerId: "requesty",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [requesty],
    });
    expect(next.modelId).toBe("gemini-3.5-flash");
    expect(next.effort).toBe("max");
    const shown = resolveCustomRouteDisplay(requesty, next.modelId);
    expect(shown?.chip).toEqual({
      name: "Gemini 3.5 Flash",
      model: "gemini-3.5-flash",
    });
    expect(shown?.requestModel).toBe("gemini-3.5-flash");
  });

  it("keeps a new chat's pick when the resolve returns the default", () => {
    // Arrange — a chat with no session row: its pick is only in memory
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.7", effort: "medium" },
      catalog: GROK_BUILD_MODELS,
      draft: { providerId: "official", modelId: "grok-4.6", effort: "high" },
    });

    // Act / Assert
    expect(next).toEqual({ modelId: "grok-4.6", effort: "high" });
  });

  it("keeps a new chat's custom-provider pick", () => {
    // Arrange — the resolve knows the global route, not the one the chat picked
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.7", effort: "medium", providerId: null },
      catalog: GROK_BUILD_MODELS,
      providers: [requesty],
      draft: {
        providerId: "requesty",
        modelId: "gemini-3.5-flash",
        effort: "max",
      },
    });

    // Act / Assert
    expect(next).toEqual({ modelId: "gemini-3.5-flash", effort: "max" });
  });

  it("keeps a new chat's pick on a Grok Build-compatible relay", () => {
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.7", effort: "medium", providerId: null },
      catalog: GROK_BUILD_MODELS,
      providers: [{ ...requesty, providerMode: "grok_build_proxy" }],
      draft: {
        providerId: "requesty",
        modelId: "gemini-3.5-flash",
        effort: "max",
      },
    });
    expect(next).toEqual({ modelId: "gemini-3.5-flash", effort: "max" });
  });

  it("falls back to official when the loaded provider list is empty", () => {
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "deepseek-v4-flash",
        effort: "max",
        providerId: "deleted",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [],
      providersLoaded: true,
    });
    expect(next.modelId).toBe("grok-4.7");
    expect(next.providerId).toBeNull();
  });

  it("falls back to official when the stored provider was deleted", () => {
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "gemini-3.5-flash",
        effort: "max",
        providerId: "deleted",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [requesty],
      providersLoaded: true,
    });
    expect(next.modelId).toBe("grok-4.7");
    expect(next.providerId).toBeNull();
  });

  it("keeps a new chat's pick while the provider list is not loaded yet", () => {
    // Arrange — nothing disproves the pick, so it is not thrown away
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.7", effort: "medium" },
      catalog: GROK_BUILD_MODELS,
      providers: [],
      draft: {
        providerId: "requesty",
        modelId: "gemini-3.5-flash",
        effort: "max",
      },
    });

    // Act / Assert
    expect(next.modelId).toBe("gemini-3.5-flash");
  });

  it("ignores a draft pick that is not a model of the resolved route", () => {
    // Arrange — the route moved on, so the old pick no longer applies
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.7", effort: "medium" },
      catalog: GROK_BUILD_MODELS,
      draft: { providerId: "official", modelId: "not-a-real-model", effort: "high" },
    });

    // Act / Assert
    expect(next.modelId).toBe("grok-4.7");
  });

  it("validates effort against the picked proxy model, not the channel default", () => {
    const provider = {
      id: "relay",
      model: "plain",
      providerMode: "grok_build_proxy" as const,
      baseUrl: "https://relay.example/v1",
      efforts: [
        { id: "low", name: "low" },
        { id: "high", name: "high", isDefault: true },
      ],
      models: [
        {
          id: "plain",
          name: "Plain",
          efforts: [
            { id: "low", name: "low" },
            { id: "high", name: "high", isDefault: true },
          ],
        },
        {
          id: "gemini-3.5-flash",
          name: "Gemini 3.5 Flash",
          efforts: [
            { id: "low", name: "low" },
            { id: "high", name: "high" },
            { id: "max", name: "max", isDefault: true },
          ],
        },
      ],
    };
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "gemini-3.5-flash",
        effort: "max",
        providerId: "relay",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [provider],
    });
    expect(next.modelId).toBe("gemini-3.5-flash");
    expect(next.effort).toBe("max");
  });

  it("keeps the selected model's effort ladder on a generic channel", () => {
    const provider = {
      id: "relay",
      model: "plain",
      providerMode: "generic" as const,
      baseUrl: "https://relay.example/v1",
      efforts: [
        { id: "low", name: "low" },
        { id: "high", name: "high", isDefault: true },
      ],
      models: [
        { id: "plain", name: "Plain" },
        {
          id: "gemini-3.5-flash",
          name: "Gemini 3.5 Flash",
          efforts: [{ id: "max", name: "max", isDefault: true }],
        },
      ],
    };
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "gemini-3.5-flash",
        effort: "max",
        providerId: "relay",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [provider],
    });
    expect(next.modelId).toBe("gemini-3.5-flash");
    expect(next.effort).toBe("max");
  });

  it("keeps each generic chat on its stored catalog model", () => {
    const kiro = {
      id: "kiro",
      model: "auto",
      baseUrl: "https://kiro.example/v1",
      models: [
        { id: "auto", name: "Auto" },
        { id: "gpt-5.6-luna", name: "Luna" },
      ],
    };
    const other = {
      id: "other",
      model: "sol",
      baseUrl: "https://other.example/v1",
      models: [
        { id: "sol", name: "Sol" },
        { id: "gpt-5.6-luna", name: "Luna" },
      ],
    };
    const luna = resolveComposerPrefsSelection({
      prefs: { modelId: "gpt-5.6-luna", effort: "low", providerId: "kiro" },
      catalog: GROK_BUILD_MODELS,
      providers: [kiro, other],
    });
    const sol = resolveComposerPrefsSelection({
      prefs: { modelId: "gpt-5.6-luna", effort: "low", providerId: "other" },
      catalog: GROK_BUILD_MODELS,
      providers: [kiro, other],
    });
    expect(luna.modelId).toBe("gpt-5.6-luna");
    expect(sol.modelId).toBe("gpt-5.6-luna");
  });

  it("pins SSH project preferences to an official model", () => {
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "deepseek-v4-flash", effort: "high", providerId: "relay" },
      catalog: GROK_BUILD_MODELS,
      providers: [requesty],
      forceOfficial: true,
    });

    expect(next).toEqual({
      modelId: "grok-4.7",
      effort: "high",
      providerId: null,
    });
  });

  it("keeps an official model id when an SSH session has a matching official model", () => {
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.6", effort: "low", providerId: "relay" },
      catalog: GROK_BUILD_MODELS,
      providers: [requesty],
      forceOfficial: true,
    });

    expect(next).toEqual({ modelId: "grok-4.6", effort: "low", providerId: null });
  });

  it("falls back to the provider model when the stored custom id is unknown", () => {
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "not-in-catalog",
        effort: "max",
        providerId: "requesty",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [requesty],
    });
    expect(next.modelId).toBe("grok-4.6");
    expect(next.effort).toBe("max");
  });

  it("keeps the stored custom id until that provider's catalog has loaded", () => {
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "deepseek-v4-flash",
        effort: "max",
        providerId: "requesty",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [],
    });
    expect(next.modelId).toBe("deepseek-v4-flash");
    expect(next.effort).toBe("max");
  });

  it("still resolves official prefs against the official catalog", () => {
    const kept = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.5", effort: "low", providerId: "official" },
      catalog: GROK_BUILD_MODELS,
      providers: [requesty],
    });
    expect(kept).toEqual({ modelId: "grok-4.5", effort: "low" });

    const fallback = resolveComposerPrefsSelection({
      prefs: { modelId: "nope", effort: "nope", providerId: null },
      catalog: GROK_BUILD_MODELS,
    });
    expect(fallback.modelId).toBe("grok-4.7");
    expect(fallback.effort).toBe("xhigh");
  });
});

describe("resolveComposerPrefsSelection with an explicitly cleared catalog", () => {
  const cleared = {
    id: "cleared",
    model: "deepseek-chat",
    baseUrl: "https://cleared.example/v1",
    models: [],
  };

  it("does not seed the channel model for a chat without a model preference", () => {
    // Arrange — the catalog was cleared, so the channel `model` is no row
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: null, effort: null, providerId: "cleared" },
      catalog: GROK_BUILD_MODELS,
      providers: [cleared],
    });

    // Act / Assert — the official default and route, not the cleared channel
    expect(next).toEqual({
      modelId: "grok-4.7",
      effort: "high",
      providerId: null,
    });
  });

  it("keeps a saved session's model even though its catalog was cleared", () => {
    // Arrange — the session still routes on its preserved child section
    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "deepseek-reasoner",
        effort: null,
        providerId: "cleared",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [cleared],
    });

    // Act / Assert
    expect(next).toEqual({ modelId: "deepseek-reasoner", effort: "high" });
    // The session keeps its stored route, so no official override is issued.
    expect(next.providerId).toBeUndefined();
    // The chip has to route on that same id, not the cleared channel `model`.
    const shown = resolveCustomRouteDisplay(cleared, next.modelId);
    expect(shown?.chip.model).toBe("deepseek-reasoner");
    expect(shown?.requestModel).toBe("deepseek-reasoner");
  });

  it("still seeds the channel model for a legacy provider with no catalog", () => {
    // Arrange — no catalog at all is the legacy read, not a clear
    const legacy = {
      id: "legacy",
      model: "llama3",
      baseUrl: "https://legacy.example/v1",
    };
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: null, effort: null, providerId: "legacy" },
      catalog: GROK_BUILD_MODELS,
      providers: [legacy],
    });

    // Act / Assert
    expect(next).toEqual({ modelId: "llama3", effort: "high" });
    // A legacy provider that still lists a row keeps its own route.
    expect(next.providerId).toBeUndefined();
  });

  it("leaves a deleted provider's chat on the official route", () => {
    // Arrange — the chat remembers a provider the list no longer has
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: null, effort: null, providerId: "gone" },
      catalog: GROK_BUILD_MODELS,
      providers: [cleared],
    });

    // Act / Assert — official model, and the route has to follow it
    expect(next.modelId).toBe("grok-4.7");
    expect(next.providerId).toBeNull();
  });
});

describe("resolveComposerPrefsSelection with a corrupt catalog", () => {
  const corrupt = {
    id: "corrupt",
    model: "m1",
    baseUrl: "https://corrupt.example/v1",
    modelCatalogCorrupt: true,
    efforts: [
      { id: "low", name: "low" },
      { id: "high", name: "high", isDefault: true },
    ],
    models: [
      {
        id: "m1",
        name: "M1",
        efforts: [{ id: "max", name: "max", isDefault: true }],
      },
    ],
  };

  it("keeps a saved model id the partial read no longer lists", () => {
    // Arrange — the session still has its own generic child section
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "m2", effort: null, providerId: "corrupt" },
      catalog: GROK_BUILD_MODELS,
      providers: [corrupt],
    });

    // Act / Assert — m2 routes, with the channel ladder, not m1's `max`
    expect(next).toEqual({ modelId: "m2", effort: "high" });
    const shown = resolveCustomRouteDisplay(corrupt, next.modelId);
    expect(shown?.chip).toEqual({ name: "m2", model: "m2" });
    expect(shown?.requestModel).toBe("m2");
  });

  it("labels a model the recovered rows still list", () => {
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "m1", effort: "max", providerId: "corrupt" },
      catalog: GROK_BUILD_MODELS,
      providers: [corrupt],
    });

    expect(next).toEqual({ modelId: "m1", effort: "max" });
    const shown = resolveCustomRouteDisplay(corrupt, next.modelId);
    expect(shown?.chip).toEqual({ name: "M1", model: "m1" });
    expect(shown?.requestModel).toBe("m1");
  });

  it("leaves an unknown id on a readable catalog on the channel model", () => {
    // Arrange — the same rows, but the catalog itself is readable
    const readable = { ...corrupt, modelCatalogCorrupt: false };

    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "m2", effort: null, providerId: "corrupt" },
      catalog: GROK_BUILD_MODELS,
      providers: [readable],
    });

    // Act / Assert — the existing fallback still applies
    expect(next.modelId).toBe("m1");
    expect(resolveCustomRouteDisplay(readable, "m2")?.requestModel).toBe("m1");
  });

  it("keeps the existing fallback when there is no stored model", () => {
    // Arrange — nothing was saved, so there is no session id to preserve
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: null, effort: null, providerId: "corrupt" },
      catalog: GROK_BUILD_MODELS,
      providers: [corrupt],
    });

    // Act / Assert — the recovered row, not a fabricated selection
    expect(next).toEqual({ modelId: "m1", effort: "max" });
    // A recovered row is still a custom model, so the route stays custom.
    expect(next.providerId).toBeUndefined();
    expect(resolveCustomRouteDisplay(corrupt, next.modelId)?.requestModel).toBe(
      "m1",
    );
  });

  it("does not affect official prefs", () => {
    const next = resolveComposerPrefsSelection({
      prefs: { modelId: "grok-4.5", effort: "low", providerId: null },
      catalog: GROK_BUILD_MODELS,
      providers: [corrupt],
    });

    expect(next).toEqual({ modelId: "grok-4.5", effort: "low" });
  });
});
