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
  SUBAGENT_LIVE_MAX_ID_CHARS,
  type SubagentLiveChild,
} from "./subagentLiveStore";

afterEach(() => subagentLiveStore.resetForTests());

describe("subagent live activity store", () => {
  it("keeps ordered activity isolated by parent session and child", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: "first" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "thinking" });
    subagentLiveStore.apply("parent-b", { childId: "child-1", kind: "assistant", text: "other chat" });

    expect(subagentLiveStore.list("parent-a")[0]?.events.map(({ text }) => text)).toEqual(["first", "thinking"]);
    expect(subagentLiveStore.list("parent-b")[0]?.events[0]?.text).toBe("other chat");
  });

  it("rejects malformed events and unknown child selections", () => {
    expect(subagentLiveStore.apply("parent-a", { childId: " ", kind: "thought", text: "ignored" })).toBe(false);
    expect(subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "" })).toBe(false);
    expect(subagentLiveStore.select("parent-a", "unknown")).toBe(false);
    expect(subagentLiveStore.list("parent-a")).toEqual([]);
  });

  it("retains only the newest bounded activity and marks truncation", () => {
    Array.from({ length: SUBAGENT_LIVE_MAX_EVENTS + 2 }, (_, index) =>
      subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: `${index}`, messageId: `message-${index}` }),
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

  it("aggregates id-less chunks across ignored metadata and groups chunks by messageId", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "one " });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "two" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: "reply", messageId: "message-1" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: " first", messageId: "message-2" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: " second", messageId: "message-1" });

    expect(subagentLiveStore.list("parent-a")[0]?.events.map(({ kind, text, messageId }) => ({ kind, text, messageId }))).toEqual([
      { kind: "thought", text: "one two", messageId: undefined },
      { kind: "assistant", text: "reply second", messageId: "message-1" },
      { kind: "assistant", text: " first", messageId: "message-2" },
    ]);
  });

  it("starts a new id-less message after a response boundary", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "first" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "boundary", text: "" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "second" });

    expect(subagentLiveStore.list("parent-a")[0]?.events.filter(({ kind }) => kind === "thought").map(({ text }) => text)).toEqual(["first", "second"]);
  });

  it("starts a new id-less text block after a sparse tool update", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "before" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "tool", text: "Run", toolCallId: "call" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "thought", text: "after" });

    expect(subagentLiveStore.list("parent-a")[0]?.events.filter(({ kind }) => kind === "thought").map(({ text }) => text)).toEqual(["before", "after"]);
  });

  it("keeps tools as boundaries and updates tool details by tool call id", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: "before" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "tool", text: "Run", toolCallId: "tool-1", status: "in_progress", input: JSON.stringify({ cmd: "ls" }) });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "tool", text: "Run", toolCallId: "tool-1", status: "failed", output: "failure" });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "assistant", text: "after" });

    const events = subagentLiveStore.list("parent-a")[0]?.events;
    expect(events?.filter(({ kind }) => kind !== "boundary").map(({ kind, text }) => [kind, text])).toEqual([
      ["assistant", "before"], ["tool", "Run"], ["assistant", "after"],
    ]);
    expect(events?.[1]).toMatchObject({ status: "failed", input: JSON.stringify({ cmd: "ls" }), output: "failure" });
  });

  it("preserves existing tool fields for sparse updates and treats null as absent", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "tool", text: "Run", toolCallId: "call", title: "Run", status: "running", input: "{\"cmd\":\"ls\"}", output: "first" });
    expect(applySubagentLivePayload({ sessionId: "parent-a", childId: "child-1", childSessionId: "agent-1", kind: "tool", text: "", toolCallId: "call", title: null, status: "", input: null, output: "" }, "agent-1")).toBe(true);

    expect(subagentLiveStore.list("parent-a")[0]?.events[0]).toMatchObject({
      title: "Run",
      status: "running",
      input: "{\"cmd\":\"ls\"}",
      output: "first",
    });
  });

  it("bounds the combined tool event budget across title, status, input, and output", () => {
    subagentLiveStore.apply("parent-a", {
      childId: "child-1", kind: "tool", text: "tool", toolCallId: "call",
      title: "t".repeat(SUBAGENT_LIVE_MAX_TEXT_BYTES),
      status: "s".repeat(SUBAGENT_LIVE_MAX_TEXT_BYTES),
      input: "i".repeat(SUBAGENT_LIVE_MAX_TEXT_BYTES),
      output: "o".repeat(SUBAGENT_LIVE_MAX_TEXT_BYTES),
    });
    const child = subagentLiveStore.list("parent-a")[0];
    const event = child?.events[0];
    const totalBytes = [event?.text, event?.title, event?.status, event?.input, event?.output]
      .reduce((total, value) => total + new TextEncoder().encode(value ?? "").byteLength, 0);

    expect(totalBytes).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_TEXT_BYTES);
    expect(Array.from([event?.text, event?.title, event?.status, event?.input, event?.output].join("")).length).toBeLessThanOrEqual(16_000);
    expect(child?.truncated).toBe(true);
  });

  it("enforces the single-event budget after merging sparse tool updates", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "tool", text: "tool", toolCallId: "call", title: "界".repeat(16_000) });
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "tool", text: "tool", toolCallId: "call", output: "界".repeat(16_000) });

    const child = subagentLiveStore.list("parent-a")[0];
    const event = child?.events.find(({ kind }) => kind === "tool");
    const bytes = [event?.text, event?.title, event?.status, event?.input, event?.output]
      .reduce((total, value) => total + new TextEncoder().encode(value ?? "").byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_TEXT_BYTES);
    expect(child?.truncated).toBe(true);
  });

  it("rejects identifiers that exceed the bounded key size", () => {
    const oversizedId = "x".repeat(SUBAGENT_LIVE_MAX_ID_CHARS + 1);
    expect(subagentLiveStore.registerChild(oversizedId, "child-1")).toBe(false);
    expect(subagentLiveStore.registerChild("parent-a", oversizedId)).toBe(false);
    expect(subagentLiveStore.apply("parent-a", { childId: oversizedId, kind: "thought", text: "text" })).toBe(false);
    expect(subagentLiveStore.apply(oversizedId, { childId: "child-1", kind: "thought", text: "text" })).toBe(false);
  });

  it("bounds tool payload fields under the same per-event text limit", () => {
    const toolOutput = "x".repeat(SUBAGENT_LIVE_MAX_TEXT_BYTES + 1);
    subagentLiveStore.apply("parent-a", { childId: "child-1", kind: "tool", text: "tool", toolCallId: "call", output: toolOutput });

    const event = subagentLiveStore.list("parent-a")[0]?.events[0];
    expect(new TextEncoder().encode(event?.output ?? "").byteLength).toBeLessThanOrEqual(SUBAGENT_LIVE_MAX_TEXT_BYTES);
    expect(subagentLiveStore.list("parent-a")[0]?.truncated).toBe(true);
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
    expect(applySubagentLivePayload({ ...validPayload, kind: "task" }, "agent-child-1")).toBe(false);
    expect(applySubagentLivePayload(validPayload, "agent-child-1")).toBe(true);
    expect(subagentLiveStore.list("parent-a").map((child) => child.childId)).toEqual(["child-1"]);
    expect(subagentLiveStore.list("parent-b")).toEqual([]);
    expect(applySubagentLivePayload({ ...validPayload, truncated: true }, "agent-child-1")).toBe(true);
    expect(subagentLiveStore.list("parent-a")[0]?.truncated).toBe(true);
  });

  it("remembers selections independently by parent session", () => {
    subagentLiveStore.apply("parent-a", { childId: "child-a", kind: "assistant", text: "reply-a" });
    subagentLiveStore.apply("parent-b", { childId: "child-b", kind: "assistant", text: "reply-b" });
    subagentLiveStore.select("parent-a", "child-a");
    subagentLiveStore.select("parent-b", "child-b");

    expect(subagentLiveStore.selected("parent-a")).toBe("child-a");
    expect(subagentLiveStore.selected("parent-b")).toBe("child-b");
  });
});
