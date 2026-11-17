import { describe, expect, it } from "vitest";
import type { CustomProvider } from "@/lib/api";
import { GROK_BUILD_MODELS, type ModelOption } from "./grokCatalog";
import {
  pickSessionEffort,
  resolvePickedModelEfforts,
  resolveSessionEffortOptions,
  saveSessionEffort,
} from "./sessionEffort";

function provider(
  patch: Partial<CustomProvider> & Pick<CustomProvider, "id">,
): CustomProvider {
  return {
    model: patch.model ?? "m-default",
    baseUrl: patch.baseUrl ?? "https://relay.example/v1",
    name: patch.name ?? patch.id,
    hasApiKey: true,
    apiBackend: "responses",
    providerMode: "generic",
    isDefault: false,
    ...patch,
  };
}

const relay = provider({
  id: "relay",
  model: "m-default",
  efforts: [
    { id: "channel-low", name: "Channel low" },
    { id: "channel-high", name: "Channel high", isDefault: true },
  ],
  models: [
    {
      id: "m-default",
      name: "Default",
      supportsReasoningEffort: true,
      efforts: [
        { id: "low", name: "Low" },
        { id: "medium", name: "Medium" },
        { id: "high", name: "High", isDefault: true },
      ],
    },
    {
      id: "m-raw",
      name: "Raw",
      supportsReasoningEffort: true,
      efforts: [
        { id: "minimal", name: "Minimal" },
        { id: "balanced", name: "Balanced" },
        { id: "ultra", name: "Ultra" },
      ],
    },
    {
      id: "m-off",
      name: "Off capable",
      supportsReasoningEffort: true,
      efforts: [
        { id: "low", name: "Low", isDefault: true },
        { id: "none", name: "none" },
      ],
    },
    {
      id: "m-nothink",
      name: "No reasoning",
      supportsReasoningEffort: false,
      efforts: [{ id: "low", name: "Low" }],
      effortsSource: "fallback",
    },
  ],
});

describe("resolveSessionEffortOptions", () => {
  it("reads the exact session model ladder, never the channel active model", () => {
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-raw",
    });

    expect(resolution.supported).toBe(true);
    expect(resolution.pending).toBe(false);
    expect(resolution.options.map((option) => option.id)).toEqual([
      "minimal",
      "balanced",
      "ultra",
    ]);
  });

  it("keeps each configured model's own ladder and order", () => {
    const defaultModel = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-default",
    });
    const raw = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-raw",
    });

    expect(defaultModel.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(raw.options.map((option) => option.id)).toEqual([
      "minimal",
      "balanced",
      "ultra",
    ]);
    expect(defaultModel.options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "channel-high" })]),
    );
  });

  it("uses the model flag rather than the first catalog row", () => {
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-nothink",
    });

    expect(resolution.supported).toBe(false);
    expect(resolution.options).toEqual([]);
  });

  it("hides every option when the model rejects reasoning effort", () => {
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-nothink",
    });

    expect(resolution.options.map((option) => option.id)).not.toContain("low");
  });

  it("does not borrow the channel ladder for a model without its own ladder", () => {
    const multiModelProvider = provider({
      ...relay,
      models: [
        ...(relay.models ?? []),
        {
          id: "m-empty",
          name: "No model ladder",
          supportsReasoningEffort: true,
          efforts: [],
        },
      ],
    });
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: multiModelProvider,
      modelId: "m-empty",
    });

    expect(resolution.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("uses the generic fallback for an id absent from a multi-model catalog", () => {
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "removed-model",
    });

    expect(resolution.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("uses channel efforts only for the matching legacy single-model route", () => {
    const legacy = provider({
      id: "legacy",
      model: "m-default",
      efforts: [
        { id: "channel-low", name: "Channel low" },
        { id: "channel-high", name: "Channel high", isDefault: true },
      ],
    });

    const matching = resolveSessionEffortOptions({
      source: "custom",
      provider: legacy,
      modelId: "m-default",
    });
    const mismatched = resolveSessionEffortOptions({
      source: "custom",
      provider: legacy,
      modelId: "other-model",
    });

    expect(matching.options.map((option) => option.id)).toEqual([
      "channel-low",
      "channel-high",
    ]);
    expect(mismatched.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("does not use channel efforts when the only catalog row is another model", () => {
    const providerWithMismatchedRow = provider({
      id: "legacy-with-row",
      model: "m-default",
      models: [{ id: "other-model", name: "Other" }],
      efforts: [{ id: "channel-only", name: "Channel only" }],
    });
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: providerWithMismatchedRow,
      modelId: "m-default",
    });

    expect(resolution.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("uses the documented fallback ladder when the provider advertises none", () => {
    const noLadder = provider({
      id: "empty-relay",
      model: "m1",
      models: [
        {
          id: "m1",
          name: "Unspecified",
          supportsReasoningEffort: true,
          efforts: [],
        },
      ],
    });
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: noLadder,
      modelId: "m1",
    });

    expect(resolution.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(resolution.options.find((option) => option.isDefault)?.id).toBe(
      "medium",
    );
    expect(pickSessionEffort(resolution.options, "vendor-tier")).toBe(
      "medium",
    );
  });

  it("holds the stored pick while the provider list is still loading", () => {
    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: null,
      modelId: "m-raw",
    });

    expect(resolution.pending).toBe(true);
    expect(resolution.options).toEqual([]);
  });

  it("offers Off from an explicit model setting and honors an explicit disable", () => {
    const withOff = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-off",
    });
    const withoutOff = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-default",
    });
    const enabledBySetting = resolveSessionEffortOptions({
      source: "custom",
      provider: provider({
        ...relay,
        model: "m-fast",
        models: [
          {
            id: "m-fast",
            name: "Fast",
            supportsReasoningEffort: false,
            supportsReasoningOff: true,
            efforts: [{ id: "high", name: "High", isDefault: true }],
            effortsSource: "fallback",
          },
        ],
      }),
      modelId: "m-fast",
    });
    const explicitlyDisabled = resolveSessionEffortOptions({
      source: "custom",
      provider: provider({
        ...relay,
        model: "m-disabled",
        models: [
          {
            id: "m-disabled",
            name: "Disabled",
            supportsReasoningOff: false,
            efforts: [
              { id: "high", name: "High", isDefault: true },
              { id: "none", name: "Off" },
            ],
            effortsSource: "remote",
          },
        ],
      }),
      modelId: "m-disabled",
    });

    expect(withOff.options.map((option) => option.id)).toContain("none");
    expect(withoutOff.options.map((option) => option.id)).not.toContain("none");
    expect(enabledBySetting.options.map((option) => option.id)).toEqual([
      "none",
      "high",
    ]);
    expect(enabledBySetting.supported).toBe(true);
    expect(explicitlyDisabled.options.map((option) => option.id)).toEqual([
      "high",
    ]);
  });

  it("offers official model ladders by raw id, including xhigh", () => {
    const resolution = resolveSessionEffortOptions({
      source: "official",
      modelId: "grok-4.7",
      officialModels: GROK_BUILD_MODELS,
    });

    expect(resolution.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("uses the official model identity when its live catalog is temporarily empty", () => {
    const resolution = resolveSessionEffortOptions({
      source: "official",
      modelId: "grok-4.7",
      officialModels: [],
    });

    expect(resolution.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(pickSessionEffort(resolution.options, "xhigh")).toBe("xhigh");
  });

  it("offers off on an official model only when its live catalog lists none", () => {
    const models: ModelOption[] = [
      {
        id: "grok-live",
        label: "Grok Live",
        reasoningEfforts: [
          { id: "low" },
          { id: "medium", isDefault: true },
          { id: "none", label: "Off" },
        ],
      },
    ];
    const resolution = resolveSessionEffortOptions({
      source: "official",
      modelId: "grok-live",
      officialModels: models,
    });

    expect(resolution.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "none",
    ]);
  });

  it("keeps the same raw id across models when both advertise it", () => {
    const nextModel = provider({
      ...relay,
      models: [
        ...(relay.models ?? []),
        {
          id: "m-high",
          name: "High only",
          supportsReasoningEffort: true,
          efforts: [
            { id: "low", name: "Low" },
            { id: "high", name: "High", isDefault: true },
          ],
        },
      ],
    });

    const options = resolveSessionEffortOptions({
      source: "custom",
      provider: nextModel,
      modelId: "m-high",
    }).options;

    expect(pickSessionEffort(options, "high")).toBe("high");
  });

  it("falls to the new model default when its ladder lacks the old id", () => {
    const rawOptions = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-raw",
    }).options;

    expect(pickSessionEffort(rawOptions, "high")).toBe("minimal");
  });

  it("never applies preset rewrites to raw model ids", () => {
    const amux = provider({
      id: "amux",
      baseUrl: "https://api.amux.ai/v1",
      models: [
        {
          id: "raw-grok",
          name: "Raw Grok",
          supportsReasoningEffort: true,
          efforts: [{ id: "max", name: "Max" }],
        },
      ],
    });

    const resolution = resolveSessionEffortOptions({
      source: "custom",
      provider: amux,
      modelId: "raw-grok",
    });

    expect(resolution.options.map((option) => option.id)).toEqual(["max"]);
    expect(pickSessionEffort(resolution.options, "max")).toBe("max");
  });

  it("reflects provider model metadata changes", () => {
    const before = resolveSessionEffortOptions({
      source: "custom",
      provider: relay,
      modelId: "m-default",
    });
    const updated = provider({
      ...relay,
      models: relay.models?.map((model) =>
        model.id === "m-default"
          ? {
              ...model,
              efforts: [{ id: "medium", name: "Medium", isDefault: true }],
            }
          : model,
      ),
    });
    const after = resolveSessionEffortOptions({
      source: "custom",
      provider: updated,
      modelId: "m-default",
    });

    expect(before.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(after.options.map((option) => option.id)).toEqual(["medium"]);
  });
});

describe("pickSessionEffort", () => {
  const options = [
    { id: "minimal", label: "Minimal" },
    { id: "balanced", label: "Balanced" },
    { id: "ultra", label: "Ultra" },
  ];

  it("keeps an exact raw id", () => {
    expect(pickSessionEffort(options, "balanced")).toBe("balanced");
  });

  it("keeps a stored Off id when the model advertises it", () => {
    expect(
      pickSessionEffort(
        [{ id: "none" }, { id: "low" }, { id: "high" }],
        "none",
      ),
    ).toBe("none");
  });

  it("falls back to the first option when none is marked default", () => {
    expect(pickSessionEffort(options, "missing")).toBe("minimal");
    expect(pickSessionEffort(options, null)).toBe("minimal");
  });

  it("falls back to the first option when the ladder has no explicit default", () => {
    expect(
      pickSessionEffort(
        [{ id: "low" }, { id: "medium" }, { id: "high" }],
        "missing",
      ),
    ).toBe("low");
  });

  it("uses the advertised default flag first", () => {
    expect(
      pickSessionEffort(
        [{ id: "low" }, { id: "medium" }, { id: "high", isDefault: true }],
        "",
      ),
    ).toBe("high");
  });

  it("keeps a stored raw id when the model exposes no options", () => {
    expect(pickSessionEffort([], "keep-me")).toBe("keep-me");
  });

  it("never invents the static fallback for an empty option set", () => {
    expect(pickSessionEffort([], "")).toBe("");
    expect(pickSessionEffort([], null)).toBe("");
  });
});

describe("saveSessionEffort", () => {
  it("applies the raw id only after the save resolves", async () => {
    const applied: string[] = [];
    let resolveSave!: () => void;
    const pending = saveSessionEffort({
      effort: "ultra",
      save: () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      apply: (id) => applied.push(id),
    });

    expect(applied).toEqual([]);
    resolveSave();
    await expect(pending).resolves.toEqual({ ok: true, effort: "ultra" });
    expect(applied).toEqual(["ultra"]);
  });

  it("leaves the visible pick unchanged when the save rejects", async () => {
    let visible = "balanced";
    const result = await saveSessionEffort({
      effort: "ultra",
      save: async () => {
        throw new Error("save failed");
      },
      apply: (id) => {
        visible = id;
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
    expect(visible).toBe("balanced");
  });
});

describe("resolvePickedModelEfforts", () => {
  it("resolves a custom pick against that provider's exact model", () => {
    const resolution = resolvePickedModelEfforts({
      pick: { kind: "custom", providerId: "relay", modelId: "m-raw" },
      providers: [relay],
      officialModels: GROK_BUILD_MODELS,
    });

    expect(resolution?.options.map((option) => option.id)).toEqual([
      "minimal",
      "balanced",
      "ultra",
    ]);
  });

  it("returns null for an unknown provider or invalid official model", () => {
    expect(
      resolvePickedModelEfforts({
        pick: { kind: "custom", providerId: "missing", modelId: "m-raw" },
        providers: [relay],
        officialModels: GROK_BUILD_MODELS,
      }),
    ).toBeNull();
    expect(
      resolvePickedModelEfforts({
        pick: { kind: "official", modelId: "not-a-model" },
        providers: [relay],
        officialModels: GROK_BUILD_MODELS,
      }),
    ).toBeNull();
  });
});
