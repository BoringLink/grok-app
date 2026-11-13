import { useCallback, useMemo, useRef } from "react";
import type { CustomProvider } from "@/lib/api/providers";
import {
  resolveComposerPrefsSelection,
  type ComposerPrefsSelection,
  type ComposerPrefsSelectionInput,
} from "@/lib/composerPrefsApply";
import type { ModelOption } from "@/lib/grokCatalog";

export type DraftComposerRoute = {
  providerId: string;
  modelId: string;
  effort: string;
};

type ProviderChipSetters = {
  setProviderActiveSource: (source: string) => void;
  setProviderActiveId: (id: string | null) => void;
  setActiveCustomProvider: (provider: CustomProvider | null) => void;
};

/**
 * Route painting for one applied prefs resolve.
 * `routeProviderId` is the resolver's override: `null` pins the official
 * route, `undefined` keeps the stored → draft → global order (BOR-152).
 */
export type PrefsRouteInput = {
  routeProviderId?: string | null;
  prefsProviderId?: string | null;
  /** Chat on screen; a stored chat drops its unsaved draft pick first. */
  sessionId?: string | null;
};

/**
 * Composer chip for the chat on screen.
 * A stored provider paints that chat. Missing means the global route.
 * Listing providers again must not wipe a chat that already picked one.
 */
export function useSessionProviderChip() {
  const settersRef = useRef<ProviderChipSetters | null>(null);
  const globalProviderRouteRef = useRef<{ source: string; id: string | null }>({
    source: "official",
    id: null,
  });
  const customProvidersRef = useRef<CustomProvider[]>([]);
  const sessionProviderChipRef = useRef<string | null | undefined>(undefined);
  const draftComposerRouteRef = useRef<DraftComposerRoute | null>(null);
  const afterProviderListRef = useRef<(() => void) | null>(null);

  const paint = useCallback((providerId: string | null) => {
    const set = settersRef.current;
    if (!set) return;
    const id = (providerId ?? "").trim();
    sessionProviderChipRef.current = id || null;
    const providers = customProvidersRef.current;
    const global = globalProviderRouteRef.current;
    if (!id) {
      const source = global.source || "official";
      set.setProviderActiveSource(source);
      set.setProviderActiveId(global.id);
      set.setActiveCustomProvider(
        source === "custom"
          ? providers.find((p) => p.id === global.id) ?? null
          : null,
      );
      return;
    }
    if (id.toLowerCase() === "official") {
      set.setProviderActiveSource("official");
      set.setProviderActiveId(null);
      set.setActiveCustomProvider(null);
      return;
    }
    set.setProviderActiveSource("custom");
    set.setProviderActiveId(id);
    set.setActiveCustomProvider(providers.find((p) => p.id === id) ?? null);
  }, []);

  /**
   * Resolve stored prefs against the provider list and the new-chat draft the
   * chip already holds, so callers do not have to reach into those refs.
   */
  const resolvePrefs = useCallback(
    (
      prefs: ComposerPrefsSelectionInput,
      catalog: ModelOption[],
    ): ComposerPrefsSelection =>
      resolveComposerPrefsSelection({
        prefs,
        catalog,
        providers: customProvidersRef.current,
        draft: draftComposerRouteRef.current,
      }),
    [],
  );

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

  const noteProviderList = useCallback(
    (
      list: {
        providers: CustomProvider[];
        activeSource: string;
        activeProviderId: string | null;
      } | null,
    ) => {
      const set = settersRef.current;
      const notify = () => {
        afterProviderListRef.current?.();
      };
      if (!list) {
        customProvidersRef.current = [];
        globalProviderRouteRef.current = { source: "official", id: null };
        set?.setProviderActiveSource("official");
        set?.setProviderActiveId(null);
        set?.setActiveCustomProvider(null);
        notify();
        return;
      }
      customProvidersRef.current = list.providers;
      globalProviderRouteRef.current = {
        source: list.activeSource,
        id: list.activeProviderId,
      };
      const chip = sessionProviderChipRef.current;
      if (chip === undefined) {
        set?.setProviderActiveSource(list.activeSource);
        set?.setProviderActiveId(list.activeProviderId);
        set?.setActiveCustomProvider(
          list.activeSource === "custom"
            ? list.providers.find((p) => p.id === list.activeProviderId) ?? null
            : null,
        );
        notify();
        return;
      }
      paint(chip);
      notify();
    },
    [paint],
  );

  const setAfterProviderList = useCallback((fn: (() => void) | null) => {
    afterProviderListRef.current = fn;
  }, []);

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
