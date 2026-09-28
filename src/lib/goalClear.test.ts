import { describe, expect, it, vi } from "vitest";
import { createGoalClearQueue } from "./goalClear";

describe("createGoalClearQueue", () => {
  it("sends immediately when the session is ready", () => {
    const send = vi.fn(async () => {});
    const q = createGoalClearQueue(send);
    q.arm("s1", "ready");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("s1");
  });

  it("waits until that same session is ready, and does not clear another chat", async () => {
    const send = vi.fn(async () => {});
    const q = createGoalClearQueue(send);
    q.arm("s1", "streaming");
    q.flush("s2", "ready");
    q.flush("s1", "streaming");
    expect(send).not.toHaveBeenCalled();
    q.flush("s1", "ready");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("s1");
  });

  it("ignores an empty session id", () => {
    const send = vi.fn(async () => {});
    const q = createGoalClearQueue(send);
    q.arm(null, "ready");
    q.arm("  ", "ready");
    expect(send).not.toHaveBeenCalled();
  });
});
