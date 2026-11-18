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

/** Boots the hook the way App does: one route setter, provider list loaded. */
function mountChip() {
  const setProviderId = vi.fn();
  const { result } = renderHook(() => useSessionProviderChip(setProviderId));
  act(() => {
    result.current.noteProviderList({ providers: [cleared, relay] });
  });
  return { chip: result.current, setProviderId };
}

describe("useSessionProviderChip provider catalog failures", () => {
  it("flags a failed catalog load and clears the flag on the next success", () => {
    const setProviderId = vi.fn();
    const { result } = renderHook(() => useSessionProviderChip(setProviderId));

    expect(result.current.providersLoadFailed).toBe(false);

    act(() => {
      result.current.noteProviderListError();
    });
    expect(result.current.providersLoadFailed).toBe(true);

    act(() => {
      result.current.noteProviderList({ providers: [relay] });
    });
    expect(result.current.providersLoadFailed).toBe(false);
  });
});

describe("useSessionProviderChip applyPrefsRoute", () => {
  it("updates an unsaved draft's raw effort pick and leaves saved sessions alone", () => {
    const { chip } = mountChip();
    chip.draftComposerRouteRef.current = {
      providerId: "relay",
      modelId: "grok-4.6",
      effort: "medium",
    };

    act(() => chip.updateDraftEffort(null, "ultra"));
    expect(chip.draftComposerRouteRef.current?.effort).toBe("ultra");

    act(() => chip.updateDraftEffort("saved-session", "low"));
    expect(chip.draftComposerRouteRef.current?.effort).toBe("ultra");
  });

  it("clears only the draft route instance that was resolved", () => {
    const { chip } = mountChip();
    const oldRoute = {
      providerId: "relay",
      modelId: "grok-4.6",
      effort: "high",
    };
    const nextRoute = {
      providerId: "relay",
      modelId: "grok-4.7",
      effort: "xhigh",
    };
    chip.draftComposerRouteRef.current = oldRoute;
    chip.draftComposerRouteRef.current = nextRoute;

    act(() => chip.clearDraftRouteIfCurrent(oldRoute));
    expect(chip.draftComposerRouteRef.current).toBe(nextRoute);
    act(() => chip.clearDraftRouteIfCurrent(nextRoute));
    expect(chip.draftComposerRouteRef.current).toBeNull();
  });

  it("does not apply a new-chat draft while resolving a saved session", () => {
    // Arrange — a draft relay pick belongs to the new chat, not this session
    const { chip } = mountChip();
    act(() => {
      chip.draftComposerRouteRef.current = {
        providerId: "relay",
        modelId: "grok-4.6",
        effort: "high",
      };
    });

    // Act
    const next = chip.resolvePrefs(
      { modelId: "grok-4.7", effort: "medium", providerId: "official" },
      GROK_BUILD_MODELS,
      { sessionId: "saved" },
    );

    // Assert — the saved session keeps its own model and official route
    expect(next.modelId).toBe("grok-4.7");
    expect(next.providerId).toBeUndefined();
  });

  it("pins the official route when the resolve falls back from an empty catalog", () => {
    // Arrange — the cleared provider is also the global route
    const { chip, setProviderId } = mountChip();
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
    expect(setProviderId).toHaveBeenLastCalledWith(null);
  });

  it("keeps the stored session provider when the resolve leaves the route alone", () => {
    // Arrange — a saved model keeps routing on its own child section
    const { chip, setProviderId } = mountChip();
    const next = chip.resolvePrefs(
      {
        modelId: "deepseek-reasoner",
        effort: null,
        providerId: "cleared",
        sessionModelId: "deepseek-reasoner",
      },
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
    expect(setProviderId).toHaveBeenLastCalledWith("cleared");
    expect(chip.draftComposerRouteRef.current).toBeNull();
  });

  it("keeps the selected route while the provider list reloads", () => {
    // Arrange
    const { chip, setProviderId } = mountChip();
    act(() => chip.applyPrefsRoute({ prefsProviderId: "relay" }));

    // Act — the catalog temporarily unloads, then returns
    act(() => chip.noteProviderList(null));
    expect(setProviderId).toHaveBeenLastCalledWith("relay");
    act(() => chip.noteProviderList({ providers: [relay] }));

    // Assert — reloaded metadata restores the matching provider identity
    expect(setProviderId).toHaveBeenLastCalledWith("relay");
  });

  it("paints a custom provider when the stored prefs name one", () => {
    // Arrange — only the stored prefs carry the route
    const { chip, setProviderId } = mountChip();

    // Act
    act(() => chip.applyPrefsRoute({ prefsProviderId: "relay" }));

    // Assert
    expect(setProviderId).toHaveBeenLastCalledWith("relay");
  });

  it("paints the official chip for a stored official chat", () => {
    // Arrange
    const { chip, setProviderId } = mountChip();

    // Act
    act(() => chip.applyPrefsRoute({ prefsProviderId: "official" }));

    // Assert
    expect(setProviderId).toHaveBeenLastCalledWith(null);
  });

  it("lets an explicit route win over the stored provider", () => {
    // Arrange
    const { chip, setProviderId } = mountChip();

    // Act
    act(() =>
      chip.applyPrefsRoute({
        routeProviderId: "relay",
        prefsProviderId: "cleared",
      }),
    );

    // Assert
    expect(setProviderId).toHaveBeenLastCalledWith("relay");
  });

  it("drops an unsaved draft pick when the chat is already stored", () => {
    // Arrange — the draft belongs to a new chat, not to the stored one
    const { chip, setProviderId } = mountChip();
    act(() => {
      chip.draftComposerRouteRef.current = {
        providerId: "cleared",
        modelId: "deepseek-chat",
        effort: "high",
      };
    });

    // Act
    act(() => chip.applyPrefsRoute({ sessionId: "saved" }));

    // Assert — a stored chat without a provider follows official, not the draft
    expect(chip.draftComposerRouteRef.current).toBeNull();
    expect(setProviderId).toHaveBeenLastCalledWith(null);
  });

  it("keeps a new chat's draft provider", () => {
    // Arrange — nothing stored yet, so the in-memory pick is the route
    const { chip, setProviderId } = mountChip();
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
    expect(setProviderId).toHaveBeenLastCalledWith("cleared");
  });

  it("falls back to official for a new chat with no draft", () => {
    // Arrange — configured providers do not activate a route by themselves
    const { chip, setProviderId } = mountChip();

    // Act
    act(() => chip.applyPrefsRoute({}));

    // Assert
    expect(setProviderId).toHaveBeenLastCalledWith(null);
  });

  it("resolves a new chat's draft model against the loaded provider list", () => {
    // Arrange — the draft lives only in the hook
    const { chip } = mountChip();
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
