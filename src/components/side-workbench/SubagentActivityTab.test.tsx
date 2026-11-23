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

  it("shows a localized trim marker when earlier activity was evicted", () => {
    subagentStore.apply({ sessionId: "parent-1", phase: "spawned", subagentId: "child", childSessionId: "agent-child" });
    subagentLiveStore.apply("parent-1", { childId: "child", kind: "assistant", text: "recent output" });
    for (let index = 0; index < 201; index += 1) {
      subagentLiveStore.apply("parent-1", { childId: "child", kind: "assistant", text: String(index) });
    }

    render(<SubagentActivityTab locale="en" sessionId="parent-1" />);
    expect(screen.getByRole("status").textContent).toBe("Earlier activity trimmed");
  });
});
