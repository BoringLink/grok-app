/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessionEffortOptions } from "./useSessionEffortOptions";
import type { CustomProvider } from "@/lib/api";

const baseProvider: CustomProvider = {
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
      name: "M1",
      supportsReasoningEffort: true,
      efforts: [
        { id: "low", name: "low" },
        { id: "medium", name: "medium", isDefault: true },
      ],
    },
  ],
};

function renderOptions(provider: CustomProvider | null, effort = "low") {
  const setEffort = vi.fn();
  const onReconcile = vi.fn();
  const hook = renderHook(() =>
    useSessionEffortOptions({
      source: "custom",
      provider,
      modelId: "m1",
      officialModels: [],
      effort,
      setEffort,
      onReconcile,
    }),
  );
  return { ...hook, setEffort, onReconcile };
}

describe("useSessionEffortOptions", () => {
  it("does not reconcile a valid stored pick", () => {
    const { setEffort, onReconcile } = renderOptions(baseProvider);

    expect(setEffort).not.toHaveBeenCalled();
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("waits for the session prefs restore before reconciling a stored pick", () => {
    const setEffort = vi.fn();
    const onReconcile = vi.fn(async () => true);

    renderHook(() =>
      useSessionEffortOptions({
        source: "custom",
        provider: baseProvider,
        modelId: "m1",
        officialModels: [],
        effort: "removed-tier",
        reconcileEnabled: false,
        setEffort,
        onReconcile,
      }),
    );

    expect(setEffort).not.toHaveBeenCalled();
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("moves to the model default and persists it when metadata changes", () => {
    const setEffort = vi.fn();
    const onReconcile = vi.fn();
    const { rerender } = renderHook(
      ({ provider }: { provider: CustomProvider }) =>
        useSessionEffortOptions({
          source: "custom",
          provider,
          modelId: "m1",
          officialModels: [],
          effort: "low",
          setEffort,
          onReconcile,
        }),
      { initialProps: { provider: baseProvider } },
    );

    // Arrange — the stored low id disappears from the model's ladder
    const changed: CustomProvider = {
      ...baseProvider,
      models: [
        {
          id: "m1",
          name: "M1",
          supportsReasoningEffort: true,
          efforts: [
            { id: "medium", name: "medium", isDefault: true },
            { id: "high", name: "high" },
          ],
        },
      ],
    };
    rerender({ provider: changed });

    // Assert — default is applied and persisted for the next spawn
    expect(setEffort).toHaveBeenCalledWith("medium");
    expect(onReconcile).toHaveBeenCalledWith("medium");
  });

  it("keeps the stored pick when persisting a reconciled default fails", async () => {
    const setEffort = vi.fn();
    const provider: CustomProvider = {
      ...baseProvider,
      models: [
        {
          id: "m1",
          name: "M1",
          supportsReasoningEffort: true,
          efforts: [{ id: "medium", name: "medium", isDefault: true }],
        },
      ],
    };
    const onReconcile = vi.fn(async () => false);

    renderHook(() =>
      useSessionEffortOptions({
        source: "custom",
        provider,
        modelId: "m1",
        officialModels: [],
        effort: "low",
        setEffort,
        onReconcile,
      }),
    );
    await act(async () => Promise.resolve());

    expect(onReconcile).toHaveBeenCalledWith("medium");
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("reports synchronous reconciliation failures to the composer", () => {
    const onReconcileError = vi.fn();
    const error = new Error("write failed");

    renderHook(() =>
      useSessionEffortOptions({
        source: "custom",
        provider: {
          ...baseProvider,
          models: [
            {
              id: "m1",
              name: "M1",
              supportsReasoningEffort: true,
              efforts: [{ id: "medium", name: "medium", isDefault: true }],
            },
          ],
        },
        modelId: "m1",
        officialModels: [],
        effort: "removed-tier",
        setEffort: vi.fn(),
        onReconcile: () => {
          throw error;
        },
        onReconcileError,
      }),
    );

    expect(onReconcileError).toHaveBeenCalledWith(error);
  });

  it("holds the pick while the provider catalog is loading", () => {
    const { setEffort, onReconcile } = renderOptions(null);

    expect(setEffort).not.toHaveBeenCalled();
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("does not reconcile or persist when a model flips to unsupported", () => {
    const setEffort = vi.fn();
    const onReconcile = vi.fn();
    const supported: CustomProvider = {
      ...baseProvider,
      models: [
        {
          id: "m1",
          name: "M1",
          supportsReasoningEffort: true,
          efforts: [
            { id: "low", name: "low" },
            { id: "medium", name: "medium", isDefault: true },
          ],
        },
      ],
    };
    const unsupported: CustomProvider = {
      ...baseProvider,
      models: [
        {
          id: "m1",
          name: "M1",
          supportsReasoningEffort: false,
          efforts: [{ id: "low", name: "low" }],
        },
      ],
    };
    const { rerender } = renderHook(
      ({ provider }: { provider: CustomProvider }) =>
        useSessionEffortOptions({
          source: "custom",
          provider,
          modelId: "m1",
          officialModels: [],
          effort: "low",
          setEffort,
          onReconcile,
        }),
      { initialProps: { provider: supported } },
    );

    rerender({ provider: unsupported });

    expect(setEffort).not.toHaveBeenCalled();
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("holds the pick when the model rejects reasoning effort", () => {
    const noThink: CustomProvider = {
      ...baseProvider,
      models: [
        {
          id: "m1",
          name: "M1",
          supportsReasoningEffort: false,
          efforts: [{ id: "low", name: "low" }],
        },
      ],
    };
    const { setEffort, onReconcile } = renderOptions(noThink);

    expect(setEffort).not.toHaveBeenCalled();
    expect(onReconcile).not.toHaveBeenCalled();
  });
});
