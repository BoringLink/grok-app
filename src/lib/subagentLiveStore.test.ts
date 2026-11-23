import { afterEach, describe, expect, it } from "vitest";
import {
  applySubagentLivePayload,
  subagentLiveStore,
  SUBAGENT_LIVE_MAX_EVENTS,
  SUBAGENT_LIVE_MAX_TEXT_BYTES,
  SUBAGENT_LIVE_MAX_TOTAL_BYTES,
  SUBAGENT_LIVE_MAX_SESSION_CHARS,
  SUBAGENT_LIVE_MAX_SESSION_BYTES,
  SUBAGENT_LIVE_MAX_SESSIONS,
  SUBAGENT_LIVE_MAX_CHILDREN_PER_SESSION,
  type SubagentLiveChild,
} from "./subagentLiveStore";

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

  it("caps one event and the total child buffer by UTF-8 bytes, preserving newest text", () => {
    const oversized = "x".repeat(SUBAGENT_LIVE_MAX_TEXT_BYTES + 3);
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: oversized });
    let child: SubagentLiveChild | undefined = subagentLiveStore.list("parent-a")[0];
    expect(new TextEncoder().encode(child?.events[0]?.text ?? "").byteLength).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_TEXT_BYTES);
    expect(child?.events[0]?.text).toBe(oversized.slice(-16_000));
    expect(child?.truncated).toBe(true);

    Array.from({ length: 12 }, (_, index) =>
      subagentLiveStore.apply("parent-a", { childId: "child-2", kind: "assistant", text: "y".repeat(24_000) + index }),
    );
    child = subagentLiveStore.list("parent-a").find((entry) => entry.childId === "child-2");
    const storedBytes = (child?.events ?? []).reduce(
      (total, event) => total + new TextEncoder().encode(event.text).byteLength,
      0,
    );
    expect(storedBytes).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_TOTAL_BYTES);
    expect(child?.truncated).toBe(true);
    expect(child?.events.at(-1)?.text.endsWith("11")).toBe(true);
  });

  it("bounds UTF-8 payloads and aggregate activity across all children in one parent", () => {
    subagentLiveStore.apply("parent-a", { childId: "unicode", kind: "assistant", text: "界".repeat(20_000) });
    const unicodeEvent = subagentLiveStore.list("parent-a").find((child) => child.childId === "unicode")?.events[0];
    expect(Array.from(unicodeEvent?.text ?? "").length).toBeLessThanOrEqual(16_000);
    expect(new TextEncoder().encode(unicodeEvent?.text ?? "").byteLength).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_TEXT_BYTES);

    Array.from({ length: 12 }, (_, childIndex) => {
      Array.from({ length: 3 }, (_, eventIndex) =>
        subagentLiveStore.apply("parent-a", {
          childId: `child-${childIndex}`,
          kind: "assistant",
          text: `${String(childIndex)}${String(eventIndex)}`.padEnd(16_000, "z"),
        }),
      );
    });
    const children = subagentLiveStore.list("parent-a");
    const totals = children.flatMap((child) => child.events).reduce(
      (total, event) => ({
        chars: total.chars + Array.from(event.text).length,
        bytes: total.bytes + new TextEncoder().encode(event.text).byteLength,
      }),
      { chars: 0, bytes: 0 },
    );
    expect(totals.chars).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_SESSION_CHARS);
    expect(totals.bytes).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_SESSION_BYTES);
    expect(children.some((child) => child.truncated)).toBe(true);
  });

  it("bounds retained parent sessions and lifecycle child registries", () => {
    Array.from({ length: SUBAGENT_LIVE_MAX_SESSIONS }, (_, index) => {
      const sessionId = `parent-${index}`;
      subagentLiveStore.registerChild(sessionId, "child");
      subagentLiveStore.select(sessionId, "child");
    });
    subagentLiveStore.registerChild("newest-parent", "child");
    expect(subagentLiveStore.list("parent-0")).toEqual([]);
    expect(subagentLiveStore.selected("parent-0")).toBeNull();

    Array.from({ length: SUBAGENT_LIVE_MAX_CHILDREN_PER_SESSION + 1 }, (_, index) =>
      subagentLiveStore.registerChild("newest-parent", `child-${index}`),
    );
    const children = subagentLiveStore.list("newest-parent");
    expect(children).toHaveLength(SUBAGENT_LIVE_MAX_CHILDREN_PER_SESSION);
    expect(children.some((child) => child.childId === "child-0")).toBe(false);
    expect(children.at(-1)?.childId).toBe(`child-${SUBAGENT_LIVE_MAX_CHILDREN_PER_SESSION}`);
  });

  it("accepts only activity matching the parent lifecycle child-session association", () => {
    const validPayload = {
      sessionId: "parent-a",
      childId: "child-1",
      childSessionId: "agent-child-1",
      kind: "thought",
      text: "recognized child",
    };
    expect(applySubagentLivePayload(validPayload, "agent-other")).toBe(false);
    expect(applySubagentLivePayload(validPayload, undefined)).toBe(false);
    expect(applySubagentLivePayload({ ...validPayload, kind: "tool_call" }, "agent-child-1")).toBe(false);
    expect(applySubagentLivePayload(validPayload, "agent-child-1")).toBe(true);
    expect(subagentLiveStore.list("parent-a").map((child) => child.childId)).toEqual(["child-1"]);
    expect(subagentLiveStore.list("parent-b")).toEqual([]);
    expect(applySubagentLivePayload({ ...validPayload, truncated: true }, "agent-child-1")).toBe(true);
    expect(subagentLiveStore.list("parent-a")[0]?.truncated).toBe(true);
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
