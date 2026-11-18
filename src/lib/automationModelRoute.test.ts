import { describe, expect, it } from "vitest";
import {
  automationModelValue,
  effectiveAutomationProviderId,
  inferAutomationProviderId,
  normalizeAutomationRoute,
  parseAutomationModelValue,
  resolveAutomationRunEffort,
  resolveAutomationRunRoute,
} from "./automationModelRoute";

const providers = [
  {
    id: "relay-a",
    model: "deepseek-v4-flash",
    models: [{ id: "deepseek-v4-flash" }, { id: "qwen3.8-max" }],
  },
];

const effortProviders = [
  {
    id: "effort-relay",
    model: "m1",
    baseUrl: "https://relay.example/v1",
    efforts: [{ id: "channel-only", name: "Channel only" }],
    models: [
      {
        id: "m1",
        name: "M1",
        supportsReasoningEffort: true,
        efforts: [{ id: "max", name: "Max", isDefault: true }],
      },
      {
        id: "m2",
        name: "M2",
        supportsReasoningEffort: true,
        efforts: [],
      },
      {
        id: "no-think",
        name: "No thinking",
        supportsReasoningEffort: false,
        efforts: [],
      },
    ],
  },
];


describe("automation model route", () => {
  it("falls back a deleted provider to the official model", () => {
    expect(
      resolveAutomationRunRoute({
        providerId: "deleted-relay",
        modelId: "gemini-3.5-flash",
        officialModelIds: ["grok-4.7"],
        officialDefaultModelId: "grok-4.7",
        providers,
      }),
    ).toEqual({ providerId: "official", modelId: "grok-4.7" });
  });

  it("uses a model provider default when a saved model row disappeared", () => {
    const configured = [
      {
        id: "relay-a",
        model: "deepseek-v4-flash",
        models: [{ id: "deepseek-v4-flash" }, { id: "qwen3.8-max" }],
      },
    ];
    expect(
      resolveAutomationRunRoute({
        providerId: "relay-a",
        modelId: "removed-model",
        officialModelIds: ["grok-4.7"],
        officialDefaultModelId: "grok-4.7",
        providers: configured,
      }),
    ).toEqual({ providerId: "relay-a", modelId: "deepseek-v4-flash" });
  });

  it("normalizes automation effort against the selected model ladder", () => {
    const options = {
      providerId: "effort-relay",
      providers: effortProviders,
      officialModels: [],
    };
    expect(
      resolveAutomationRunEffort({
        ...options,
        modelId: "m1",
        requestedEffort: "max",
      }),
    ).toBe("max");
    expect(
      resolveAutomationRunEffort({
        ...options,
        modelId: "m2",
        requestedEffort: "channel-only",
      }),
    ).toBe("medium");
    expect(
      resolveAutomationRunEffort({
        ...options,
        modelId: "no-think",
        requestedEffort: "high",
      }),
    ).toBeUndefined();
  });

  it("keeps a legacy effort when the route is unresolved for host validation", () => {
    expect(
      resolveAutomationRunEffort({
        providerId: null,
        modelId: "",
        requestedEffort: "max",
        providers: effortProviders,
        officialModels: [],
      }),
    ).toBe("max");
  });

  it("round-trips official and custom picks", () => {
    expect(
      parseAutomationModelValue(
        automationModelValue({ kind: "official", modelId: "grok-4.7" }),
      ),
    ).toEqual({ kind: "official", modelId: "grok-4.7" });
    expect(
      parseAutomationModelValue(
        automationModelValue({
          kind: "custom",
          providerId: "relay-a",
          modelId: "qwen3.8-max",
        }),
      ),
    ).toEqual({
      kind: "custom",
      providerId: "relay-a",
      modelId: "qwen3.8-max",
    });
  });

  it("ignores malformed option values", () => {
    expect(parseAutomationModelValue("grok-4.7")).toBeNull();
    expect(parseAutomationModelValue('{"kind":"custom"}')).toBeNull();
  });

  it("prefers an explicit provider and infers official for legacy rows", () => {
    expect(
      effectiveAutomationProviderId(
        { providerId: "relay-a", modelId: "grok-4.7" },
        ["grok-4.7"],
        providers,
      ),
    ).toBe("relay-a");
    expect(
      effectiveAutomationProviderId(
        { modelId: "grok-4.7" },
        ["grok-4.7"],
        providers,
      ),
    ).toBe("official");
    expect(
      effectiveAutomationProviderId(
        { modelId: "__no_such_model__" },
        ["grok-4.7"],
        providers,
      ),
    ).toBeNull();
  });

  it("infers the provider that uniquely lists a legacy custom model", () => {
    expect(
      inferAutomationProviderId({
        modelId: "qwen3.8-max",
        officialModelIds: ["grok-4.7"],
        providers,
      }),
    ).toBe("relay-a");
    expect(
      inferAutomationProviderId({
        modelId: "grok-4.7",
        officialModelIds: ["grok-4.7"],
        providers,
      }),
    ).toBe("official");
    const sameId = [{ id: "qwen3.8-max", model: "qwen3.8-max" }];
    expect(
      inferAutomationProviderId({
        modelId: "qwen3.8-max",
        officialModelIds: ["grok-4.7"],
        providers: sameId,
      }),
    ).toBe("");
    expect(
      effectiveAutomationProviderId(
        { modelId: "qwen3.8-max" },
        ["grok-4.7"],
        sameId,
      ),
    ).toBeNull();
  });

  it("keeps the active route when a legacy model matches several providers", () => {
    const shared = [
      { id: "relay-a", model: "qwen3.8-max" },
      { id: "relay-b", model: "qwen3.8-max" },
    ];
    expect(
      inferAutomationProviderId({
        modelId: "qwen3.8-max",
        officialModelIds: ["grok-4.7"],
        providers: shared,
      }),
    ).toBe("");
    expect(
      effectiveAutomationProviderId(
        { modelId: "qwen3.8-max" },
        ["grok-4.7"],
        shared,
      ),
    ).toBeNull();
  });

  it("normalizes a saved route to a pair the picker can show", () => {
    const base = {
      officialModelIds: ["grok-4.7"],
      officialDefaultModelId: "grok-4.7",
      providers,
    };
    expect(
      normalizeAutomationRoute({
        ...base,
        providerId: "official",
        modelId: "grok-4.7",
      }),
    ).toEqual({ providerId: "official", modelId: "grok-4.7" });
    expect(
      normalizeAutomationRoute({
        ...base,
        providerId: "official",
        modelId: "gone",
      }),
    ).toEqual({ providerId: "official", modelId: "grok-4.7" });
    expect(
      normalizeAutomationRoute({
        ...base,
        providerId: "relay-a",
        modelId: "qwen3.8-max",
      }),
    ).toEqual({ providerId: "relay-a", modelId: "qwen3.8-max" });
    expect(
      normalizeAutomationRoute({
        ...base,
        providerId: "relay-a",
        modelId: "gone",
      }),
    ).toEqual({
      providerId: "relay-a",
      modelId: "deepseek-v4-flash",
    });
    expect(
      normalizeAutomationRoute({
        ...base,
        providerId: "deleted-provider",
        modelId: "gone",
      }),
    ).toEqual({ providerId: "", modelId: "gone" });
  });
});
