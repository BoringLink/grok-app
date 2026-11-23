// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentSection } from "./AgentTasksPanelSubagents";
import { subscribeSubagentViewerRequests } from "@/lib/subagentViewerRequest";
import { subagentLiveStore } from "@/lib/subagentLiveStore";
import type { SubagentRun } from "@/lib/session/subagents";

const run: SubagentRun = {
  subagentId: "child-1",
  childSessionId: "agent-child-1",
  finished: false,
  subagentType: null,
  description: "delegated work",
  status: null,
  output: null,
};

const translate = (key: string) => key;

afterEach(() => {
  cleanup();
  subagentLiveStore.resetForTests();
});

describe("SubagentSection viewer entry", () => {
  it("opens the selected child from the action without changing row expansion", () => {
    const requests: Array<{ sessionId: string; childId: string }> = [];
    const unsubscribe = subscribeSubagentViewerRequests("parent-1", (request) => requests.push(request));
    const { container } = render(
      <SubagentSection runs={[{ ...run, finished: true, output: "answer" }]} t={translate} locale="en" sessionId="parent-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "tasks.subagentView" }));

    expect(requests).toEqual([{ sessionId: "parent-1", childId: "child-1" }]);
    expect(screen.queryByText("tasks.subagentOutput")).toBeNull();
    expect(container.querySelector(".agent-tasks__row-toggle")?.getAttribute("aria-expanded")).toBe("false");
    unsubscribe();
  });

  it("expands identity details on row click without showing final output; double-click opens the same child", () => {
    const requests: Array<{ sessionId: string; childId: string }> = [];
    const unsubscribe = subscribeSubagentViewerRequests("parent-1", (request) => requests.push(request));
    const { container } = render(
      <SubagentSection
        runs={[{ ...run, finished: true, output: "answer", model: "grok-4", agentAddress: "worker@local" }]}
        t={translate}
        locale="en"
        sessionId="parent-1"
      />,
    );
    const toggle = screen.getByRole("button", { name: "tasks.expand" });
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("agent-child-1")).toBeTruthy();
    expect(screen.getByText("grok-4")).toBeTruthy();
    expect(screen.getByText("worker@local")).toBeTruthy();
    expect(screen.getByText("tasks.subagentAgentAddress")).toBeTruthy();
    expect(screen.queryByText("answer")).toBeNull();
    expect(screen.queryByText("tasks.subagentOutput")).toBeNull();
    fireEvent.doubleClick(container.querySelector("li")!);

    expect(requests).toEqual([{ sessionId: "parent-1", childId: "child-1" }]);
    unsubscribe();
  });

  it("keeps double-click as a viewer action without expanding inline details", () => {
    const requests: Array<{ sessionId: string; childId: string }> = [];
    const unsubscribe = subscribeSubagentViewerRequests("parent-1", (request) => requests.push(request));
    const { container } = render(<SubagentSection runs={[run]} t={translate} locale="en" sessionId="parent-1" />);

    fireEvent.doubleClick(container.querySelector("li")!);

    expect(requests).toEqual([{ sessionId: "parent-1", childId: "child-1" }]);
    expect(container.querySelector(".agent-tasks__row-toggle")?.getAttribute("aria-expanded")).toBe("false");
    unsubscribe();
  });

  it("omits absent identity fields while keeping the child id available", () => {
    render(<SubagentSection runs={[{ ...run, description: null, childSessionId: null }]} t={translate} locale="en" sessionId="parent-1" />);
    fireEvent.click(screen.getByRole("button", { name: "tasks.expand" }));
    expect(screen.queryByText("grok-4")).toBeNull();
    expect(screen.queryByText("worker@local")).toBeNull();
    expect(screen.queryByText("agent-child-1")).toBeNull();
    expect(screen.getByText("child-1")).toBeTruthy();
  });

  it("copies the child session id", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SubagentSection runs={[run]} t={translate} locale="en" sessionId="parent-1" />);
    fireEvent.click(screen.getByRole("button", { name: "tasks.expand" }));
    fireEvent.click(screen.getByRole("button", { name: "message.copy" }));
    expect(writeText).toHaveBeenCalledWith("agent-child-1");
  });

  it("does not open when there is no parent App session", () => {
    const request = vi.fn();
    const unsubscribe = subscribeSubagentViewerRequests("parent-1", request);
    render(<SubagentSection runs={[run]} t={translate} locale="en" sessionId={null} />);
    expect((screen.getByRole("button", { name: "tasks.subagentView" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.doubleClick(screen.getByText("delegated work").closest("li")!);
    expect(request).not.toHaveBeenCalled();
    unsubscribe();
  });
});
