/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { CustomProvider, ComposerPrefs } from "@/lib/api";
import type { DraftComposerRoute } from "@/lib/draftComposerRoute";
import { useSessionComposerEffort } from "./useSessionComposerEffort";

vi.mock("@/lib/api", () => ({
  composerPrefsSet: vi.fn(),
  isTauri: vi.fn(() => true),
}));

const provider: CustomProvider = {
  id: "relay",
  model: "m1",
  baseUrl: "https://relay.example/v1",
  name: "Relay",
  hasApiKey: true,
  apiBackend: "responses",
  providerMode: "generic",
  isDefault: false,
  models: [
    {
      id: "m1",
      name: "Model 1",
      supportsReasoningEffort: true,
      efforts: [{ id: "medium", name: "Medium", isDefault: true }],
    },
  ],
};

function renderEffortHooks(
  setEffort: (effort: string) => void,
  showToast: (message: string, ms?: number) => void,
) {
  const queueRef = { current: Promise.resolve() };
  const draftRouteRef: { current: DraftComposerRoute | null } = { current: null };
  const updateDraftEffort = vi.fn();
  const hook = renderHook(() =>
    useSessionComposerEffort({
      source: "custom",
      provider,
      modelId: "m1",
      officialModels: [],
      effort: "removed-tier",
      reconcileEnabled: true,
      setEffort,
      updateDraftEffort,
      draftRouteRef,
      projectId: "project-a",
      sessionId: "session-a",
      queueRef,
      showToast,
      translate: (key) => key,
    }),
  );
  return { ...hook, queueRef, updateDraftEffort };
}

function savedPrefs(effort = "medium"): ComposerPrefs {
  return {
    modelId: "m1",
    effort,
    mode: "agent",
    permissionPolicy: "ask",
    scope: "session",
    source: "session",
  };
}

describe("useSessionComposerEffort reconciliation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies the resolved default after a successful save", async () => {
    vi.mocked(api.composerPrefsSet).mockResolvedValue(savedPrefs());
    const setEffort = vi.fn();
    const showToast = vi.fn();
    const { result, queueRef, updateDraftEffort } = renderEffortHooks(
      setEffort,
      showToast,
    );

    await act(async () => queueRef.current);

    expect(result.current.options.map((option) => option.id)).toEqual([
      "medium",
    ]);
    expect(api.composerPrefsSet).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a", effort: "medium" }),
    );
    expect(setEffort).toHaveBeenCalledWith("medium");
    expect(updateDraftEffort).toHaveBeenCalledWith("session-a", "medium");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("does not let queued catalog reconciliation overwrite a newer user pick", async () => {
    const previousProvider: CustomProvider = {
      ...provider,
      models: [
        {
          id: "m1",
          name: "Model 1",
          supportsReasoningEffort: true,
          efforts: [{ id: "low", name: "Low" }],
        },
      ],
    };
    const refreshedProvider: CustomProvider = {
      ...provider,
      models: [
        {
          id: "m1",
          name: "Model 1",
          supportsReasoningEffort: true,
          efforts: [
            { id: "medium", name: "Medium", isDefault: true },
            { id: "high", name: "High" },
          ],
        },
      ],
    };
    let releaseQueue!: () => void;
    const queueRef = {
      current: new Promise<void>((resolve) => {
        releaseQueue = resolve;
      }),
    };
    const draftRouteRef: { current: DraftComposerRoute | null } = {
      current: null,
    };
    const setEffort = vi.fn();
    const showToast = vi.fn();
    vi.mocked(api.composerPrefsSet).mockResolvedValue(savedPrefs("high"));
    const { result, rerender } = renderHook(
      ({ selectedProvider }) =>
        useSessionComposerEffort({
          source: "custom",
          provider: selectedProvider,
          modelId: "m1",
          officialModels: [],
          effort: "low",
          reconcileEnabled: true,
          setEffort,
          updateDraftEffort: vi.fn(),
          draftRouteRef,
          projectId: "project-a",
          sessionId: "session-a",
          queueRef,
          showToast,
          translate: (key) => key,
        }),
      { initialProps: { selectedProvider: previousProvider } },
    );

    rerender({ selectedProvider: refreshedProvider });
    act(() => {
      void result.current.handleEffortPick("high");
    });
    await act(async () => {
      releaseQueue();
      await queueRef.current;
    });

    expect(api.composerPrefsSet).toHaveBeenCalledOnce();
    expect(api.composerPrefsSet).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a", effort: "high" }),
    );
    expect(setEffort).toHaveBeenCalledWith("high");
    expect(showToast).not.toHaveBeenCalled();
  });
});
