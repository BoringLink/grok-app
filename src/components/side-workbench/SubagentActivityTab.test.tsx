// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@/test/jsdomStubs";
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
    const output = document.querySelector(".subagent-activity__stream")!;
    expect(output.querySelector(".subagent-activity__title")).toBeNull();
    expect(output.querySelector(".subagent-activity__child-status")).toBeNull();
    expect(output.querySelector(".subagent-activity__prompt-banner")).toBeNull();
    expect(output.textContent).not.toContain("active task");
    expect(document.querySelector(".grok-thought")).toBeTruthy();
    expect(document.querySelector(".grok-thought")?.getAttribute("data-expanded")).toBe("0");
    fireEvent.click(document.querySelector(".grok-thought__header")!);
    expect(screen.getByText("thinking")).toBeTruthy();
    expect(document.querySelector(".lobe-chat-item--assistant")).toBeTruthy();
    expect(screen.getByText(/safe/)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /older task/ }));
    expect(screen.getByRole("button", { name: /older task/ }).getAttribute("aria-pressed")).toBe("true");
    rerender(<SubagentActivityTab locale="en" sessionId="parent-2" />);
    expect(screen.getByText("No subagents in this session")).toBeTruthy();
    rerender(<SubagentActivityTab locale="en" sessionId="parent-1" />);
    expect(screen.getByRole("button", { name: /older task/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not render the lifecycle description as a dispatched prompt", () => {
    subagentStore.apply({
      sessionId: "parent-1",
      phase: "spawned",
      subagentId: "child",
      childSessionId: "agent-child",
      description: "Inspect package.json.\n\nCover:\n\n1. Explain the required fields.",
    });

    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);

    const output = document.querySelector(".subagent-activity__stream");
    expect(output?.querySelector(".subagent-activity__prompt-banner")).toBeNull();
    expect(output?.textContent).not.toContain("Inspect package.json.");
    expect(output?.textContent).not.toContain("Explain the required fields.");
    expect(output?.textContent).not.toContain("Cover:");
    expect(screen.queryByText("tasks.subagentActivityTask")).toBeNull();
    expect(screen.getByText("No activity yet")).toBeTruthy();
  });

  it("renders tool updates as one ordered entry and shows final output fallback", () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "child", childSessionId: "agent-child" });
    subagentStore.apply({ sessionId: "parent-1", phase: "finished", subagentId: "child", output: "final answer" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "tool", text: "Run command", toolCallId: "tool-1", status: "in_progress", input: "untrusted input" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "tool", text: "Run command", toolCallId: "tool-1", status: "failed", output: "untrusted output" });

    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);

    const toolRow = document.querySelector("[data-testid='timeline-tool']");
    expect(toolRow?.getAttribute("data-expanded")).toBe("0");
    fireEvent.click(document.querySelector(".grok-act__step-btn")!);
    expect(document.querySelector(".lobe-timeline-tool__cmd")?.textContent).toContain("untrusted input");
    expect(document.querySelector("[data-testid='tool-output']")?.textContent).toContain("untrusted output");
    expect(screen.getByText("final answer")).toBeTruthy();
  });

  it("keeps thoughts live and folds a completed tool phase into the work summary", async () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "child", childSessionId: "agent-child" });
    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "thought", text: "live reasoning" });
    await waitFor(() => expect(document.querySelector(".grok-thought")?.getAttribute("data-expanded")).toBe("1"));

    subagentLiveStore.apply("parent-1", { childId: "child", kind: "boundary", text: "" });
    await waitFor(() => expect(document.querySelector(".grok-thought")?.getAttribute("data-expanded")).toBe("0"));

    subagentLiveStore.apply("parent-1", {
      childId: "child", kind: "tool", text: "Read file", toolCallId: "read-1",
      status: "in_progress", input: "package.json", output: "{\"name\":\"demo\"}",
    });
    await waitFor(() => expect(document.querySelector("[data-testid='timeline-phase']")?.getAttribute("data-expanded")).toBe("1"));
    await waitFor(() => expect(document.querySelector("[data-step-type='tool']")?.getAttribute("data-expanded")).toBe("0"));

    subagentLiveStore.apply("parent-1", {
      childId: "child", kind: "tool", text: "Read file", toolCallId: "read-1",
      status: "completed", output: "{\"name\":\"demo\"}",
    });
    await waitFor(() => expect(document.querySelector("[data-testid='timeline-phase']")?.getAttribute("data-expanded")).toBe("0"));
    expect(document.querySelector("[data-step-type='tool']")).toBeNull();
    fireEvent.click(document.querySelector("[data-testid='timeline-phase'] .grok-act__header")!);
    await waitFor(() => expect(document.querySelector("[data-step-type='tool']")?.getAttribute("data-expanded")).toBe("0"));
    fireEvent.click(document.querySelector("[data-step-type='tool'] .grok-act__step-btn")!);
    expect(document.querySelector("[data-testid='tool-output']")?.textContent).toContain("demo");
  });

  it("collects tools from consecutive thought phases into one work block", async () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "child", childSessionId: "agent-child" });
    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);

    subagentLiveStore.apply("parent-1", { childId: "child", kind: "thought", text: "first reasoning" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "tool", text: "Read one", toolCallId: "read-1", status: "completed", input: "one", output: "one" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "thought", text: "second reasoning" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "tool", text: "Read two", toolCallId: "read-2", status: "completed", input: "two", output: "two" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "thought", text: "current reasoning" });

    await waitFor(() => expect(document.querySelectorAll("[data-testid='timeline-phase']")).toHaveLength(1));
    const phase = document.querySelector("[data-testid='timeline-phase']")!;
    expect(phase.getAttribute("data-expanded")).toBe("0");
    expect(phase.querySelector(".grok-act__header")?.textContent).toContain("Worked");
    expect(document.querySelectorAll("[data-step-type='tool']")).toHaveLength(0);
    fireEvent.click(phase.querySelector(".grok-act__header")!);
    await waitFor(() => expect(document.querySelectorAll("[data-step-type='tool']")).toHaveLength(2));
    const toolRows = document.querySelectorAll("[data-step-type='tool']");
    expect(toolRows).toHaveLength(2);
    expect([...toolRows].map((row) => row.getAttribute("data-expanded"))).toEqual(["0", "0"]);
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
