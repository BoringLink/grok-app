import { useCallback, useMemo, useRef } from "react";
import type { CustomProvider } from "@/lib/api/providers";
import {
  resolveComposerPrefsSelection,
  type ComposerPrefsSelection,
  type ComposerPrefsSelectionInput,
} from "@/lib/composerPrefsApply";
import type { ModelOption } from "@/lib/grokCatalog";
import { resolveSessionProviderRoute } from "@/lib/sessionProviderRoute";

export type DraftComposerRoute = {
  providerId: string;
  modelId: string;
  effort: string;
};

export type ProviderRouteSource = "official" | "custom";

type ProviderChipSetters = {
  setProviderActiveSource: (source: ProviderRouteSource) => void;
  setProviderActiveId: (id: string | null) => void;
  setActiveCustomProvider: (provider: CustomProvider | null) => void;
};

/**
 * Route painting for one applied prefs resolve.
 * `routeProviderId` is the resolver's override: `null` pins the official
 * route, `undefined` keeps the stored → draft order.
 */
export type PrefsRouteInput = {
  routeProviderId?: string | null;
  prefsProviderId?: string | null;
  /** Chat on screen; a stored chat drops its unsaved draft pick first. */
  sessionId?: string | null;
};

/**
 * Composer chip for the chat on screen.
 *
 * The chat's stored provider is the only route source. A provider that has
 * disappeared from the loaded list falls back to official; no global
 * activation state participates.
 */
export function useSessionProviderChip() {
  const settersRef = useRef<ProviderChipSetters | null>(null);
  const customProvidersRef = useRef<CustomProvider[]>([]);
  const providersLoadedRef = useRef(false);
  const sessionProviderChipRef = useRef<string | null | undefined>(undefined);
  const draftComposerRouteRef = useRef<DraftComposerRoute | null>(null);
  const afterProviderListRef = useRef<(() => void) | null>(null);

  /** Paint the effective provider route and selected provider object. */
  const paint = useCallback((providerId: string | null) => {
    const set = settersRef.current;
    if (!set) return;
    const route = resolveSessionProviderRoute({
      providerId,
      providers: customProvidersRef.current,
      providersLoaded: providersLoadedRef.current,
    });
    sessionProviderChipRef.current = route.providerId;
    set.setProviderActiveSource(route.source);
    set.setProviderActiveId(route.providerId);
    set.setActiveCustomProvider(
      route.providerId
        ? customProvidersRef.current.find((p) => p.id === route.providerId) ??
            null
        : null,
    );
  }, []);

  /**
   * Resolve stored prefs against the provider list and the new-chat draft the
   * chip already holds, so callers do not have to reach into those refs.
   */
  const resolvePrefs = useCallback(
    (
      prefs: ComposerPrefsSelectionInput,
      catalog: ModelOption[],
      context?: { sessionId?: string | null; forceOfficial?: boolean },
    ): ComposerPrefsSelection =>
      resolveComposerPrefsSelection({
        prefs,
        catalog,
        providers: customProvidersRef.current,
        providersLoaded: providersLoadedRef.current,
        forceOfficial: context?.forceOfficial,
        draft: context?.sessionId ? null : draftComposerRouteRef.current,
      }),
    [],
  );

  /** Apply the resolved provider identity, clearing drafts for saved sessions. */
  const applyPrefsRoute = useCallback(
    (input: PrefsRouteInput) => {
      if (input.sessionId) draftComposerRouteRef.current = null;
      if (input.routeProviderId !== undefined) {
        paint(input.routeProviderId ?? "official");
        return;
      }
      const stored = input.prefsProviderId?.trim() ?? "";
      if (stored) {
        paint(stored);
        return;
      }
      const draft = input.sessionId ? null : draftComposerRouteRef.current;
      paint(draft?.providerId ?? null);
    },
    [paint],
  );

  /** Refresh route painting after the current provider catalog changes. */
  const noteProviderList = useCallback(
    (list: { providers: CustomProvider[] } | null) => {
      if (!list) {
        customProvidersRef.current = [];
        providersLoadedRef.current = false;
        paint(sessionProviderChipRef.current ?? null);
        afterProviderListRef.current?.();
        return;
      }
      customProvidersRef.current = list.providers;
      providersLoadedRef.current = true;
      paint(sessionProviderChipRef.current ?? null);
      afterProviderListRef.current?.();
    },
    [paint],
  );

  /** Notify when a provider-list refresh has been applied. */
  const setAfterProviderList = useCallback((fn: (() => void) | null) => {
    afterProviderListRef.current = fn;
  }, []);

  /** Bind the setters owned by the composer state. */
  const bind = useCallback((setters: ProviderChipSetters) => {
    settersRef.current = setters;
  }, []);

  return useMemo(
    () => ({
      draftComposerRouteRef,
      paint,
      resolvePrefs,
      applyPrefsRoute,
      noteProviderList,
      bind,
      setAfterProviderList,
    }),
    [
      applyPrefsRoute,
      bind,
      noteProviderList,
      paint,
      resolvePrefs,
      setAfterProviderList,
    ],
  );
}
