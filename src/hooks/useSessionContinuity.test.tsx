/**
 * @vitest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSnapshot } from "@/lib/session";
import type { SessionContinuitySnapshot } from "@/lib/sessionContinuity";
import * as api from "@/lib/api";
import { useSessionContinuity } from "./useSessionContinuity";

vi.mock("@/lib/api", () => ({
  sessionContinuityState: vi.fn(),
}));

const continuityState = vi.mocked(api.sessionContinuityState);

function snapshot(
  sessionId: string,
  state: SessionSnapshot["state"] = "disconnected",
): SessionSnapshot {
  return {
    sessionId,
    agentSessionId: null,
    state,
    lastError: null,
    streamingMessageId: null,
    backend: "grok_agent_stdio",
  };
}

describe("useSessionContinuity", () => {
  beforeEach(() => {
    continuityState.mockReset();
  });

  it("reads the persisted checkpoint for a session that is not live", async () => {
    continuityState.mockResolvedValue({
      status: "verified",
      bootstrapIncluded: 2,
      bootstrapOmitted: 1,
    });

    const { result } = renderHook(() =>
      useSessionContinuity(snapshot("session-a"), true),
    );

    await waitFor(() => expect(result.current?.kind).toBe("restored"));
    expect(continuityState).toHaveBeenCalledWith("session-a");
    expect(result.current?.detailParams).toEqual({ included: 2, omitted: 1 });
  });

  it("never lets a slow response from the previous session leak into the next", async () => {
    let resolveA: (value: SessionContinuitySnapshot) => void = () => {};
    continuityState.mockImplementation((id) => {
      if (id === "session-a") {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({
        status: "verified",
        bootstrapIncluded: 1,
      });
    });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useSessionContinuity(snapshot(sessionId), true),
      { initialProps: { sessionId: "session-a" } },
    );

    rerender({ sessionId: "session-b" });
    await waitFor(() => expect(result.current?.kind).toBe("restored"));

    // 旧会话的异步结果晚到，也必须被丢弃。
    resolveA({ status: "unverified", reason: "history_partial" });
    await Promise.resolve();
    expect(result.current?.kind).toBe("restored");
    expect(continuityState).toHaveBeenLastCalledWith("session-b");
  });

  it("keeps a live snapshot with a reason authoritative over the disk record", () => {
    continuityState.mockResolvedValue({ status: "verified" });
    const live: SessionSnapshot = {
      ...snapshot("session-a"),
      continuity: { status: "unverified", reason: "history_partial" },
    };

    const { result } = renderHook(() =>
      useSessionContinuity(live, true),
    );

    expect(result.current?.kind).toBe("unverified");
    expect(continuityState).not.toHaveBeenCalled();
  });
});
