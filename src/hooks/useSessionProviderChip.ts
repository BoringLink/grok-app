import { useCallback, useMemo, useRef, useState } from "react";
import type { CustomProvider } from "@/lib/api/providers";
import {
  resolveComposerPrefsSelection,
  type ComposerPrefsSelection,
  type ComposerPrefsSelectionInput,
} from "@/lib/composerPrefsApply";
import type { ModelOption } from "@/lib/grokCatalog";
import { resolveSessionProviderRoute } from "@/lib/sessionProviderRoute";
import type { DraftComposerRoute } from "@/lib/draftComposerRoute";

export type ProviderRouteSource = "official" | "custom";

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
 *
 * `setProviderId` 由调用方持有，路由只有一个值：`null` 表示官方。
 */
export function useSessionProviderChip(
  setProviderId: (id: string | null) => void,
) {
  const customProvidersRef = useRef<CustomProvider[]>([]);
  const providersLoadedRef = useRef(false);
  const sessionProviderChipRef = useRef<string | null | undefined>(undefined);
  const draftComposerRouteRef = useRef<DraftComposerRoute | null>(null);
  const afterProviderListRef = useRef<(() => void) | null>(null);
  /** provider 目录加载失败标记：失败时 Composer 档位区显示错误而非中性加载态。 */
  const [providersLoadFailed, setProvidersLoadFailed] = useState(false);
  const clearDraftRouteIfCurrent = useCallback((route: DraftComposerRoute) => {
    if (draftComposerRouteRef.current === route) draftComposerRouteRef.current = null;
  }, []);
  const updateDraftEffort = useCallback(
    (sessionId: string | null | undefined, effort: string) => {
      if (sessionId) return;
      const draft = draftComposerRouteRef.current;
      if (draft) draftComposerRouteRef.current = { ...draft, effort };
    },
    [],
  );

  /** Paint the resolved provider route (`null` = official). */
  const paint = useCallback(
    (providerId: string | null) => {
      const route = resolveSessionProviderRoute({
        providerId,
        providers: customProvidersRef.current,
        providersLoaded: providersLoadedRef.current,
      });
      sessionProviderChipRef.current = route.providerId;
      setProviderId(route.providerId);
    },
    [setProviderId],
  );

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
        setProvidersLoadFailed(false);
        paint(sessionProviderChipRef.current ?? null);
        afterProviderListRef.current?.();
        return;
      }
      customProvidersRef.current = list.providers;
      providersLoadedRef.current = true;
      setProvidersLoadFailed(false);
      paint(sessionProviderChipRef.current ?? null);
      afterProviderListRef.current?.();
    },
    [paint],
  );

  /** 目录加载失败时置位失败标记；成功或重置列表时清除。 */
  const noteProviderListError = useCallback(() => {
    setProvidersLoadFailed(true);
  }, []);

  /** Notify when a provider-list refresh has been applied. */
  const setAfterProviderList = useCallback((fn: (() => void) | null) => {
    afterProviderListRef.current = fn;
  }, []);

  return useMemo(
    () => ({
      draftComposerRouteRef,
      updateDraftEffort,
      clearDraftRouteIfCurrent,
      paint,
      resolvePrefs,
      applyPrefsRoute,
      noteProviderList,
      noteProviderListError,
      providersLoadFailed,
      setAfterProviderList,
    }),
    [
      applyPrefsRoute,
      noteProviderList,
      noteProviderListError,
      providersLoadFailed,
      paint,
      resolvePrefs,
      setAfterProviderList,
      updateDraftEffort,
      clearDraftRouteIfCurrent,
    ],
  );
}
