import { describe, expect, it } from "vitest";
import {
  disconnectedQueueKeys,
  isBackgroundQueuedSend,
  planBackgroundQueueDrain,
  queueHoldKeysToRelease,
  type QueueDrainPlanInput,
} from "@/lib/backgroundQueueDrain";
import { makeQueuedSend, setQueueForKey, type QueuedSend } from "@/lib/sendQueue";

function item(id: string, source?: QueuedSend["source"]): QueuedSend {
  return makeQueuedSend({
    id,
    storedDisplay: id,
    attachments: [],
    goalMode: false,
    now: 1,
    source,
  });
}

function plan(
  patch: Partial<QueueDrainPlanInput> &
    Pick<QueueDrainPlanInput, "byKey" | "stateByKey">,
): string[] {
  return planBackgroundQueueDrain({
    viewedKey: "view",
    inFlightKeys: new Set(),
    connectingKeys: new Set(),
    holdKeys: new Set(),
    drainingKeys: new Set(),
    liveSessionId: "view",
    liveState: "ready",
    ...patch,
  });
}

describe("planBackgroundQueueDrain", () => {
  it("drains every ready session, including ones that are not on screen", () => {
    const byKey = setQueueForKey(
      setQueueForKey({}, "a", [item("a1")]),
      "b",
      [item("b1"), item("b2")],
    );
    expect(
      plan({
        byKey,
        stateByKey: { a: "ready", b: "ready", view: "streaming" },
        viewedKey: "view",
      }),
    ).toEqual(["a", "b"]);
  });

  it("waits while that session is streaming and sends after it is ready", () => {
    const byKey = setQueueForKey(
      setQueueForKey({}, "a", [item("a1")]),
      "b",
      [item("b1")],
    );
    expect(
      plan({
        byKey,
        stateByKey: { a: "streaming", b: "ready" },
      }),
    ).toEqual(["b"]);
    expect(
      plan({
        byKey,
        stateByKey: { a: "ready", b: "ready" },
      }),
    ).toEqual(["a", "b"]);
  });

  it("a held or in-flight session does not block the others", () => {
    const byKey = setQueueForKey(
      setQueueForKey({}, "a", [item("a1")]),
      "b",
      [item("b1")],
    );
    expect(
      plan({
        byKey,
        stateByKey: { a: "ready", b: "ready" },
        holdKeys: new Set(["a"]),
      }),
    ).toEqual(["b"]);
    expect(
      plan({
        byKey,
        stateByKey: { a: "ready", b: "ready" },
        inFlightKeys: new Set(["b"]),
        drainingKeys: new Set(["a"]),
      }),
    ).toEqual([]);
  });

  it("does not plan the same key twice and skips external heads", () => {
    const byKey = setQueueForKey({}, "a", [
      item("ext", "external"),
      item("a1"),
    ]);
    expect(
      plan({
        byKey,
        stateByKey: { a: "idle" },
      }),
    ).toEqual([]);
    const composer = setQueueForKey({}, "a", [item("a1"), item("a2")]);
    expect(
      plan({
        byKey: composer,
        stateByKey: { a: "ready" },
      }),
    ).toEqual(["a"]);
  });

  it("drains a draft only while that draft is on screen", () => {
    const byKey = setQueueForKey({}, "__draft__", [item("d1")]);
    expect(
      plan({
        byKey,
        stateByKey: { __draft__: "idle" },
        viewedKey: "a",
      }),
    ).toEqual([]);
    expect(
      plan({
        byKey,
        stateByKey: { __draft__: "idle" },
        viewedKey: "__draft__",
        liveSessionId: null,
        liveState: "idle",
      }),
    ).toEqual(["__draft__"]);
  });

  it("does not drain the live session while that same chat is busy", () => {
    const byKey = setQueueForKey({}, "a", [item("a1")]);
    expect(
      plan({
        byKey,
        stateByKey: { a: "ready" },
        liveSessionId: "a",
        liveState: "streaming",
      }),
    ).toEqual([]);
  });
});

describe("queue failure isolation helpers", () => {
  it("lists disconnected sessions and leaves a steady ready hold in place", () => {
    const byKey = setQueueForKey(
      setQueueForKey({}, "a", [item("a1")]),
      "b",
      [item("b1")],
    );
    expect(
      disconnectedQueueKeys(byKey, { a: "disconnected", b: "ready" }),
    ).toEqual(["a"]);
    expect(
      queueHoldKeysToRelease({
        prev: { a: "ready", b: "streaming" },
        next: { a: "ready", b: "ready" },
        holdKeys: new Set(["a", "b"]),
      }),
    ).toEqual(["b"]);
  });
});

describe("isBackgroundQueuedSend", () => {
  it("is a queued send whose target is not the chat on screen", () => {
    expect(
      isBackgroundQueuedSend({
        fromQueue: true,
        targetSessionId: "b",
        viewingSessionId: "a",
      }),
    ).toBe(true);
    expect(
      isBackgroundQueuedSend({
        fromQueue: true,
        targetSessionId: "a",
        viewingSessionId: "a",
      }),
    ).toBe(false);
    expect(
      isBackgroundQueuedSend({
        fromQueue: false,
        targetSessionId: "b",
        viewingSessionId: "a",
      }),
    ).toBe(false);
    expect(
      isBackgroundQueuedSend({
        fromQueue: true,
        targetSessionId: null,
        viewingSessionId: null,
      }),
    ).toBe(false);
  });
});
