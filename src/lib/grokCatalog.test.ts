import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  DEFAULT_EFFORT,
  DEFAULT_MODEL_ID,
  GROK_BUILD_EFFORTS,
  GROK_BUILD_MODELS,
  effortDisplayLabel,
  effortOptionsFromProvider,
  effortsForModel,
  isSpawnableReasoningEffort,
  isValidEffort,
  normalizeEffortDefaults,
  pickDefaultEffort,
  resolveContextWindow,
  type EffortOption,
  type ModelOption,
} from "./grokCatalog";

const modelWithEfforts: ModelOption = {
  id: "grok-4.5",
  label: "Grok 4.5",
  reasoningEfforts: [
    {
      id: "high",
      value: "high",
      label: "High Effort",
      description: "Deep",
      isDefault: true,
    },
    {
      id: "medium",
      value: "medium",
      label: "Medium Effort",
      isDefault: false,
    },
    {
      id: "low",
      value: "low",
      label: "Low Effort",
      isDefault: false,
    },
  ],
};

const modelCustomOnly: ModelOption = {
  id: "custom-model",
  label: "Custom",
  reasoningEfforts: [
    { id: "max", value: "max", label: "Max", isDefault: true },
    { id: "min", value: "min", label: "Min" },
  ],
};

describe("effortsForModel", () => {
  it("returns static fallback when model has no efforts", () => {
    expect(effortsForModel({ id: "x", label: "X" })).toEqual(
      GROK_BUILD_EFFORTS,
    );
    expect(effortsForModel(null)).toEqual(GROK_BUILD_EFFORTS);
    expect(effortsForModel(undefined)).toEqual(GROK_BUILD_EFFORTS);
  });

  it("returns model efforts when non-empty", () => {
    const list = effortsForModel(modelWithEfforts);
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe("high");
    expect(list[0].label).toBe("High Effort");
  });

  it("falls back to 4-tier xhigh for grok-4.6 without live efforts", () => {
    const list = effortsForModel({ id: "grok-4.6", label: "Grok 4.6" });
    expect(list.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(list.find((e) => e.isDefault)?.id).toBe("xhigh");
  });

  it("falls back to 4-tier xhigh for grok-4.7 and Fast", () => {
    for (const id of ["grok-4.7", "grok-4.7-build-fast"]) {
      const list = effortsForModel({ id, label: id });
      expect(list.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh"]);
      expect(list.find((e) => e.isDefault)?.id).toBe("xhigh");
    }
  });

  it("filters catalog effort ids that Host cannot pass to the CLI", () => {
    const catalog = [
      { id: "low" },
      { id: "two words" },
      { id: "--unsafe" },
      { id: "xhigh" },
    ];

    expect(effortsForModel(null, catalog).map((option) => option.id)).toEqual([
      "low",
      "xhigh",
    ]);
    expect(effortOptionsFromProvider(catalog)?.map((option) => option.id)).toEqual([
      "low",
      "xhigh",
    ]);
  });

  it("prefers explicit catalogEfforts arg over model", () => {
    const override = [{ id: "only" }];
    expect(effortsForModel(modelWithEfforts, override)).toEqual(override);
  });
});

describe("isValidEffort", () => {
  it("accepts static low/medium/high without model", () => {
    expect(isValidEffort("low")).toBe(true);
    expect(isValidEffort("medium")).toBe(true);
    expect(isValidEffort("high")).toBe(true);
    expect(isValidEffort("max")).toBe(false);
    expect(isValidEffort("")).toBe(false);
  });

  it("accepts efforts for the selected model when known", () => {
    expect(isValidEffort("high", modelWithEfforts)).toBe(true);
    expect(isValidEffort("max", modelCustomOnly)).toBe(true);
    expect(isValidEffort("min", modelCustomOnly)).toBe(true);
    expect(isValidEffort("medium", modelCustomOnly)).toBe(false);
  });

  it("accepts an efforts array directly", () => {
    expect(isValidEffort("max", modelCustomOnly.reasoningEfforts)).toBe(true);
    expect(isValidEffort("high", modelCustomOnly.reasoningEfforts)).toBe(
      false,
    );
  });
});

describe("pickDefaultEffort", () => {
  it("uses model default flag when present", () => {
    expect(pickDefaultEffort(modelWithEfforts)).toBe("high");
    expect(pickDefaultEffort(modelCustomOnly)).toBe("max");
  });

  it("falls back to high static default (Grok Build 1.0)", () => {
    expect(DEFAULT_EFFORT).toBe("high");
    expect(GROK_BUILD_EFFORTS.find((e) => e.isDefault)?.id).toBe("high");
    expect(pickDefaultEffort(null)).toBe(DEFAULT_EFFORT);
    expect(pickDefaultEffort({ id: "x", label: "X" })).toBe("high");
  });

  it("falls back to the first option when the ladder has no default flag", () => {
    const noDefault: EffortOption[] = [
      { id: "low" },
      { id: "medium" },
      { id: "high" },
    ];
    expect(pickDefaultEffort(null, noDefault)).toBe("low");
  });

  it("never picks Off as the implicit default (prepended or advertised first)", () => {
    // resolveProviderEfforts 会把 Off 前置到滑块最左;默认档必须跳过它。
    const offPrepended: EffortOption[] = [
      { id: "none" },
      { id: "low" },
      { id: "high" },
    ];
    expect(pickDefaultEffort(null, offPrepended)).toBe("low");
    // 目录自己把 none 排最前且无 default 标记:同样跳过。
    expect(pickDefaultEffort(null, [{ id: "none" }, { id: "deep" }])).toBe(
      "deep",
    );
    // 整个梯子只有 Off 时才退回 none。
    expect(pickDefaultEffort(null, [{ id: "none" }])).toBe("none");
  });

  it("defaults to medium when there is no effort information at all", () => {
    // 全部 id 不可 spawn 时 effortsForModel 得到空表,视为完全没有档位信息。
    expect(pickDefaultEffort(null, [{ id: " " }])).toBe("medium");
  });

  it("prefers xhigh when CLI cache marks both xhigh and high as default", () => {
    const dual: EffortOption[] = [
      { id: "xhigh", isDefault: true },
      { id: "high", isDefault: true },
      { id: "medium" },
      { id: "low" },
    ];
    expect(normalizeEffortDefaults(dual).filter((e) => e.isDefault).map((e) => e.id)).toEqual([
      "xhigh",
    ]);
    expect(pickDefaultEffort(null, dual)).toBe("xhigh");
  });
});

describe("official catalog fallback", () => {
  it("defaults to grok-4.7 and keeps Fast, 4.6, and 4.5 selectable", () => {
    expect(DEFAULT_MODEL_ID).toBe("grok-4.7");
    expect(GROK_BUILD_MODELS.map((m) => m.id)).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-4.5",
    ]);
    expect(GROK_BUILD_MODELS.find((m) => m.isDefault)?.id).toBe("grok-4.7");
    expect(
      GROK_BUILD_MODELS.find((m) => m.id === "grok-4.7-build-fast")?.label,
    ).toBe("Grok 4.7 Fast");
  });
});

describe("isSpawnableReasoningEffort", () => {
  it("accepts catalog and custom tier ids", () => {
    expect(isSpawnableReasoningEffort("low")).toBe(true);
    expect(isSpawnableReasoningEffort("high")).toBe(true);
    expect(isSpawnableReasoningEffort("max")).toBe(true);
    expect(isSpawnableReasoningEffort("xhigh")).toBe(true);
  });

  it("rejects empty or invalid tokens", () => {
    expect(isSpawnableReasoningEffort("")).toBe(false);
    expect(isSpawnableReasoningEffort("  ")).toBe(false);
    expect(isSpawnableReasoningEffort("-max")).toBe(false);
  });
});

describe("effortDisplayLabel", () => {
  it("prefers i18n for known ids over English catalog labels", () => {
    expect(
      effortDisplayLabel(
        { id: "high", label: "High Effort" },
        { high: "高" },
      ),
    ).toBe("高");
    expect(
      effortDisplayLabel(
        { id: "medium", label: "Medium Effort" },
        { medium: "中" },
      ),
    ).toBe("中");
    expect(
      effortDisplayLabel(
        { id: "low", label: "Low Effort" },
        { high: "High", medium: "Medium", low: "Low" },
      ),
    ).toBe("Low");
  });

  it("uses i18n for known ids without catalog label", () => {
    expect(
      effortDisplayLabel("high", {
        high: "High",
        medium: "Medium",
        low: "Low",
      }),
    ).toBe("High");
    expect(effortDisplayLabel({ id: "medium" }, { medium: "中" })).toBe(
      "中",
    );
  });

  it("localizes DeepSeek-style xhigh/max over stored English names", () => {
    expect(
      effortDisplayLabel(
        { id: "xhigh", label: "xhigh" },
        { xhigh: "极高", max: "极高" },
      ),
    ).toBe("极高");
    expect(
      effortDisplayLabel(
        { id: "max", label: "Max" },
        { xhigh: "极高" },
      ),
    ).toBe("极高");
  });

  it("strips shared Effort suffix on non-standard catalog labels", () => {
    expect(
      effortDisplayLabel({ id: "custom-tier", label: "Max Effort" }),
    ).toBe("Max");
  });

  it("falls back to raw id", () => {
    expect(effortDisplayLabel("custom-tier")).toBe("custom-tier");
  });
});

describe("resolveContextWindow", () => {
  it("returns custom provider contextWindow when set", () => {
    expect(
      resolveContextWindow({
        activeCustomProvider: { contextWindow: 128000 },
        modelId: "any",
      }),
    ).toBe(128000);
  });

  it("falls back to DEFAULT_CUSTOM_CONTEXT_WINDOW for custom provider without window", () => {
    expect(
      resolveContextWindow({
        activeCustomProvider: { contextWindow: null },
        modelId: "any",
      }),
    ).toBe(DEFAULT_CUSTOM_CONTEXT_WINDOW);
    expect(
      resolveContextWindow({
        activeCustomProvider: {},
        modelId: "any",
      }),
    ).toBe(DEFAULT_CUSTOM_CONTEXT_WINDOW);
  });

  it("returns official model contextWindow from catalog", () => {
    const models: ModelOption[] = [
      { id: "grok-4", label: "Grok 4", contextWindow: 256000 },
    ];
    expect(
      resolveContextWindow({ activeCustomProvider: null, modelId: "grok-4", models }),
    ).toBe(256000);
  });

  it("starts a new official chat at 500k when that size is advertised", () => {
    const models: ModelOption[] = [
      {
        id: "grok-4.7",
        label: "Grok 4.7",
        contextWindow: 256000,
        contextWindows: [256000, 500000],
      },
    ];
    expect(
      resolveContextWindow({
        activeCustomProvider: null,
        modelId: "grok-4.7",
        models,
      }),
    ).toBe(500000);
  });

  it("uses a user-selected official window over the 500k app default", () => {
    const models: ModelOption[] = [
      {
        id: "grok-4.7",
        label: "Grok 4.7",
        contextWindow: 256000,
        contextWindows: [256000, 500000],
        contextWindowSource: "user",
      },
    ];
    expect(
      resolveContextWindow({
        activeCustomProvider: null,
        modelId: "grok-4.7",
        models,
      }),
    ).toBe(256000);
  });

  it("keeps an agent-reported 256k over the 500k app default", () => {
    const models: ModelOption[] = [
      {
        id: "grok-4.7",
        label: "Grok 4.7",
        contextWindow: 256000,
        contextWindows: [256000, 500000],
      },
    ];
    expect(
      resolveContextWindow({
        activeCustomProvider: null,
        modelId: "grok-4.7",
        models,
        agentContextWindow: 256000,
      }),
    ).toBe(256000);
  });

  it("returns live official 500k from catalog (Grok Build 1.0)", () => {
    const models: ModelOption[] = [
      { id: "grok-4.5", label: "Grok 4.5", contextWindow: 500_000 },
    ];
    expect(
      resolveContextWindow({
        activeCustomProvider: null,
        modelId: "grok-4.5",
        models,
      }),
    ).toBe(500_000);
  });

  it("prefers agent-reported window over catalog (occupancy honesty)", () => {
    const models: ModelOption[] = [
      { id: "grok-4.5", label: "Grok 4.5", contextWindow: 128_000 },
    ];
    expect(
      resolveContextWindow({
        activeCustomProvider: null,
        modelId: "grok-4.5",
        models,
        agentContextWindow: 500_000,
      }),
    ).toBe(500_000);
  });

  it("agent window wins even on custom route (CLI denominator)", () => {
    expect(
      resolveContextWindow({
        activeCustomProvider: { contextWindow: 200_000 },
        modelId: "custom-model",
        agentContextWindow: 500_000,
      }),
    ).toBe(500_000);
  });

  it("never uses custom 200k default for official when catalog/agent unknown", () => {
    const models: ModelOption[] = [
      { id: "grok-4.5", label: "Grok 4.5" },
    ];
    expect(
      resolveContextWindow({
        activeCustomProvider: null,
        modelId: "grok-4.5",
        models,
      }),
    ).toBeNull();
    expect(DEFAULT_CUSTOM_CONTEXT_WINDOW).toBe(1_000_000);
  });

  it("returns null for official model without contextWindow", () => {
    const models: ModelOption[] = [
      { id: "grok-4", label: "Grok 4" },
    ];
    expect(
      resolveContextWindow({ activeCustomProvider: null, modelId: "grok-4", models }),
    ).toBeNull();
  });

  it("returns null for unknown model", () => {
    expect(
      resolveContextWindow({
        activeCustomProvider: null,
        modelId: "nonexistent",
        models: [],
      }),
    ).toBeNull();
  });
});
