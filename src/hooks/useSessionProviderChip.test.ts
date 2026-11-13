/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CustomProvider } from "@/lib/api/providers";
import { GROK_BUILD_MODELS } from "@/lib/grokCatalog";
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

const relay: CustomProvider = {
  id: "relay",
  name: "Relay",
  model: "grok-4.6",
  baseUrl: "https://relay.example/v1",
  hasApiKey: true,
  apiBackend: "chat_completions",
  providerMode: "generic",
  isDefault: false,
  models: [{ id: "grok-4.6", name: "Grok 4.6" }],
};

/** Boots the hook the way App does: setters bound, provider list loaded. */
function mountChip(globalProviderId: string | null = "cleared") {
  const setters = {
    setProviderActiveSource: vi.fn(),
    setProviderActiveId: vi.fn(),
    setActiveCustomProvider: vi.fn(),
  };
  const { result } = renderHook(() => useSessionProviderChip());
  act(() => {
    result.current.bind(setters);
    result.current.noteProviderList({
      providers: [cleared, relay],
      activeSource: globalProviderId ? "custom" : "official",
      activeProviderId: globalProviderId,
    });
  });
  return { chip: result.current, setters };
}

describe("useSessionProviderChip applyPrefsRoute", () => {
  it("pins the official route when the resolve falls back from an empty catalog", () => {
    // Arrange — the cleared provider is also the global route
    const { chip, setters } = mountChip("cleared");
    const next = chip.resolvePrefs(
      { modelId: null, effort: null, providerId: "cleared" },
      GROK_BUILD_MODELS,
    );
    expect(next.providerId).toBeNull();

    // Act — the resolver's official override wins over the stored provider
    act(() =>
      chip.applyPrefsRoute({
        routeProviderId: next.providerId,
        prefsProviderId: "cleared",
      }),
    );

    // Assert — no custom chip or route survives the official fallback
    expect(setters.setProviderActiveSource).toHaveBeenLastCalledWith("official");
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith(null);
    expect(setters.setActiveCustomProvider).toHaveBeenLastCalledWith(null);
  });

  it("keeps the stored session provider when the resolve leaves the route alone", () => {
    // Arrange — a saved model keeps routing on its own child section
    const { chip, setters } = mountChip("cleared");
    const next = chip.resolvePrefs(
      { modelId: "deepseek-reasoner", effort: null, providerId: "cleared" },
      GROK_BUILD_MODELS,
    );
    expect(next.providerId).toBeUndefined();

    // Act
    act(() =>
      chip.applyPrefsRoute({
        routeProviderId: next.providerId,
        prefsProviderId: "cleared",
        sessionId: "saved",
      }),
    );

    // Assert — the session's own provider still paints and still routes
    expect(setters.setProviderActiveSource).toHaveBeenLastCalledWith("custom");
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith("cleared");
    expect(setters.setActiveCustomProvider).toHaveBeenLastCalledWith(cleared);
    expect(chip.draftComposerRouteRef.current).toBeNull();
  });

  it("paints a custom provider when the stored prefs name one", () => {
    // Arrange — only the stored prefs carry the route
    const { chip, setters } = mountChip("cleared");

    // Act
    act(() => chip.applyPrefsRoute({ prefsProviderId: "relay" }));

    // Assert
    expect(setters.setProviderActiveSource).toHaveBeenLastCalledWith("custom");
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith("relay");
    expect(setters.setActiveCustomProvider).toHaveBeenLastCalledWith(relay);
  });

  it("paints the official chip for a stored official chat", () => {
    // Arrange
    const { chip, setters } = mountChip("cleared");

    // Act
    act(() => chip.applyPrefsRoute({ prefsProviderId: "official" }));

    // Assert
    expect(setters.setProviderActiveSource).toHaveBeenLastCalledWith("official");
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith(null);
    expect(setters.setActiveCustomProvider).toHaveBeenLastCalledWith(null);
  });

  it("lets an explicit route win over the stored provider", () => {
    // Arrange
    const { chip, setters } = mountChip("cleared");

    // Act
    act(() =>
      chip.applyPrefsRoute({
        routeProviderId: "relay",
        prefsProviderId: "cleared",
      }),
    );

    // Assert
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith("relay");
  });

  it("drops an unsaved draft pick when the chat is already stored", () => {
    // Arrange — the draft belongs to a new chat, not to the stored one
    const { chip, setters } = mountChip("relay");
    act(() => {
      chip.draftComposerRouteRef.current = {
        providerId: "cleared",
        modelId: "deepseek-chat",
        effort: "high",
      };
    });

    // Act
    act(() => chip.applyPrefsRoute({ sessionId: "saved" }));

    // Assert — the chat follows the global route, not the draft
    expect(chip.draftComposerRouteRef.current).toBeNull();
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith("relay");
  });

  it("keeps a new chat's draft provider", () => {
    // Arrange — nothing stored yet, so the in-memory pick is the route
    const { chip, setters } = mountChip("relay");
    act(() => {
      chip.draftComposerRouteRef.current = {
        providerId: "cleared",
        modelId: "deepseek-chat",
        effort: "high",
      };
    });

    // Act
    act(() => chip.applyPrefsRoute({ sessionId: null }));

    // Assert
    expect(setters.setProviderActiveSource).toHaveBeenLastCalledWith("custom");
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith("cleared");
    expect(setters.setActiveCustomProvider).toHaveBeenLastCalledWith(cleared);
  });

  it("falls back to the global route for a new chat with no draft", () => {
    // Arrange — a custom global route proves the fallback is not a pin
    const { chip, setters } = mountChip("relay");

    // Act
    act(() => chip.applyPrefsRoute({}));

    // Assert
    expect(setters.setProviderActiveSource).toHaveBeenLastCalledWith("custom");
    expect(setters.setProviderActiveId).toHaveBeenLastCalledWith("relay");
  });

  it("resolves a new chat's draft model against the loaded provider list", () => {
    // Arrange — the draft lives only in the hook
    const { chip } = mountChip("relay");
    act(() => {
      chip.draftComposerRouteRef.current = {
        providerId: "cleared",
        modelId: "deepseek-chat",
        effort: "high",
      };
    });

    // Act
    const next = chip.resolvePrefs(
      { modelId: null, effort: null, providerId: null },
      GROK_BUILD_MODELS,
    );

    // Assert — the draft's id survives the cleared catalog
    expect(next.modelId).toBe("deepseek-chat");
  });
});
