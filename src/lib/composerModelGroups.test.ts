import { describe, expect, it } from "vitest";
import {
  buildComposerModelGroups,
  composerMenuProviders,
  filterComposerModelGroups,
  isComposerModelEntryActive,
  type ComposerModelEntry,
} from "./composerModelGroups";
import type { ModelOption } from "./grokCatalog";

const official: ModelOption[] = [
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-4", label: "Grok 4" },
];

const providers = [
  {
    id: "yunyi",
    name: "云驿",
    model: "deepseek-chat",
    providerMode: "generic",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "Reasoner" },
    ],
  },
  {
    id: "local",
    name: "",
    model: "llama3",
  },
];

describe("buildComposerModelGroups", () => {
  it("builds official group plus multi-model provider groups", () => {
    const groups = buildComposerModelGroups({
      officialModels: official,
      providers,
      officialGroupTitle: "Official",
    });
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      key: "official",
      title: "Official",
      entries: [
        {
          pick: { kind: "official", modelId: "grok-4.5" },
          title: "Grok 4.5",
        },
        {
          pick: { kind: "official", modelId: "grok-4" },
          title: "Grok 4",
        },
      ],
    });
    expect(groups[1].title).toBe("云驿");
    expect(groups[1].entries).toHaveLength(2);
    expect(groups[1].entries[0]).toMatchObject({
      pick: {
        kind: "custom",
        providerId: "yunyi",
        modelId: "deepseek-chat",
      },
      title: "DeepSeek Chat",
      subtitle: "deepseek-chat",
    });
    expect(groups[1].entries[1]).toMatchObject({
      pick: {
        kind: "custom",
        providerId: "yunyi",
        modelId: "deepseek-reasoner",
      },
      title: "Reasoner",
      subtitle: "deepseek-reasoner",
    });
    expect(groups[2].entries[0]).toMatchObject({
      pick: { kind: "custom", providerId: "local", modelId: "llama3" },
      title: "llama3",
      subtitle: undefined,
    });
  });

  it("omits provider groups when providers empty", () => {
    const groups = buildComposerModelGroups({
      officialModels: official,
      providers: [],
      officialGroupTitle: "Official",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("official");
  });

  it("lists every catalog row on a generic channel", () => {
    const groups = buildComposerModelGroups({
      officialModels: [],
      providers: [
        {
          id: "kiro",
          name: "Kiro",
          model: "auto",
          providerMode: "generic",
          models: [
            { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
            { id: "auto", name: "Auto" },
            { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
          ],
        },
      ],
      officialGroupTitle: "Official",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((e) => e.pick)).toEqual([
      { kind: "custom", providerId: "kiro", modelId: "gpt-5.6-luna" },
      { kind: "custom", providerId: "kiro", modelId: "auto" },
      { kind: "custom", providerId: "kiro", modelId: "gpt-5.6-sol" },
    ]);
  });

  it("keeps every catalog row on a Grok Build-compatible relay", () => {
    const groups = buildComposerModelGroups({
      officialModels: official,
      providers: [
        {
          id: "beef-relay",
          name: "Beef",
          model: "grok-4.6",
          providerMode: "grok_build_proxy",
          models: [
            { id: "grok-4.6", name: "Grok 4.6" },
            { id: "grok-4.5", name: "Grok 4.5" },
          ],
        },
      ],
      officialGroupTitle: "Official",
    });
    const beef = groups.find((g) => g.key === "provider:beef-relay");
    expect(beef?.entries.map((e) => e.pick)).toEqual([
      { kind: "custom", providerId: "beef-relay", modelId: "grok-4.6" },
      { kind: "custom", providerId: "beef-relay", modelId: "grok-4.5" },
    ]);
    expect(groups[0].key).toBe("official");
    expect(groups[0].entries).toHaveLength(2);
  });

  it("skips providers with empty model catalog", () => {
    const groups = buildComposerModelGroups({
      officialModels: [],
      providers: [{ id: "x", name: "X", model: "  " }],
      officialGroupTitle: "Official",
    });
    expect(groups).toEqual([]);
  });

  it("omits a provider whose catalog was explicitly cleared", () => {
    const groups = buildComposerModelGroups({
      officialModels: [],
      providers: [
        {
          id: "cleared",
          name: "Cleared",
          model: "deepseek-chat",
          providerMode: "generic",
          models: [],
        },
      ],
      officialGroupTitle: "Official",
    });
    expect(groups).toEqual([]);
  });

  it("keeps the sibling providers of a cleared one listed", () => {
    const groups = buildComposerModelGroups({
      officialModels: official,
      providers: [
        { id: "cleared", name: "Cleared", model: "deepseek-chat", models: [] },
        {
          id: "kept",
          name: "Kept",
          model: "kept-default",
          models: [{ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" }],
        },
      ],
      officialGroupTitle: "Official",
    });
    expect(groups.map((g) => g.key)).toEqual(["official", "provider:kept"]);
    expect(groups[1].entries.map((e) => e.pick)).toEqual([
      { kind: "custom", providerId: "kept", modelId: "gemini-3.5-flash" },
    ]);
  });

  it("keeps the channel row for a host that sends no catalog", () => {
    const groups = buildComposerModelGroups({
      officialModels: [],
      providers: [{ id: "legacy", name: "Legacy", model: "llama3" }],
      officialGroupTitle: "Official",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((e) => e.pick)).toEqual([
      { kind: "custom", providerId: "legacy", modelId: "llama3" },
    ]);
  });
});

describe("composerMenuProviders", () => {
  it("passes an explicitly cleared catalog through as empty", () => {
    const rows = composerMenuProviders([
      { id: "cleared", name: "Cleared", model: "deepseek-chat", models: [] },
    ]);
    expect(rows).toEqual([
      {
        id: "cleared",
        name: "Cleared",
        model: "deepseek-chat",
        providerMode: "generic",
        models: [],
      },
    ]);
  });

  it("synthesizes the legacy row when no catalog is sent", () => {
    const rows = composerMenuProviders([
      { id: "legacy", name: "Legacy", model: "llama3" },
    ]);
    expect(rows[0].models).toEqual([{ id: "llama3", name: "llama3" }]);
  });

  it("keeps a non-empty catalog", () => {
    const rows = composerMenuProviders([
      {
        id: "kiro",
        name: "Kiro",
        model: "auto",
        models: [{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna" }],
      },
    ]);
    expect(rows[0].models).toEqual([
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    ]);
  });
});

describe("filterComposerModelGroups", () => {
  it("filters entries and drops empty groups", () => {
    const groups = buildComposerModelGroups({
      officialModels: official,
      providers,
      officialGroupTitle: "Official",
    });
    const filtered = filterComposerModelGroups(groups, "deep");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].entries.map((e) => e.pick)).toEqual([
      { kind: "custom", providerId: "yunyi", modelId: "deepseek-chat" },
      { kind: "custom", providerId: "yunyi", modelId: "deepseek-reasoner" },
    ]);
    const reason = filterComposerModelGroups(groups, "reason");
    expect(reason[0].entries.map((e) => e.pick)).toEqual([
      { kind: "custom", providerId: "yunyi", modelId: "deepseek-reasoner" },
    ]);
  });
});

describe("isComposerModelEntryActive", () => {
  const officialEntry: ComposerModelEntry = {
    key: "official:grok-4.5",
    pick: { kind: "official", modelId: "grok-4.5" },
    title: "Grok 4.5",
  };
  const customEntry: ComposerModelEntry = {
    key: "custom:yunyi:deepseek-chat",
    pick: {
      kind: "custom",
      providerId: "yunyi",
      modelId: "deepseek-chat",
    },
    title: "DeepSeek Chat",
  };

  it("matches official when route is official and model id equals", () => {
    expect(
      isComposerModelEntryActive(officialEntry, {
        activeSource: "official",
        activeProviderId: null,
        modelId: "grok-4.5",
      }),
    ).toBe(true);
  });

  it("matches custom when route, provider, and request model equal", () => {
    expect(
      isComposerModelEntryActive(customEntry, {
        activeSource: "custom",
        activeProviderId: "yunyi",
        activeRequestModel: "deepseek-chat",
        modelId: "grok-4.5",
      }),
    ).toBe(true);
  });

  it("does not match a different request model on same provider", () => {
    expect(
      isComposerModelEntryActive(customEntry, {
        activeSource: "custom",
        activeProviderId: "yunyi",
        activeRequestModel: "deepseek-reasoner",
        modelId: "grok-4.5",
      }),
    ).toBe(false);
  });

  it("does not match official while custom route is active", () => {
    expect(
      isComposerModelEntryActive(officialEntry, {
        activeSource: "custom",
        activeProviderId: "yunyi",
        activeRequestModel: "deepseek-chat",
        modelId: "grok-4.5",
      }),
    ).toBe(false);
  });
});
