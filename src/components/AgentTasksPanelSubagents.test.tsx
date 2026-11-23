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

  it("opens the same child on row double-click and preserves output single-click", () => {
    const requests: Array<{ sessionId: string; childId: string }> = [];
    const unsubscribe = subscribeSubagentViewerRequests("parent-1", (request) => requests.push(request));
    render(<SubagentSection runs={[{ ...run, finished: true, output: "answer" }]} t={translate} locale="en" sessionId="parent-1" />);
    const row = screen.getByText("delegated work").closest("li");
    expect(row).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "tasks.expand" }));
    expect(screen.getByText("tasks.subagentOutput")).toBeTruthy();
    fireEvent.doubleClick(row!);

    expect(requests).toEqual([{ sessionId: "parent-1", childId: "child-1" }]);
    unsubscribe();
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
