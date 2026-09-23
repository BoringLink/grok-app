import { describe, expect, it } from "vitest";
import {
  applySubagentEvent,
  formatSubagentDuration,
  subagentDisplayLabel,
  subagentDisplayStatus,
  type SubagentRun,
} from "./subagents";

describe("applySubagentEvent", () => {
  it("merges spawned → progress → finished into a single terminal row", () => {
    // Arrange
    const spawned = {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "a1",
      subagentType: "general-purpose",
      description: "count files",
      model: "claude-sonnet-5",
    };
    const progress = {
      sessionId: "s1",
      phase: "progress",
      subagentId: "a1",
      durationMs: 7016,
      turnCount: 1,
      toolCallCount: 1,
      tokensUsed: 24863,
      toolsUsed: ["run_terminal_command"],
      errorCount: 0,
    };
    const finished = {
      sessionId: "s1",
      phase: "finished",
      subagentId: "a1",
      status: "completed",
      durationMs: 9336,
      tokensUsed: 25178,
      output: "3 files.",
    };

    // Act
    const step1 = applySubagentEvent([], spawned);
    const step2 = applySubagentEvent(step1, progress);
    const step3 = applySubagentEvent(step2, finished);

    // Assert
    expect(step3).toHaveLength(1);
    const run = step3[0]!;
    expect(run.subagentId).toBe("a1");
    expect(run.description).toBe("count files");
    expect(run.subagentType).toBe("general-purpose");
    expect(run.turnCount).toBe(1);
    expect(run.toolCallCount).toBe(1);
    expect(run.toolsUsed).toEqual(["run_terminal_command"]);
    expect(run.durationMs).toBe(9336);
    expect(run.tokensUsed).toBe(25178);
    expect(run.phase).toBe("finished");
    expect(run.finished).toBe(true);
    expect(run.status).toBe("completed");
    expect(run.output).toBe("3 files.");
    expect(subagentDisplayStatus(run)).toBe("completed");
  });

  it("keeps spawn order and isolates distinct subagents", () => {
    // Arrange
    const first = applySubagentEvent([], {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "a1",
    });

    // Act
    const withSecond = applySubagentEvent(first, {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "a2",
    });
    const progressed = applySubagentEvent(withSecond, {
      sessionId: "s1",
      phase: "progress",
      subagentId: "a2",
      turnCount: 4,
    });

    // Assert
    expect(progressed.map((r) => r.subagentId)).toEqual(["a1", "a2"]);
    expect(progressed[0]!.turnCount).toBeUndefined();
    expect(progressed[1]!.turnCount).toBe(4);
  });

  it("does not overwrite existing values or fabricate defaults from sparse progress", () => {
    // Arrange
    const seeded = applySubagentEvent([], {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "a1",
      description: "seeded",
      subagentType: "general-purpose",
    });
    const previous: SubagentRun = {
      ...seeded[0]!,
      turnCount: 2,
      tokensUsed: 100,
      toolsUsed: ["read_file"],
    };

    // Act — progress carries only a duration; other counters are absent.
    const next = applySubagentEvent([previous], {
      sessionId: "s1",
      phase: "progress",
      subagentId: "a1",
      durationMs: 500,
      toolsUsed: [],
    });

    // Assert
    const run = next[0]!;
    expect(run.turnCount).toBe(2);
    expect(run.tokensUsed).toBe(100);
    expect(run.toolsUsed).toEqual(["read_file"]);
    expect(run.durationMs).toBe(500);
    expect(run.description).toBe("seeded");
  });

  it("does not append a second row for a repeated spawn id", () => {
    // Arrange
    const first = applySubagentEvent([], {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "a1",
      description: "one",
    });

    // Act
    const second = applySubagentEvent(first, {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "a1",
    });

    // Assert
    expect(second).toHaveLength(1);
    expect(second[0]!.description).toBe("one");
  });

  it("ignores payloads without a subagent id, returning the same reference", () => {
    // Arrange
    const seeded = applySubagentEvent([], {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "a1",
    });

    // Act
    const next = applySubagentEvent(seeded, {
      sessionId: "s1",
      phase: "progress",
    });

    // Assert
    expect(next).toBe(seeded);
  });

  it("does not downgrade a finished row on a stray progress push", () => {
    // Arrange
    const done = applySubagentEvent([], {
      sessionId: "s1",
      phase: "finished",
      subagentId: "a1",
      status: "completed",
      output: "done",
    });

    // Act
    const stale = applySubagentEvent(done, {
      sessionId: "s1",
      phase: "progress",
      subagentId: "a1",
      turnCount: 9,
    });

    // Assert
    expect(stale[0]!.phase).toBe("finished");
    expect(stale[0]!.finished).toBe(true);
    // A stale progress push must not reopen the terminal row.
    expect(subagentDisplayStatus(stale[0]!)).toBe("completed");
    expect(stale[0]!.turnCount).toBe(9);
  });
});

describe("subagentDisplayStatus", () => {
  const finished = (status: string | null) =>
    applySubagentEvent([], {
      sessionId: "s1",
      phase: "finished",
      subagentId: "a1",
      status,
    })[0]!;

  it("reports running until a finished frame arrives", () => {
    // Arrange
    const running = applySubagentEvent([], {
      sessionId: "s1",
      phase: "progress",
      subagentId: "a1",
    })[0]!;

    // Assert
    expect(subagentDisplayStatus(running)).toBe("running");
  });

  it("maps the CLI's terminal statuses without inventing an outcome", () => {
    expect(subagentDisplayStatus(finished("completed"))).toBe("completed");
    expect(subagentDisplayStatus(finished("failed"))).toBe("failed");
    expect(subagentDisplayStatus(finished("error"))).toBe("failed");
    expect(subagentDisplayStatus(finished("cancelled"))).toBe("cancelled");
    // Finished but the CLI never said how — not a failure.
    expect(subagentDisplayStatus(finished(null))).toBe("finished");
    expect(subagentDisplayStatus(finished("something_new"))).toBe("finished");
  });
});

describe("subagentDisplayLabel", () => {
  it("falls back description → type → shortened id", () => {
    // Arrange / Act / Assert
    const base = applySubagentEvent([], {
      sessionId: "s1",
      phase: "spawned",
      subagentId: "0123456789abcdef",
    })[0]!;
    expect(subagentDisplayLabel(base)).toBe("01234567…");
    expect(subagentDisplayLabel({ ...base, subagentType: "general" })).toBe(
      "general",
    );
    expect(
      subagentDisplayLabel({ ...base, subagentType: "general", description: "d" }),
    ).toBe("d");
  });
});

describe("formatSubagentDuration", () => {
  it("formats milliseconds honestly, unknown as em dash", () => {
    expect(formatSubagentDuration(undefined)).toBe("—");
    expect(formatSubagentDuration(750)).toBe("750ms");
    expect(formatSubagentDuration(9336)).toBe("9.3s");
    expect(formatSubagentDuration(72000)).toBe("1m 12s");
  });
});
