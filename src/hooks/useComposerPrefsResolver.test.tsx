/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { ComposerPrefs } from "@/lib/api";
import type { ModelOption } from "@/lib/grokCatalog";
import { useComposerPrefsResolver } from "./useComposerPrefsResolver";

vi.mock("@/lib/api", () => ({
  composerPrefsResolve: vi.fn(),
  isTauri: vi.fn(() => true),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function prefs(modelId: string): ComposerPrefs {
  return {
    modelId,
    effort: "ultra",
    mode: "agent",
    permissionPolicy: "ask",
    scope: "session",
    source: "session",
    providerId: "relay",
  };
}

describe("useComposerPrefsResolver", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps reconciliation gated until the current session prefs are restored", async () => {
    const first = deferred<ComposerPrefs>();
    const second = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsResolve)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const barrierRef = { current: Promise.resolve() };
    const setAfterProviderList = vi.fn();
    const apply = vi.fn();
    const onError = vi.fn();
    const models: ModelOption[] = [];
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useComposerPrefsResolver({
          projectId: "project-a",
          sessionId,
          forceOfficial: false,
          prefsScope: "session",
          models,
          barrierRef,
          setAfterProviderList,
          apply,
          onError,
        }),
      { initialProps: { sessionId: "session-a" } },
    );

    expect(result.current).toBe(false);
    await act(async () => {
      first.resolve(prefs("m1"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toBe(true));
    expect(apply).toHaveBeenCalledWith(
      prefs("m1"),
      [],
      { sessionId: "session-a", forceOfficial: false },
    );

    rerender({ sessionId: "session-b" });
    expect(result.current).toBe(false);
    await act(async () => {
      second.resolve(prefs("m2"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toBe(true));
    expect(apply).toHaveBeenLastCalledWith(
      prefs("m2"),
      [],
      { sessionId: "session-b", forceOfficial: false },
    );
  });

  it("keeps reconciliation gated after a resolve error and retries on provider refresh", async () => {
    vi.mocked(api.composerPrefsResolve)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(prefs("m1"));
    const barrierRef = { current: Promise.resolve() };
    const setAfterProviderList = vi.fn();
    const apply = vi.fn();
    const onError = vi.fn();
    const models: ModelOption[] = [];
    const { result } = renderHook(() =>
      useComposerPrefsResolver({
        projectId: "project-a",
        sessionId: "session-a",
        forceOfficial: false,
        prefsScope: "session",
        models,
        barrierRef,
        setAfterProviderList,
        apply,
        onError,
      }),
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    expect(result.current).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    const retry = setAfterProviderList.mock.calls[0][0];
    await act(async () => {
      retry?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(apply).toHaveBeenCalledWith(
      prefs("m1"),
      [],
      { sessionId: "session-a", forceOfficial: false },
    );
  });

  it("ignores an older provider-list resolve when a newer resolve starts", async () => {
    const older = deferred<ComposerPrefs>();
    const newer = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsResolve)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const barrierRef = { current: Promise.resolve() };
    const setAfterProviderList = vi.fn();
    const apply = vi.fn();
    const onError = vi.fn();
    const stableModels: ModelOption[] = [];
    const { result } = renderHook(() =>
      useComposerPrefsResolver({
        projectId: "project-a",
        sessionId: "session-a",
        forceOfficial: false,
        prefsScope: "session",
        models: stableModels,
        barrierRef,
        setAfterProviderList,
        apply,
        onError,
      }),
    );

    const rerun = setAfterProviderList.mock.calls[0][0];
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.composerPrefsResolve).toHaveBeenCalledTimes(1);

    act(() => rerun?.());
    await act(async () => Promise.resolve());
    expect(api.composerPrefsResolve).toHaveBeenCalledTimes(2);
    await act(async () => {
      older.resolve(prefs("old-model"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apply).not.toHaveBeenCalled();
    expect(result.current).toBe(false);

    await act(async () => {
      newer.resolve(prefs("new-model"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toBe(true));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      prefs("new-model"),
      stableModels,
      { sessionId: "session-a", forceOfficial: false },
    );
  });
});
