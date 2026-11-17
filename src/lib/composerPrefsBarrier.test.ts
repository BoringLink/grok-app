import { describe, expect, it } from "vitest";
import {
  liveHostAfterProviderSwitch,
  queueComposerPreferenceApply,
  resolveComposerPrefsAfterBarrier,
} from "./composerPrefsBarrier";

describe("composer preference apply barrier", () => {
  it("holds the next send until the effort change is applied", async () => {
    let finishApply!: () => void;
    const applying = new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    const applied: string[] = [];
    const first = queueComposerPreferenceApply(
      Promise.resolve(),
      async () => {
        applied.push("high");
        await applying;
      },
      () => undefined,
    );
    const pending = queueComposerPreferenceApply(
      first,
      async () => {
        applied.push("xhigh");
      },
      () => undefined,
    );
    let sent = false;
    const send = pending.then(() => {
      sent = true;
    });

    await Promise.resolve();
    expect(sent).toBe(false);
    expect(applied).toEqual(["high"]);

    finishApply();
    await send;
    expect(sent).toBe(true);
    expect(applied).toEqual(["high", "xhigh"]);
  });

  it("drops a ready live host only when this chat switched provider", () => {
    const live = { sessionId: "s1", state: "ready", modelId: "grok-4.7" };
    expect(liveHostAfterProviderSwitch(live, "s1", true)).toEqual({
      sessionId: "s1",
      state: "disconnected",
      modelId: "grok-4.7",
    });
    expect(liveHostAfterProviderSwitch(live, "s1", false)).toBeNull();
    expect(
      liveHostAfterProviderSwitch(
        { sessionId: "s1", state: "streaming" },
        "s1",
        true,
      ),
    ).toBeNull();
    expect(
      liveHostAfterProviderSwitch(
        { sessionId: "other", state: "ready" },
        "s1",
        true,
      ),
    ).toBeNull();
  });
});

describe("composer prefs resolve barrier", () => {
  it("waits for writes and ignores a snapshot when a newer write starts", async () => {
    let currentBarrier = Promise.resolve();
    let finishResolve!: (value: string) => void;
    const resolve = () =>
      new Promise<string>((accept) => {
        finishResolve = accept;
      });
    const applied: string[] = [];
    const pending = resolveComposerPrefsAfterBarrier({
      barrier: currentBarrier,
      currentBarrier: () => currentBarrier,
      isActive: () => true,
      resolve,
      apply: (value) => applied.push(value),
      onError: () => undefined,
    });

    await Promise.resolve();
    currentBarrier = Promise.resolve();
    finishResolve("stale");
    await pending;

    expect(applied).toEqual([]);
  });

  it("routes resolve failures to the caller while its context remains active", async () => {
    const error = new Error("prefs unavailable");
    const errors: unknown[] = [];
    const barrier = Promise.resolve();

    await resolveComposerPrefsAfterBarrier({
      barrier,
      currentBarrier: () => barrier,
      isActive: () => true,
      resolve: async () => {
        throw error;
      },
      apply: () => undefined,
      onError: (value) => errors.push(value),
    });

    expect(errors).toEqual([error]);
  });
});

describe("reconcile and user effort writes share one queue", () => {
  it("lets a later user pick land after a slow reconcile write", async () => {
    let finishReconcile!: () => void;
    const writes: string[] = [];
    const reconcileGate = new Promise<void>((resolve) => {
      finishReconcile = resolve;
    });
    const reconcile = queueComposerPreferenceApply(
      Promise.resolve(),
      async () => {
        writes.push("reconcile:medium");
        await reconcileGate;
      },
      () => undefined,
    );
    const userPick = queueComposerPreferenceApply(
      reconcile,
      async () => {
        writes.push("user:high");
      },
      () => undefined,
    );

    await Promise.resolve();
    expect(writes).toEqual(["reconcile:medium"]);
    finishReconcile();
    await userPick;
    expect(writes).toEqual(["reconcile:medium", "user:high"]);
  });

  it("reports a failed reconcile and still runs the queued user pick", async () => {
    const errors: string[] = [];
    const writes: string[] = [];
    const reconcile = queueComposerPreferenceApply(
      Promise.resolve(),
      async () => {
        writes.push("reconcile");
        throw new Error("save failed");
      },
      (error) => errors.push(String(error)),
    );
    const userPick = queueComposerPreferenceApply(
      reconcile,
      async () => {
        writes.push("user");
      },
      (error) => errors.push(String(error)),
    );

    await userPick;
    expect(writes).toEqual(["reconcile", "user"]);
    expect(errors).toEqual(["Error: save failed"]);
  });
});
