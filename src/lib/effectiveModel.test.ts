import { describe, expect, it } from "vitest";
import {
  composerModelChipLabel,
  effectiveComposerModel,
  resolveCustomRouteDisplay,
} from "./effectiveModel";

describe("effectiveComposerModel", () => {
  it("keeps the official catalog selection on the official route", () => {
    expect(effectiveComposerModel("grok-4.5", null)).toBe("grok-4.5");
    expect(effectiveComposerModel("grok-3", undefined)).toBe("grok-3");
  });

  it("prefers the active custom provider request model", () => {
    expect(effectiveComposerModel("grok-4.5", "deepseek-v4-flash")).toBe(
      "deepseek-v4-flash",
    );
  });

  it("falls back to the composer selection when provider model is blank", () => {
    expect(effectiveComposerModel("grok-4.5", "")).toBe("grok-4.5");
    expect(effectiveComposerModel("grok-4.5", "   ")).toBe("grok-4.5");
  });

  it("keeps the composer selection when no provider is active", () => {
    expect(effectiveComposerModel("grok-4.5", "")).toBe("grok-4.5");
  });
});

describe("resolveCustomRouteDisplay", () => {
  const provider = {
    name: "云驿",
    model: "deepseek-chat",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    ],
  };

  it("shows the catalog row a generic chat stored", () => {
    const shown = resolveCustomRouteDisplay(provider, "deepseek-v4-flash");
    expect(shown?.chip).toEqual({
      name: "DeepSeek V4 Flash",
      model: "deepseek-v4-flash",
    });
    expect(shown?.requestModel).toBe("deepseek-v4-flash");
  });

  it("shows the catalog id a Grok Build-compatible relay picked", () => {
    const shown = resolveCustomRouteDisplay(
      { ...provider, providerMode: "grok_build_proxy" },
      "deepseek-v4-flash",
    );
    expect(shown?.chip).toEqual({
      name: "DeepSeek V4 Flash",
      model: "deepseek-v4-flash",
    });
    expect(shown?.requestModel).toBe("deepseek-v4-flash");
  });

  it("ignores an official catalog id on a custom route", () => {
    const shown = resolveCustomRouteDisplay(provider, "grok-4.7");
    expect(shown?.chip.name).toBe("DeepSeek Chat");
    expect(shown?.requestModel).toBe("deepseek-chat");
  });
});

describe("resolveCustomRouteDisplay with an explicitly cleared catalog", () => {
  const cleared = {
    name: "Cleared",
    model: "deepseek-chat",
    models: [] as Array<{ id: string; name?: string | null }>,
  };

  it("shows the model a saved session still routes on", () => {
    // Act
    const shown = resolveCustomRouteDisplay(cleared, "deepseek-reasoner");

    // Assert — the stored id, not the cleared channel `model`
    expect(shown?.chip).toEqual({
      name: "deepseek-reasoner",
      model: "deepseek-reasoner",
    });
    expect(shown?.requestModel).toBe("deepseek-reasoner");
  });

  it("shows nothing when the session stores no model", () => {
    expect(resolveCustomRouteDisplay(cleared, "")).toBeNull();
    expect(resolveCustomRouteDisplay(cleared, "   ")).toBeNull();
  });

  it("keeps the channel model for a legacy provider with no catalog", () => {
    // Arrange — a missing catalog is the legacy read, not a clear
    const legacy = { name: "Legacy", model: "llama3" };
    const nullCatalog = { name: "Legacy", model: "llama3", models: null };

    // Act / Assert
    expect(resolveCustomRouteDisplay(legacy, "")?.chip).toEqual({
      name: "llama3",
      model: "llama3",
    });
    expect(resolveCustomRouteDisplay(legacy, "")?.requestModel).toBe("llama3");
    expect(resolveCustomRouteDisplay(nullCatalog, "")?.requestModel).toBe(
      "llama3",
    );
  });
});

describe("resolveCustomRouteDisplay with a corrupt catalog", () => {
  const corrupt = {
    name: "Corrupt",
    model: "m1",
    modelCatalogCorrupt: true,
    models: [{ id: "m1", name: "M1" }],
  };

  it("shows the saved session id the recovered rows omit", () => {
    // Act — the host kept the session's own child section
    const shown = resolveCustomRouteDisplay(corrupt, "m2");

    // Assert — the saved id, not the recovered channel row
    expect(shown?.chip).toEqual({ name: "m2", model: "m2" });
    expect(shown?.requestModel).toBe("m2");
  });

  it("labels a row the recovered rows still list", () => {
    const shown = resolveCustomRouteDisplay(corrupt, "m1");

    expect(shown?.chip).toEqual({ name: "M1", model: "m1" });
    expect(shown?.requestModel).toBe("m1");
  });

  it("keeps the existing fallback for an unknown id on a readable catalog", () => {
    // Arrange — the flag is what gates the saved id, not the missing row
    const readable = { ...corrupt, modelCatalogCorrupt: false };

    // Act / Assert
    expect(resolveCustomRouteDisplay(readable, "m2")?.chip).toEqual({
      name: "M1",
      model: "m1",
    });
    expect(resolveCustomRouteDisplay(readable, "m2")?.requestModel).toBe("m1");
  });

  it("does not fabricate a session model when none is stored", () => {
    const shown = resolveCustomRouteDisplay(corrupt, "");

    // The recovered row is the actual channel fallback, not a saved pick
    expect(shown?.chip).toEqual({ name: "M1", model: "m1" });
    expect(shown?.requestModel).toBe("m1");
  });
});

describe("composerModelChipLabel", () => {
  it("uses official label when no custom route", () => {
    expect(
      composerModelChipLabel({
        modelId: "grok-4.5",
        officialLabel: "Grok 4.5",
        activeCustom: null,
      }),
    ).toBe("Grok 4.5");
  });

  it("uses custom name when set", () => {
    expect(
      composerModelChipLabel({
        modelId: "grok-4.5",
        officialLabel: "Grok 4.5",
        activeCustom: { name: "云驿 DeepSeek", model: "deepseek-chat" },
      }),
    ).toBe("云驿 DeepSeek");
  });

  it("falls back to custom model when name empty", () => {
    expect(
      composerModelChipLabel({
        modelId: "grok-4.5",
        officialLabel: "Grok 4.5",
        activeCustom: { name: "  ", model: "deepseek-chat" },
      }),
    ).toBe("deepseek-chat");
  });
});
