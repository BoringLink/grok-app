/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
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

  it("holds the pick while the provider catalog is loading", () => {
    const { setEffort, onReconcile } = renderOptions(null);

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
