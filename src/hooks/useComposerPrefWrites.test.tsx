/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { ComposerPrefs } from "@/lib/api";
import type { MessageKey } from "@/i18n";
import { useComposerPrefWrites } from "./useComposerPrefWrites";

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

function prefs(mode: string, permissionPolicy: string): ComposerPrefs {
  return {
    modelId: "m1",
    effort: "medium",
    mode,
    permissionPolicy,
    scope: "session",
    source: "session",
  };
}

function mountWrites(
  setMode = vi.fn(),
  setPolicy = vi.fn(),
  sessionId: string | null = "session-a",
  projectId: string | null | undefined = "project-a",
  mode = "agent",
) {
  const queueRef = { current: Promise.resolve() };
  const showToast = vi.fn();
  const translate = (key: MessageKey) => key;
  const hook = renderHook(() =>
    useComposerPrefWrites({
      projectId,
      sessionId,
      mode,
      queueRef,
      setMode,
      setPolicy,
      showToast,
      translate,
    }),
  );
  return { ...hook, queueRef, showToast, setMode, setPolicy };
}

describe("useComposerPrefWrites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.isTauri).mockReturnValue(true);
  });

  it("keeps a transient plan selection after the Host saves the default mode", async () => {
    const save = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet).mockReturnValue(save.promise);
    const setMode = vi.fn();
    const { result, queueRef } = mountWrites(setMode);

    act(() => result.current.persistMode("plan"));
    expect(setMode).not.toHaveBeenCalled();
    await act(async () => {
      save.resolve(prefs("agent", "ask"));
      await queueRef.current;
    });

    expect(api.composerPrefsSet).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a", mode: "plan" }),
    );
    expect(setMode).toHaveBeenCalledWith("plan");
  });

  it("applies a saved preference when projectId is absent", async () => {
    vi.mocked(api.composerPrefsSet).mockResolvedValue(prefs("ask", "ask"));
    const setMode = vi.fn();
    const { result, queueRef } = mountWrites(setMode, vi.fn(), null, undefined);

    act(() => result.current.persistMode("ask"));
    await act(async () => queueRef.current);

    expect(setMode).toHaveBeenCalledWith("ask");
  });

  it("retains a saved draft mode across prefs refreshes and clears it on session materialization", async () => {
    vi.mocked(api.composerPrefsSet).mockResolvedValue(prefs("agent", "ask"));
    const queueRef = { current: Promise.resolve() };
    const setMode = vi.fn();
    const setPolicy = vi.fn();
    const showToast = vi.fn();
    const translate = (key: MessageKey) => key;
    const initialProps: { sessionId: string | null } = { sessionId: null };
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useComposerPrefWrites({
          projectId: undefined,
          sessionId,
          mode: "ask",
          setMode,
          setPolicy,
          queueRef,
          showToast,
          translate,
        }),
      { initialProps },
    );

    act(() => result.current.persistMode("plan"));
    await act(async () => queueRef.current);

    expect(result.current.draftModeRef.current).toBe("plan");
    act(() => result.current.resetDraftMode());
    expect(result.current.draftModeRef.current).toBeNull();
    expect(setMode).toHaveBeenCalledWith("ask");
    act(() => result.current.persistMode("plan"));
    await act(async () => queueRef.current);
    expect(result.current.draftModeRef.current).toBe("plan");

    rerender({ sessionId: "session-new" });
    expect(result.current.draftModeRef.current).toBeNull();
  });

  it("clears a saved session's transient Plan before opening a new chat", () => {
    const setMode = vi.fn();
    const { result } = mountWrites(setMode, vi.fn(), "session-a", "project-a", "plan");

    act(() => result.current.resetDraftMode());

    expect(setMode).toHaveBeenCalledWith("agent");
    expect(result.current.draftModeRef.current).toBeNull();
  });

  it("ignores a pending draft mode write after a new-chat reset", async () => {
    const save = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet).mockReturnValue(save.promise);
    const setMode = vi.fn();
    const { result, queueRef } = mountWrites(setMode, vi.fn(), null, undefined, "ask");

    act(() => result.current.persistMode("plan"));
    act(() => result.current.resetDraftMode());
    expect(setMode).toHaveBeenCalledWith("ask");

    await act(async () => {
      save.resolve(prefs("agent", "ask"));
      await queueRef.current;
    });

    expect(setMode).toHaveBeenCalledTimes(1);
    expect(result.current.draftModeRef.current).toBeNull();
  });

  it("does not restore a queued draft mode after switching projects away and back", async () => {
    const save = deferred<ComposerPrefs>();
    vi.mocked(api.composerPrefsSet).mockReturnValue(save.promise);
    const queueRef = { current: Promise.resolve() };
    const setMode = vi.fn();
    const setPolicy = vi.fn();
    const showToast = vi.fn();
    const translate = (key: MessageKey) => key;
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useComposerPrefWrites({
          projectId,
          sessionId: null,
          mode: "agent",
          queueRef,
          setMode,
          setPolicy,
          showToast,
          translate,
        }),
      { initialProps: { projectId: "project-a" } },
    );

    act(() => result.current.persistMode("plan"));
    rerender({ projectId: "project-b" });
    rerender({ projectId: "project-a" });
    expect(result.current.draftModeRef.current).toBeNull();

    await act(async () => {
      save.resolve(prefs("agent", "ask"));
      await queueRef.current;
    });

    expect(api.composerPrefsSet).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-a", mode: "plan" }),
    );
    expect(result.current.draftModeRef.current).toBeNull();
    expect(setMode).not.toHaveBeenCalled();
  });

  it("uses the Host-effective policy returned by a successful save", async () => {
    vi.mocked(api.composerPrefsSet).mockResolvedValue(prefs("agent", "ask"));
    const setPolicy = vi.fn();
    const { result, queueRef } = mountWrites(vi.fn(), setPolicy);

    act(() => result.current.persistPolicy("always_approve"));
    await act(async () => queueRef.current);

    expect(api.composerPrefsSet).toHaveBeenCalledWith(
      expect.objectContaining({ permissionPolicy: "always_approve" }),
    );
    expect(setPolicy).toHaveBeenCalledWith("ask");
  });

  it("uses the Host-effective policy for a draft scope", async () => {
    vi.mocked(api.composerPrefsSet).mockResolvedValue(prefs("agent", "ask"));
    const setPolicy = vi.fn();
    const { result, queueRef } = mountWrites(vi.fn(), setPolicy, null);

    act(() => result.current.persistPolicy("always_approve"));
    await act(async () => queueRef.current);

    expect(setPolicy).toHaveBeenCalledWith("ask");
  });

  it("keeps policy unchanged and reports a failed write", async () => {
    vi.mocked(api.composerPrefsSet).mockRejectedValueOnce(new Error("disk"));
    const setPolicy = vi.fn();
    const { result, queueRef, showToast } = mountWrites(vi.fn(), setPolicy);

    act(() => result.current.persistPolicy("always_approve"));
    await act(async () => queueRef.current);

    expect(setPolicy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "error.deck.generic.problem",
      4000,
    );
  });

  it("keeps a draft policy unchanged when its save fails", async () => {
    vi.mocked(api.composerPrefsSet).mockRejectedValueOnce(new Error("disk"));
    const setPolicy = vi.fn();
    const { result, queueRef } = mountWrites(vi.fn(), setPolicy, null);

    act(() => result.current.persistPolicy("always_approve"));
    await act(async () => queueRef.current);

    expect(setPolicy).not.toHaveBeenCalled();
  });

  it("updates local state in browser preview without a Host write", () => {
    vi.mocked(api.isTauri).mockReturnValue(false);
    const setMode = vi.fn();
    const { result } = mountWrites(setMode);

    act(() => result.current.persistMode("plan"));

    expect(setMode).toHaveBeenCalledWith("plan");
    expect(api.composerPrefsSet).not.toHaveBeenCalled();
  });
});
