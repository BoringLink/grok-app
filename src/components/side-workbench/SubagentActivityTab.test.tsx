// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentActivityTab } from "./SubagentActivityTab";
import { subagentLiveStore } from "@/lib/subagentLiveStore";
import { subagentStore } from "@/lib/subagentStore";

afterEach(() => {
  cleanup();
  subagentLiveStore.resetForTests();
  subagentStore.resetForTests();
});

describe("SubagentActivityTab", () => {
  it("prefers running child, preserves ordered safe Markdown activity, and restores selection per session", () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "old", childSessionId: "agent-old", description: "older task" });
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "active", childSessionId: "agent-active", description: "active task" });
    subagentStore.apply({ sessionId: "parent-1", phase: "finished", subagentId: "old", status: "completed" });
    subagentLiveStore.apply("parent-1", { childId: "active", kind: "thought", text: "thinking" });
    subagentLiveStore.apply("parent-1", { childId: "active", kind: "assistant", text: "<img src=x onerror=alert(1)> safe" });

    const { rerender } = render(<SubagentActivityTab locale="en" sessionId="parent-1" />);

    expect(screen.getByRole("button", { name: /active task/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("thinking")).toBeTruthy();
    expect(screen.getByText(/safe/)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /older task/ }));
    expect(screen.getByRole("button", { name: /older task/ }).getAttribute("aria-pressed")).toBe("true");
    rerender(<SubagentActivityTab locale="en" sessionId="parent-2" />);
    expect(screen.getByText("No subagents in this session")).toBeTruthy();
    rerender(<SubagentActivityTab locale="en" sessionId="parent-1" />);
    expect(screen.getByRole("button", { name: /older task/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders tool updates as one ordered entry and shows final output fallback", () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "child", childSessionId: "agent-child" });
    subagentStore.apply({ sessionId: "parent-1", phase: "finished", subagentId: "child", output: "final answer" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "tool", text: "Run command", toolCallId: "tool-1", status: "in_progress", input: "untrusted input" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "tool", text: "Run command", toolCallId: "tool-1", status: "failed", output: "untrusted output" });

    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);

    expect(screen.getByText("Run command · failed")).toBeTruthy();
    expect(screen.getByText("untrusted input")).toBeTruthy();
    expect(screen.getByText("untrusted output")).toBeTruthy();
    expect(screen.getByText("final answer")).toBeTruthy();
  });

  it("does not repeat final output when partial assistant chunks are present", () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "child", childSessionId: "agent-child" });
    subagentStore.apply({ sessionId: "parent-1", phase: "finished", subagentId: "child", output: "partial live answer with final completion" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "assistant", text: "partial live answer" });

    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);

    expect(screen.getAllByText("partial live answer")).toHaveLength(1);
    expect(screen.queryByText("partial live answer with final completion")).toBeNull();
  });

  it("shows a localized trim marker when earlier activity was evicted", () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "child", childSessionId: "agent-child" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "assistant", text: "recent output" });
    for (let index = 0; index < 201; index += 1) {
      subagentLiveStore.apply("parent-1", { childId: "child", kind: "assistant", text: String(index), messageId: `message-${index}` });
    }

    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);
    expect(screen.getByRole("status").textContent).toBe("Earlier activity trimmed");
  });
});
