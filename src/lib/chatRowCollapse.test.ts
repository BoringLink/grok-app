import { describe, expect, it } from "vitest";
import type { MessageSegment, MessageToolSegment } from "@/lib/session";
import { toolFailed } from "@/lib/timelinePhases";
import { toolSegmentFailed } from "@/components/lobe-chat/TimelineToolRow";
import { resolveRowActivityFold } from "./chatRowCollapse";

function tool(
  toolCallId: string,
  status: string,
  output?: string,
): MessageToolSegment {
  return { kind: "tool", toolCallId, title: toolCallId, status, output };
}

describe("resolveRowActivityFold", () => {
  it("is expanded while a tool phase is running", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: true,
      autoCollapse: true,
      segments: [tool("a", "in_progress"), tool("b", "in_progress")],
    });

    // Assert
    expect(fold).toEqual({ hasActivity: true, expanded: true });
  });

  it("folds a finished phase under auto-collapse", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: false,
      autoCollapse: true,
      segments: [tool("a", "completed"), tool("b", "completed")],
    });

    // Assert
    expect(fold).toEqual({ hasActivity: true, expanded: false });
  });

  it("keeps a finished phase open when auto-collapse is off", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: false,
      autoCollapse: false,
      segments: [tool("a", "completed"), tool("b", "completed")],
    });

    // Assert
    expect(fold).toEqual({ hasActivity: true, expanded: true });
  });

  it("treats a bare tool with a body as expandable under the preference", () => {
    // Arrange: one tool is not phase-worthy, so it stays a bare unit.
    const segments: MessageSegment[] = [tool("a", "completed", "stdout")];

    // Act / Assert: same rule as TimelineToolRow / GrokActivityStepRow.
    expect(
      resolveRowActivityFold({ streaming: false, autoCollapse: false, segments })
        .expanded,
    ).toBe(true);
    expect(
      resolveRowActivityFold({ streaming: false, autoCollapse: true, segments })
        .expanded,
    ).toBe(false);
  });

  it("does not count a tool without a body", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: false,
      autoCollapse: false,
      segments: [tool("a", "completed")],
    });

    // Assert: no body means the row height cannot change with the fold.
    expect(fold).toEqual({ hasActivity: false, expanded: false });
  });

  it("folds a streaming bare thought when the episode ends", () => {
    // Arrange
    const segments = [{ kind: "thought" as const, text: "reasoning" }];

    // Act / Assert
    expect(
      resolveRowActivityFold({ streaming: true, autoCollapse: true, segments }),
    ).toEqual({ hasActivity: true, expanded: true });
    expect(
      resolveRowActivityFold({
        streaming: false,
        autoCollapse: false,
        segments,
      }),
    ).toEqual({ hasActivity: true, expanded: false });
  });

  it("does not count a thought without body text", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: false,
      autoCollapse: false,
      segments: [{ kind: "thought", text: "   " }],
    });

    // Assert
    expect(fold).toEqual({ hasActivity: false, expanded: false });
  });

  it("has activity but no open unit for a folded failed phase", () => {
    // Arrange: failures render excerpt rows under the folded header, so the row
    // still has foldable content even though nothing is open.
    const fold = resolveRowActivityFold({
      streaming: false,
      autoCollapse: true,
      segments: [tool("a", "failed", "boom"), tool("b", "completed")],
    });

    // Assert
    expect(fold).toEqual({ hasActivity: true, expanded: false });
  });

  it("is not activity for a row with only body content", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: false,
      autoCollapse: false,
      segments: [{ kind: "content", text: "answer" }],
    });

    // Assert
    expect(fold).toEqual({ hasActivity: false, expanded: false });
  });

  it("ignores the live thinking placeholder (chrome only, no body)", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: true,
      autoCollapse: true,
      segments: [],
    });

    // Assert
    expect(fold).toEqual({ hasActivity: false, expanded: false });
  });

  it("tolerates a missing segments list", () => {
    // Arrange / Act
    const fold = resolveRowActivityFold({
      streaming: false,
      autoCollapse: true,
      segments: null,
    });

    // Assert
    expect(fold).toEqual({ hasActivity: false, expanded: false });
  });
});

/**
 * The failure predicate gates the tool body, which decides whether a bare tool
 * contributes height. It lives in two places (the timeline projection and the
 * bare tool row), so pin them together rather than let a shell's height drift.
 */
describe("tool failure predicate parity", () => {
  const cases: MessageToolSegment[] = [
    tool("a", "completed"),
    tool("b", "failed"),
    tool("c", "error"),
    tool("d", "rejected"),
    tool("e", "denied"),
    tool("f", "in_progress"),
    { ...tool("g", "completed"), isError: true },
    tool("h", ""),
  ];

  it("agrees with TimelineToolRow's failure check", () => {
    cases.forEach((seg) => {
      expect(toolFailed(seg)).toBe(toolSegmentFailed(seg));
    });
  });
});
