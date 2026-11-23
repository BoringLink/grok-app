import { afterEach, describe, expect, it } from "vitest";
import { subagentLiveStore, SUBAGENT_LIVE_MAX_EVENTS } from "./subagentLiveStore";

afterEach(() => subagentLiveStore.resetForTests());

describe("subagent live activity store", () => {
  it("keeps ordered activity isolated by parent session and child", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "task", text: "task" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "thinking" });
    subagentLiveStore.apply("parent-b", { childId: "child-1", kind: "assistant", text: "other chat" });

    expect(subagentLiveStore.list("parent-a")[0]?.events.map(({ text }) => text)).toEqual(["task", "thinking"]);
    expect(subagentLiveStore.list("parent-b")[0]?.events[0]?.text).toBe("other chat");
  });

  it("rejects malformed events and unknown child selections", () => {
    expect(subagentLiveStore.apply("parent-a", { childId: " ", kind: "task", text: "ignored" })).toBe(false);
    expect(subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "task", text: "" })).toBe(false);
    expect(subagentLiveStore.select("parent-a", "unknown")).toBe(false);
    expect(subagentLiveStore.list("parent-a")).toEqual([]);
  });

  it("retains only the newest bounded activity and marks truncation", () => {
    Array.from({ length: SUBAGENT_LIVE_MAX_EVENTS + 2 }, (_, index) =>
      subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: `${index}` }),
    );

    const child = subagentLiveStore.list("parent-a")[0];
    expect(child?.events).toHaveLength(SUBAGENT_LIVE_MAX_EVENTS);
    expect(child?.events[0]?.text).toBe("2");
    expect(child?.truncated).toBe(true);
  });

  it("remembers selections independently by parent session", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-a", kind: "task", text: "task" });
    subagentLiveStore.apply("parent-b", { childId: "child-b", kind: "task", text: "task" });
    subagentLiveStore.select("parent-a", "child-a");
    subagentLiveStore.select("parent-b", "child-b");

    expect(subagentLiveStore.selected("parent-a")).toBe("child-a");
    expect(subagentLiveStore.selected("parent-b")).toBe("child-b");
  });
});
