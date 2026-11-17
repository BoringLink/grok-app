/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { ComposerPrefs } from "@/lib/api";
import type { DraftComposerRoute } from "@/lib/draftComposerRoute";
import { useComposerEffort } from "./useComposerEffort";

vi.mock("@/lib/api", () => ({
  composerPrefsSet: vi.fn(),
  isTauri: vi.fn(() => true),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function hookOptions(
  sessionId: string | null,
  setEffort: (value: string) => void,
  queueRef: { current: Promise<void> } = { current: Promise.resolve() },
  showToast: (message: string, ms?: number) => void = vi.fn(),
  draftRouteRef: { current: DraftComposerRoute | null } = { current: null },
  modelId = "m-raw",
  providerId = "relay",
) {
  return {
    effort: "low",
    effortOptions: [{ id: "low" }, { id: "high" }],
    setEffort,
    projectId: "project-a",
    providerId,
    modelId,
    sessionId,
    draftRouteRef,
    queueRef,
    showToast,
    translate: (key: string) => key,
  };
}

describe("useComposerEffort session guards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not apply an earlier queued pick over a newer choice", async () => {
    const firstSave = deferred<ComposerPrefs>();
    const secondSave = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet)
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const setEffort = vi.fn();
    const queueRef = { current: Promise.resolve() };
    const { result } = renderHook(() =>
      useComposerEffort(hookOptions("session-a", setEffort, queueRef)),
    );

    act(() => {
      result.current.handleEffortPick("high");
      result.current.handleEffortPick("low");
    });
    await act(async () => {
      firstSave.resolve({
        modelId: "m-raw",
        effort: "high",
        mode: "agent",
        permissionPolicy: "ask",
        scope: "session",
        source: "session",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setEffort).not.toHaveBeenCalled();
    await act(async () => {
      secondSave.resolve({
        modelId: "m-raw",
        effort: "low",
        mode: "agent",
        permissionPolicy: "ask",
        scope: "session",
        source: "session",
      });
      await queueRef.current;
    });

    expect(setEffort).toHaveBeenCalledOnce();
    expect(setEffort).toHaveBeenCalledWith("low");
  });

  it("saves an old session pick without applying it after switching away and back", async () => {
    const save = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet).mockReturnValue(save.promise);
    const applyOld = vi.fn();
    const applyNew = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId, apply }) => useComposerEffort(hookOptions(sessionId, apply)),
      { initialProps: { sessionId: "session-a", apply: applyOld } },
    );

    act(() => { void result.current.handleEffortPick("high"); });
    rerender({ sessionId: "session-b", apply: applyNew });
    expect(result.current.isCurrentTarget("session-a", "project-a")).toBe(false);
    expect(result.current.isCurrentTarget("session-b", "project-a")).toBe(true);
    rerender({ sessionId: "session-a", apply: applyOld });
    expect(result.current.isCurrentTarget("session-a", "project-a")).toBe(true);
    await act(async () => {
      save.resolve({
        modelId: "model-a",
        effort: "high",
        mode: "agent",
        permissionPolicy: "ask",
        scope: "session",
        source: "session",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.composerPrefsSet).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a", effort: "high" }),
    );
    expect(applyOld).not.toHaveBeenCalled();
    expect(applyNew).not.toHaveBeenCalled();
  });

  it("does not apply an old model's delayed effort after a same-session model switch", async () => {
    const save = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet).mockReturnValue(save.promise);
    const setEffort = vi.fn();
    const queueRef = { current: Promise.resolve() };
    const { result, rerender } = renderHook(
      ({ modelId }) =>
        useComposerEffort(
          hookOptions("session-a", setEffort, queueRef, vi.fn(), undefined, modelId),
        ),
      { initialProps: { modelId: "m-raw" } },
    );

    act(() => { void result.current.handleEffortPick("high"); });
    rerender({ modelId: "next-model" });
    await act(async () => {
      save.resolve({
        modelId: "m-raw",
        effort: "high",
        mode: "agent",
        permissionPolicy: "ask",
        scope: "session",
        source: "session",
      });
      await queueRef.current;
    });

    expect(setEffort).not.toHaveBeenCalled();
  });

  it("does not persist an effort pick after the draft route changes", async () => {
    const draftRouteRef: { current: DraftComposerRoute | null } = {
      current: {
        providerId: "relay",
        modelId: "m-raw",
        effort: "low",
      },
    };
    const queueRef = { current: Promise.resolve() };
    const { result } = renderHook(() =>
      useComposerEffort(
        hookOptions(null, vi.fn(), queueRef, vi.fn(), draftRouteRef),
      ),
    );

    act(() => { void result.current.handleEffortPick("high"); });
    draftRouteRef.current = {
      providerId: "relay",
      modelId: "other-model",
      effort: "low",
    };
    await act(async () => queueRef.current);

    expect(api.composerPrefsSet).not.toHaveBeenCalled();
  });

  it("does not persist reconciliation for a replaced draft route", async () => {
    const draftRouteRef: { current: DraftComposerRoute | null } = {
      current: {
        providerId: "relay",
        modelId: "m-raw",
        effort: "low",
      },
    };
    const queueRef = { current: Promise.resolve() };
    const { result } = renderHook(() =>
      useComposerEffort(
        hookOptions(null, vi.fn(), queueRef, vi.fn(), draftRouteRef),
      ),
    );

    act(() => {
      void result.current.persistReconciledEffort("high");
    });
    draftRouteRef.current = {
      providerId: "relay",
      modelId: "other-model",
      effort: "medium",
    };
    await act(async () => queueRef.current);

    expect(api.composerPrefsSet).not.toHaveBeenCalled();
  });

  it("keeps the visible pick unchanged and reports a failed save", async () => {
    vi.mocked(api.composerPrefsSet).mockRejectedValueOnce(new Error("disk"));
    const setEffort = vi.fn();
    const queueRef = { current: Promise.resolve() };
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useComposerEffort(
        hookOptions("session-a", setEffort, queueRef, showToast),
      ),
    );

    let writeResult: Promise<boolean> = Promise.resolve(false);
    act(() => {
      writeResult = result.current.handleEffortPick("high");
    });
    await act(async () => queueRef.current);

    await expect(writeResult!).resolves.toBe(false);
    expect(setEffort).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledOnce();
  });

  it("includes the picked route identity when saving a draft effort", async () => {
    const save = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet).mockReturnValue(save.promise);
    const queueRef = { current: Promise.resolve() };
    const { result } = renderHook(() =>
      useComposerEffort(
        hookOptions(null, vi.fn(), queueRef),
      ),
    );

    act(() => { void result.current.handleEffortPick("high"); });
    await act(async () => {
      save.resolve({
        modelId: "m-raw",
        effort: "high",
        mode: "agent",
        permissionPolicy: "ask",
        scope: "global",
        source: "global",
      });
      await queueRef.current;
    });

    expect(api.composerPrefsSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: null,
        providerId: "relay",
        modelId: "m-raw",
        effort: "high",
      }),
    );
  });

  it("does not apply a delayed pick to a draft with a different model", async () => {
    const save = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet).mockReturnValue(save.promise);
    const oldRoute: DraftComposerRoute = {
      providerId: "relay",
      modelId: "m-raw",
      effort: "low",
    };
    const draftRouteRef: { current: DraftComposerRoute | null } = {
      current: oldRoute,
    };
    const queueRef = { current: Promise.resolve() };
    const setEffort = vi.fn();
    const { result } = renderHook(() =>
      useComposerEffort(
        hookOptions(null, setEffort, queueRef, vi.fn(), draftRouteRef),
      ),
    );

    act(() => { void result.current.handleEffortPick("high"); });
    draftRouteRef.current = {
      providerId: "relay",
      modelId: "other-model",
      effort: "low",
    };
    await act(async () => {
      save.resolve({
        modelId: "m-raw",
        effort: "high",
        mode: "agent",
        permissionPolicy: "ask",
        scope: "global",
        source: "global",
      });
      await queueRef.current;
    });

    expect(setEffort).not.toHaveBeenCalled();
  });
});
