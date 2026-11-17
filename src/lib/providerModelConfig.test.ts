import { describe, expect, it } from "vitest";
import type { CustomProvider, ProviderModelEntry } from "@/lib/api";
import {
  DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW,
  defaultProviderModelEfforts,
  effectiveModelContextWindow,
  effectiveModelEfforts,
  effectiveModelSupportsReasoningEffort,
  effectiveModelSupportsReasoningOff,
  findProviderModel,
  materializeActiveModelChannel,
  mergeRemoteModelMetadata,
  modelsForContextWindow,
  normalizeModelEfforts,
  resolveProviderContextWindow,
  resolveProviderEfforts,
  resolveProviderSupportsVideo,
  resolveProviderSupportsVision,
  withModelContextWindow,
  withResolvedModelMetadata,
} from "./providerModelConfig";

const channelEfforts = [
  { id: "low", name: "low" },
  { id: "medium", name: "medium", isDefault: true },
  { id: "high", name: "high" },
];

const modelEfforts = [
  { id: "low", name: "low" },
  { id: "high", name: "high", isDefault: true },
  { id: "max", name: "max" },
];

function provider(
  partial: Partial<CustomProvider> & Pick<CustomProvider, "model">,
): CustomProvider {
  return {
    id: "relay",
    baseUrl: "https://example.com/v1",
    name: "Relay",
    hasApiKey: true,
    apiBackend: "chat_completions",
    providerMode: "generic",
    isDefault: true,
    models: [],
    efforts: channelEfforts,
    contextWindow: 200_000,
    supportsVision: false,
    ...partial,
  };
}

describe("findProviderModel", () => {
  it("picks the active request id, else first catalog row", () => {
    const models: ProviderModelEntry[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    expect(findProviderModel({ models, model: "b" })?.id).toBe("b");
    expect(findProviderModel({ models, model: "missing" })?.id).toBe("a");
    expect(findProviderModel({ models: [], model: "a" })).toBeNull();
  });
});

describe("resolveProviderEfforts", () => {
  it("uses per-model efforts when the active row has them", () => {
    const p = provider({
      model: "thinker",
      models: [
        { id: "plain", name: "Plain" },
        { id: "thinker", name: "Thinker", efforts: modelEfforts },
      ],
    });
    expect(resolveProviderEfforts(p)?.map((e) => e.id)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(resolveProviderEfforts(p, "plain")?.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("uses the matching channel ladder for a legacy single-model provider", () => {
    const p = provider({
      model: "plain",
      models: [{ id: "plain", name: "Plain" }],
    });
    expect(resolveProviderEfforts(p, "plain").map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("uses generic fallback instead of another model's channel ladder", () => {
    const p = provider({
      model: "m1",
      efforts: [{ id: "channel-only", name: "Channel only" }],
      models: [
        { id: "m1", name: "M1" },
        { id: "m2", name: "M2" },
      ],
    });
    expect(resolveProviderEfforts(p, "m2").map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("mirrors Host precedence: row with Off enabled and no ladder uses generic fallback, not channel", () => {
    // Host `custom_model_effort_ladder` 在 supports_reasoning_off=true 且行内
    // 无档位时短路到通用 fallback;前端必须同一优先级,否则旧式 channel
    // 梯子的 id 前端可存、Host 解析不到。
    const p = provider({
      model: "m1",
      efforts: [{ id: "channel-only", name: "Channel only" }],
      models: [{ id: "m1", name: "M1", supportsReasoningOff: true }],
    });
    expect(resolveProviderEfforts(p, "m1").map((effort) => effort.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("does not use legacy channel efforts for a different requested model", () => {
    const legacy = provider({
      model: "m1",
      models: undefined,
      efforts: [{ id: "channel-only", name: "Channel only" }],
    });
    expect(resolveProviderEfforts(legacy, "m1").map((effort) => effort.id)).toEqual([
      "channel-only",
    ]);
    expect(resolveProviderEfforts(legacy, "m2").map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("uses generic fallback when a legacy row does not match the channel model", () => {
    const providerWithMismatchedRow = provider({
      model: "m1",
      models: [{ id: "m2", name: "M2" }],
      efforts: [{ id: "channel-only", name: "Channel only" }],
    });
    expect(
      resolveProviderEfforts(providerWithMismatchedRow, "m1").map(
        (effort) => effort.id,
      ),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("hides efforts for a model that rejects reasoning", () => {
    const p = provider({
      model: "no-think",
      efforts: [{ id: "channel-only", name: "Channel only" }],
      models: [
        {
          id: "no-think",
          name: "No thinking",
          supportsReasoningEffort: false,
          efforts: [],
        },
      ],
    });
    expect(resolveProviderEfforts(p, "no-think")).toEqual([]);
  });

  it("treats a configured model ladder as reasoning support over a stale opt-out", () => {
    const p = provider({
      model: "thinker",
      models: [
        {
          id: "thinker",
          name: "Thinker",
          efforts: [{ id: "balanced", name: "Balanced", isDefault: true }],
          effortsSource: "user",
          supportsReasoningEffort: false,
          supportsReasoningEffortSource: "remote",
        },
      ],
    });

    expect(resolveProviderEfforts(p, "thinker").map((effort) => effort.id)).toEqual([
      "balanced",
    ]);
    expect(
      effectiveModelSupportsReasoningEffort(p.models![0]!),
    ).toMatchObject({ value: true, source: "user" });
  });

  it("adds the raw none id when the model setting enables Off", () => {
    const p = provider({
      model: "thinker",
      models: [
        {
          id: "thinker",
          name: "Thinker",
          efforts: [],
          effortsSource: "fallback",
          supportsReasoningEffort: false,
          supportsReasoningEffortSource: "remote",
          supportsReasoningOff: true,
        },
        { id: "other", name: "Other" },
      ],
    });

    expect(resolveProviderEfforts(p, "thinker").map((effort) => effort.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("honors an explicit Off disable even if the ladder advertises none", () => {
    const p = provider({
      model: "thinker",
      models: [
        {
          id: "thinker",
          name: "Thinker",
          efforts: [{ id: "low" }, { id: "none" }],
          effortsSource: "remote",
          supportsReasoningOff: false,
        },
      ],
    });

    expect(resolveProviderEfforts(p, "thinker").map((effort) => effort.id)).toEqual([
      "low",
    ]);
    expect(effectiveModelSupportsReasoningOff(p.models![0]!)).toBe(false);
  });

  it("preserves a model's raw effort id for Grok-compatible providers", () => {
    const p = provider({
      id: "grok-relay",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.7",
      models: [
        {
          id: "grok-4.7",
          name: "Grok 4.7",
          efforts: [{ id: "max", name: "Max", isDefault: true }],
        },
      ],
    });
    expect(resolveProviderEfforts(p, "grok-4.7").map((effort) => effort.id)).toEqual([
      "max",
    ]);
  });
});

describe("resolveProviderContextWindow / vision", () => {
  it("prefers the active model's window and vision flags", () => {
    const p = provider({
      model: "vision",
      supportsVision: false,
      contextWindow: 200_000,
      models: [
        {
          id: "vision",
          name: "Vision",
          contextWindow: 1_048_576,
          supportsVision: true,
          supportsVideo: true,
        },
        { id: "text", name: "Text", supportsVision: false },
      ],
    });
    expect(resolveProviderContextWindow(p)).toBe(1_048_576);
    expect(resolveProviderSupportsVision(p)).toBe(true);
    expect(resolveProviderSupportsVideo(p)).toBe(true);
    expect(resolveProviderSupportsVision(p, "text")).toBe(false);
    expect(resolveProviderContextWindow(p, "text")).toBe(200_000);
  });

  it("keeps channel vision when the model does not set a flag", () => {
    const p = provider({
      model: "ox",
      supportsVision: true,
      models: [{ id: "ox", name: "Ox" }],
    });
    expect(resolveProviderSupportsVision(p)).toBe(true);
  });
});

describe("default per-model metadata", () => {
  it("uses a 1M context window and the approved four-level ladder", () => {
    const context = effectiveModelContextWindow({});
    expect(context).toEqual({
      value: DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW,
      source: "fallback",
    });
    expect(DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW).toBe(1_000_000);

    const efforts = effectiveModelEfforts({});
    expect(efforts.source).toBe("fallback");
    expect(efforts.value.map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(efforts.value.find((effort) => effort.isDefault)?.id).toBe("medium");
    expect(defaultProviderModelEfforts()).toEqual(efforts.value);
  });

  it("treats an existing value without a source marker as user-set", () => {
    expect(
      effectiveModelContextWindow({ contextWindow: 128_000 }),
    ).toEqual({ value: 128_000, source: "user" });
    expect(
      effectiveModelEfforts({ efforts: [{ id: "max", isDefault: true }] }),
    ).toMatchObject({
      source: "user",
      value: [{ id: "max", isDefault: true }],
    });
    expect(
      effectiveModelSupportsReasoningEffort({ supportsReasoningEffort: false }),
    ).toEqual({ value: false, source: "user" });
  });

  it("keeps an explicit marker when the value exists", () => {
    expect(
      effectiveModelContextWindow({
        contextWindow: 64_000,
        contextWindowSource: "remote",
      }),
    ).toEqual({ value: 64_000, source: "remote" });
    expect(
      effectiveModelContextWindow({
        contextWindow: 64_000,
        contextWindowSource: "fallback",
      }),
    ).toEqual({ value: 64_000, source: "fallback" });
    expect(
      effectiveModelSupportsReasoningEffort({
        supportsReasoningEffort: true,
        supportsReasoningEffortSource: "fallback",
      }),
    ).toEqual({ value: true, source: "fallback" });
  });

  it("falls back to the 1M default when the API value is missing or invalid", () => {
    for (const window of [null, 0, -5, Number.NaN]) {
      expect(effectiveModelContextWindow({ contextWindow: window })).toEqual({
        value: 1_000_000,
        source: "fallback",
      });
    }
  });

  it("treats a configured ladder as support even when old metadata says false", () => {
    const reasoning = effectiveModelSupportsReasoningEffort({
      efforts: [{ id: "balanced" }],
      effortsSource: "user",
      supportsReasoningEffort: false,
      supportsReasoningEffortSource: "remote",
    });

    expect(reasoning).toEqual({ value: true, source: "user" });
  });

  it("resolves Off from an advertised none id or the explicit setting", () => {
    expect(
      effectiveModelSupportsReasoningOff({ efforts: [{ id: "none" }] }),
    ).toBe(true);
    expect(
      effectiveModelSupportsReasoningOff({
        efforts: [{ id: "none" }],
        supportsReasoningOff: false,
      }),
    ).toBe(false);
    expect(effectiveModelSupportsReasoningOff({ supportsReasoningOff: true })).toBe(
      true,
    );
  });

  it("defaults reasoning support to true when the API says nothing", () => {
    expect(effectiveModelSupportsReasoningEffort({})).toEqual({
      value: true,
      source: "fallback",
    });
  });
});

describe("normalizeModelEfforts", () => {
  it("keeps API-marked defaults and original custom ids", () => {
    const efforts = normalizeModelEfforts([
      { id: "minimum", name: "Min" },
      { id: "maximum", name: "Max", isDefault: true },
    ]);
    expect(efforts.map((effort) => effort.id)).toEqual(["minimum", "maximum"]);
    expect(efforts.find((effort) => effort.isDefault)?.id).toBe("maximum");
  });

  it("picks medium when the API marks no default", () => {
    const efforts = normalizeModelEfforts([
      { id: "low" },
      { id: "medium" },
      { id: "high" },
    ]);
    expect(efforts.find((effort) => effort.isDefault)?.id).toBe("medium");
  });

  it("picks the first valid id when medium is absent", () => {
    const efforts = normalizeModelEfforts([
      { id: "minimum" },
      { id: "maximum" },
    ]);
    expect(efforts.find((effort) => effort.isDefault)?.id).toBe("minimum");
  });

  it("drops blank and duplicate ids and keeps only one default", () => {
    const efforts = normalizeModelEfforts([
      { id: " low ", name: " " },
      { id: "low", isDefault: true },
      { id: "  " },
      { id: "high", isDefault: true },
    ]);
    expect(efforts).toEqual([
      { id: "low", name: "low", isDefault: true },
      { id: "high", name: "high", isDefault: false },
    ]);
  });
});

describe("withResolvedModelMetadata", () => {
  it("materializes fallback values and markers without touching legacy caps", () => {
    expect(
      withResolvedModelMetadata({
        id: "m1",
        name: "M1",
        supportsVision: true,
        supportsVideo: false,
      }),
    ).toEqual({
      id: "m1",
      name: "M1",
      contextWindow: 1_000_000,
      contextWindowSource: "fallback",
      supportsVision: true,
      supportsVideo: false,
      efforts: defaultProviderModelEfforts(),
      effortsSource: "fallback",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "fallback",
    });
  });
});

describe("materializeActiveModelChannel", () => {
  it("copies the picked model's extras onto channel fields for Host", () => {
    const p = provider({
      model: "a",
      models: [
        { id: "a", name: "A" },
        {
          id: "b",
          name: "B",
          efforts: modelEfforts,
          contextWindow: 64_000,
          supportsVision: true,
        },
      ],
    });
    expect(materializeActiveModelChannel({ provider: p, modelId: "b" })).toEqual(
      {
        efforts: modelEfforts,
        contextWindow: 64_000,
        supportsVision: true,
      },
    );
  });
});

describe("mergeRemoteModelMetadata", () => {
  it("applies API context and reasoning metadata when the model has no override", () => {
    const model: ProviderModelEntry = { id: "ox", name: "Ox" };
    expect(
      mergeRemoteModelMetadata(model, {
        id: "ox",
        contextWindow: 1_048_576,
        reasoningEfforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High", isDefault: true },
        ],
        supportsReasoningEffort: true,
      }),
    ).toEqual({
      id: "ox",
      name: "Ox",
      contextWindow: 1_048_576,
      contextWindowSource: "remote",
      efforts: [
        { id: "low", name: "Low", isDefault: false },
        { id: "high", name: "High", isDefault: true },
      ],
      effortsSource: "remote",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "remote",
    });
  });

  it("uses the approved fallback when the live row omits metadata", () => {
    const model: ProviderModelEntry = { id: "ox", name: "Ox" };
    expect(mergeRemoteModelMetadata(model, { id: "ox" })).toEqual({
      id: "ox",
      name: "Ox",
      contextWindow: 1_000_000,
      contextWindowSource: "fallback",
      efforts: defaultProviderModelEfforts(),
      effortsSource: "fallback",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "fallback",
    });
  });

  it("preserves a user ladder and treats it as reasoning support on refresh", () => {
    const model: ProviderModelEntry = {
      id: "ox",
      name: "Ox",
      contextWindow: 64_000,
      contextWindowSource: "user",
      efforts: [{ id: "maximum", name: "Max", isDefault: true }],
      effortsSource: "user",
      supportsReasoningEffort: false,
      supportsReasoningEffortSource: "user",
    };
    expect(
      mergeRemoteModelMetadata(model, {
        id: "ox",
        contextWindow: 1_048_576,
        reasoningEfforts: [{ id: "low", isDefault: true }],
        supportsReasoningEffort: true,
      }),
    ).toEqual({ ...model, supportsReasoningEffort: true });
  });

  it("updates API-sourced values and drops a value the API no longer has", () => {
    const model: ProviderModelEntry = {
      id: "ox",
      name: "Ox",
      contextWindow: 128_000,
      contextWindowSource: "remote",
      efforts: [{ id: "high", name: "High", isDefault: true }],
      effortsSource: "remote",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "remote",
    };
    expect(
      mergeRemoteModelMetadata(model, {
        id: "ox",
        contextWindow: 1_048_576,
        reasoningEfforts: [{ id: "low", name: "Low" }],
        supportsReasoningEffort: false,
      }),
    ).toEqual({
      id: "ox",
      name: "Ox",
      contextWindow: 1_048_576,
      contextWindowSource: "remote",
      efforts: [{ id: "low", name: "Low", isDefault: true }],
      effortsSource: "remote",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "remote",
    });
    expect(mergeRemoteModelMetadata(model, { id: "ox" })).toMatchObject({
      contextWindow: 1_000_000,
      contextWindowSource: "fallback",
      efforts: defaultProviderModelEfforts(),
      effortsSource: "fallback",
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "fallback",
    });
  });

  it("keeps an API reasoning opt-out when no ladder is advertised", () => {
    const merged = mergeRemoteModelMetadata(
      { id: "plain", name: "Plain" },
      { id: "plain", supportsReasoningEffort: false },
    );

    expect(effectiveModelSupportsReasoningEffort(merged)).toEqual({
      value: false,
      source: "remote",
    });
  });

  it("keeps a preset/fallback value when the API does not provide one", () => {
    const model: ProviderModelEntry = {
      id: "ox",
      name: "Ox",
      contextWindow: 1_048_576,
      contextWindowSource: "fallback",
      efforts: [{ id: "max", name: "Max", isDefault: true }],
      effortsSource: "fallback",
    };
    expect(mergeRemoteModelMetadata(model, { id: "ox" })).toEqual({
      ...model,
      supportsReasoningEffort: true,
      supportsReasoningEffortSource: "fallback",
    });
  });

  it("chooses medium when the API ladder has no default", () => {
    const merged = mergeRemoteModelMetadata(
      { id: "ox", name: "Ox" },
      {
        id: "ox",
        reasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      },
    );
    expect(merged.efforts?.find((effort) => effort.isDefault)?.id).toBe(
      "medium",
    );
  });

  it("keeps legacy vision/video flags untouched", () => {
    const model: ProviderModelEntry = {
      id: "ox",
      name: "Ox",
      supportsVision: false,
      supportsVideo: true,
    };
    const merged = mergeRemoteModelMetadata(model, {
      id: "ox",
      supportsVision: true,
      supportsVideo: false,
    });
    expect(merged.supportsVision).toBe(false);
    expect(merged.supportsVideo).toBe(true);
  });

  it("ignores a remote row for a different model id", () => {
    const model: ProviderModelEntry = { id: "ox", name: "Ox" };
    expect(mergeRemoteModelMetadata(model, { id: "other" })).toBe(model);
    expect(mergeRemoteModelMetadata(model, null)).toBe(model);
  });
});

describe("withModelContextWindow", () => {
  it("updates the active catalog row and marks it user-set", () => {
    const next = withModelContextWindow(
      [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      "b",
      32000,
    );
    expect(next.find((m) => m.id === "b")?.contextWindow).toBe(32000);
    expect(next.find((m) => m.id === "b")?.contextWindowSource).toBe("user");
    expect(next.find((m) => m.id === "a")?.contextWindow).toBeUndefined();
  });
});

describe("modelsForContextWindow", () => {
  it("updates the active row for a readable catalog", () => {
    const next = modelsForContextWindow(
      {
        model: "b",
        models: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      },
      32000,
    );
    expect(next).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B", contextWindow: 32000, contextWindowSource: "user" },
    ]);
  });

  it("keeps an explicitly empty catalog empty", () => {
    // An empty `app_models` list is a real user choice; re-adding the channel
    // model would revive a catalog the user deliberately cleared.
    const next = modelsForContextWindow({ model: "m1", models: [] }, 32000);
    expect(next).toEqual([]);
  });

  it("omits the catalog when the stored value is unreadable", () => {
    // `models` is only the legacy read fallback. Sending it would write the
    // fallback row over the original `app_models` text.
    const next = modelsForContextWindow(
      {
        model: "m1",
        models: [{ id: "m1", name: "m1" }],
        modelCatalogCorrupt: true,
      },
      32000,
    );
    expect(next).toBeUndefined();
  });
});
