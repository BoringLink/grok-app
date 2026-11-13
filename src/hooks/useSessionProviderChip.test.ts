/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CustomProvider } from "@/lib/api/providers";
import { GROK_BUILD_MODELS } from "@/lib/grokCatalog";
import { resolveComposerPrefsSelection } from "@/lib/composerPrefsApply";
import { useSessionProviderChip } from "./useSessionProviderChip";

afterEach(cleanup);

const cleared: CustomProvider = {
  id: "cleared",
  name: "Cleared",
  model: "deepseek-chat",
  baseUrl: "https://cleared.example/v1",
  hasApiKey: true,
  apiBackend: "chat_completions",
  providerMode: "generic",
  isDefault: true,
  models: [],
};

/** Mirrors the sync-prefs effect: an override wins over the stored provider. */
function paintResolvedRoute(
  chip: ReturnType<typeof useSessionProviderChip>,
  prefsProviderId: string | null,
  providerId: string | null | undefined,
) {
  const stored = prefsProviderId?.trim() ?? "";
  const route = providerId === undefined ? stored : providerId;
  chip.paint(route ?? "official");
}

describe("useSessionProviderChip with an empty provider catalog", () => {
  it("drops the custom route when the resolve falls back to official", () => {
    // Arrange — the cleared provider is also the global route
    const setProviderActiveSource = vi.fn();
    const setProviderActiveId = vi.fn();
    const setActiveCustomProvider = vi.fn();
    const { result } = renderHook(() => useSessionProviderChip());
    act(() => {
      result.current.bind({
        setProviderActiveSource,
        setProviderActiveId,
        setActiveCustomProvider,
      });
      result.current.noteProviderList({
        providers: [cleared],
        activeSource: "custom",
        activeProviderId: "cleared",
      });
      result.current.paint("cleared");
    });
    expect(setProviderActiveSource).toHaveBeenLastCalledWith("custom");

    const next = resolveComposerPrefsSelection({
      prefs: { modelId: null, effort: null, providerId: "cleared" },
      catalog: GROK_BUILD_MODELS,
      providers: [cleared],
    });

    // Act / Assert — no custom chip or route survives the official fallback
    act(() => paintResolvedRoute(result.current, "cleared", next.providerId));
    expect(setProviderActiveSource).toHaveBeenLastCalledWith("official");
    expect(setProviderActiveId).toHaveBeenLastCalledWith(null);
    expect(setActiveCustomProvider).toHaveBeenLastCalledWith(null);
  });

  it("keeps the stored route for a session that saved its model", () => {
    // Arrange
    const setProviderActiveSource = vi.fn();
    const setProviderActiveId = vi.fn();
    const setActiveCustomProvider = vi.fn();
    const { result } = renderHook(() => useSessionProviderChip());
    act(() => {
      result.current.bind({
        setProviderActiveSource,
        setProviderActiveId,
        setActiveCustomProvider,
      });
      result.current.noteProviderList({
        providers: [cleared],
        activeSource: "custom",
        activeProviderId: "cleared",
      });
    });

    const next = resolveComposerPrefsSelection({
      prefs: {
        modelId: "deepseek-reasoner",
        effort: null,
        providerId: "cleared",
      },
      catalog: GROK_BUILD_MODELS,
      providers: [cleared],
    });

    // Act
    act(() => paintResolvedRoute(result.current, "cleared", next.providerId));

    // Assert — the session's own child section still routes
    expect(setProviderActiveSource).toHaveBeenLastCalledWith("custom");
    expect(setProviderActiveId).toHaveBeenLastCalledWith("cleared");
    expect(setActiveCustomProvider).toHaveBeenLastCalledWith(cleared);
  });
});
