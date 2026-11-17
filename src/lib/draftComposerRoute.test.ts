import { describe, expect, it, vi } from "vitest";
import {
  saveCurrentDraftComposerRoute,
  saveDraftComposerRoute,
  type DraftComposerRoute,
} from "./draftComposerRoute";

describe("saveDraftComposerRoute", () => {
  it("persists the selected provider/model and a nullable effort unchanged", async () => {
    const route: DraftComposerRoute = {
      providerId: "relay",
      modelId: "m-no-reasoning",
      effort: null,
    };
    const save = vi.fn(async () => undefined);

    const result = await saveDraftComposerRoute(route, save);

    expect(result).toEqual({ ok: true });
    expect(save).toHaveBeenCalledWith(route);
  });

  it("returns the save failure for the caller to report", async () => {
    const error = new Error("prefs write failed");
    const route: DraftComposerRoute = {
      providerId: "relay",
      modelId: "m1",
      effort: "max",
    };
    const save = vi.fn(async () => {
      throw error;
    });

    const result = await saveDraftComposerRoute(route, save);

    expect(result).toEqual({ ok: false, error });
  });
});

describe("saveCurrentDraftComposerRoute", () => {
  it("serially saves a replacement route created while an earlier write is pending", async () => {
    const first: DraftComposerRoute = {
      providerId: "relay",
      modelId: "m1",
      effort: "high",
    };
    const latest: DraftComposerRoute = {
      providerId: "relay",
      modelId: "m1",
      effort: "xhigh",
    };
    const writes: string[] = [];
    let current: DraftComposerRoute | null = first;

    const result = await saveCurrentDraftComposerRoute({
      currentRoute: () => current,
      save: async (route) => {
        writes.push(route.effort ?? "");
        if (route === first) current = latest;
      },
    });

    expect(writes).toEqual(["high", "xhigh"]);
    expect(result).toEqual({ status: "saved", routeIsCurrent: true });
  });

  it("treats freshly allocated equal route values as the same selection", async () => {
    const save = vi.fn(async () => undefined);
    const result = await saveCurrentDraftComposerRoute({
      currentRoute: () => ({
        providerId: "relay",
        modelId: "m1",
        effort: "medium",
      }),
      save,
    });

    expect(result).toEqual({ status: "saved", routeIsCurrent: true });
    expect(save).toHaveBeenCalledOnce();
  });

  it("returns a current-route error so connect can show it to the user", async () => {
    const route: DraftComposerRoute = {
      providerId: "relay",
      modelId: "m1",
      effort: null,
    };
    const error = new Error("prefs write failed");

    const result = await saveCurrentDraftComposerRoute({
      currentRoute: () => route,
      save: async () => {
        throw error;
      },
    });

    expect(result).toEqual({
      status: "failed",
      routeIsCurrent: true,
      error,
    });
  });
});
