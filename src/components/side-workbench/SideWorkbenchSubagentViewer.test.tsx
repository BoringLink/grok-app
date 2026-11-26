// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SideWorkbench } from "./SideWorkbench";
import { requestSubagentViewer } from "@/lib/subagentViewerRequest";
import { emptySideWorkbenchState, type SideWorkbenchState } from "@/lib/sideWorkbench";
import { subagentStore } from "@/lib/subagentStore";
import { subagentLiveStore } from "@/lib/subagentLiveStore";

function ViewerHarness({ onCloseSide }: { onCloseSide: () => void }) {
  const [state, setState] = useState<SideWorkbenchState>(emptySideWorkbenchState);
  return (
    <SideWorkbench
      locale="en"
      sessionId="parent-session"
      projectPath={null}
      isGitProject={false}
      state={state}
      onStateChange={setState}
      onCloseSide={onCloseSide}
      paneActive={false}
    />
  );
}

afterEach(() => {
  cleanup();
  subagentLiveStore.resetForTests();
  subagentStore.resetForTests();
  vi.unstubAllGlobals();
});

describe("SideWorkbench subagent viewer request", () => {
  it("opens the process-created tab for the matching active parent session", async () => {
    const closeSide = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    });
    subagentStore.apply({
      sessionId: "parent-session",
      phase: "spawned",
      subagentId: "child-row",
      childSessionId: "agent-child-session",
      description: "delegated task text",
    });
    subagentLiveStore.apply("parent-session", {
      childId: "child-row",
      kind: "assistant",
      text: "child response",
    });
    render(<ViewerHarness onCloseSide={closeSide} />);

    requestSubagentViewer({ sessionId: "parent-session", childId: "child-row" });

    expect(await screen.findByText("child response")).toBeTruthy();
    expect(screen.getAllByText("Subagents").length).toBeGreaterThan(0);
    await waitFor(() => expect(closeSide).toHaveBeenCalledOnce());
  });
});
