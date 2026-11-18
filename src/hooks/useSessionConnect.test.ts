/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { IDLE_SNAPSHOT } from "@/lib/session";
import {
  createSessionConnectHost,
  useSessionConnect,
} from "./useSessionConnect";

describe("useSessionConnect", () => {
  it("rejects a second connect claim for the same session", () => {
    const hostRef = { current: createSessionConnectHost() };
    const { result } = renderHook(() =>
      useSessionConnect({
        hostRef,
        liveMapEnabled: false,
        viewedSessionId: null,
      }),
    );
    expect(result.current.claimSessionConnection("s1")).toBe(true);
    expect(result.current.claimSessionConnection("s1")).toBe(false);
    result.current.releaseSessionConnection(["s1"]);
    expect(result.current.claimSessionConnection("s1")).toBe(true);
  });

  it("localizes a retryable pending-settings connection error", async () => {
    vi.spyOn(api, "hasHost").mockReturnValue(true);
    vi.spyOn(api, "isTauri").mockReturnValue(true);
    vi.spyOn(api, "sessionConnect").mockRejectedValue(
      new Error("PENDING_SESSION_SETTINGS"),
    );
    const host = createSessionConnectHost();
    host.session = { ...IDLE_SNAPSHOT, sessionId: "session-a", state: "idle" };
    host.viewingSessionIdRef.current = "session-a";
    host.currentViewFocus = () => ({ sessionId: "session-a", epoch: 0 });
    host.setLocalError = vi.fn();
    const { result } = renderHook(() =>
      useSessionConnect({
        hostRef: { current: host },
        liveMapEnabled: false,
        viewedSessionId: "session-a",
      }),
    );

    await act(async () => {
      await result.current.ensureConnected({ force: true, sessionId: "session-a" });
    });

    expect(host.setLocalError).toHaveBeenCalledWith(
      "session.pendingSettingsRetry",
    );
  });

  it("does not connect a session until its draft route saves and retries creation", async () => {
    const operations: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(api, "hasHost").mockReturnValue(true);
    vi.spyOn(api, "isTauri").mockReturnValue(true);
    const create = vi
      .spyOn(api, "sessionCreate")
      .mockResolvedValueOnce({ id: "session-failed", title: "New chat" })
      .mockResolvedValueOnce({ id: "session-new", title: "New chat" });
    const remove = vi.spyOn(api, "sessionDelete").mockResolvedValue(undefined);
    const prefsSave = vi
      .spyOn(api, "composerPrefsSet")
      .mockImplementationOnce(async () => {
        operations.push("prefs");
        throw new Error("disk");
      })
      .mockImplementation(async () => {
        operations.push("prefs");
        return {
          modelId: "raw-model",
          providerId: "custom-provider",
          effort: "medium",
          mode: "agent",
          permissionPolicy: "ask",
          scope: "session",
          source: "session",
        };
      });
    const connect = vi
      .spyOn(api, "sessionConnect")
      .mockResolvedValue({
        ...IDLE_SNAPSHOT,
        sessionId: "session-new",
        state: "ready",
      });

    const host = createSessionConnectHost();
    host.draftComposerRouteRef.current = {
      providerId: "custom-provider",
      modelId: "raw-model",
      effort: "medium",
    };
    host.currentViewFocus = () => ({
      sessionId: host.viewingSessionIdRef.current,
      epoch: 0,
    });
    host.setSession = (update) => {
      operations.push("session");
      host.session =
        typeof update === "function" ? update(host.session) : update;
    };
    host.setLiveHost = (update) => {
      host.liveHostRef.current =
        typeof update === "function" ? update(host.liveHostRef.current) : update;
    };
    host.setLocalError = vi.fn();
    host.refreshSessions = vi.fn();
    const hostRef = { current: host };
    const { result } = renderHook(() =>
      useSessionConnect({
        hostRef,
        liveMapEnabled: false,
        viewedSessionId: null,
      }),
    );

    let failedAttempt: string | null = "uninitialized";
    await act(async () => {
      failedAttempt = await result.current.ensureConnected();
    });

    expect(failedAttempt).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("session-failed");
    expect(host.session.sessionId).toBeNull();
    expect(host.draftComposerRouteRef.current).toEqual({
      providerId: "custom-provider",
      modelId: "raw-model",
      effort: "medium",
    });
    expect(host.setLocalError).toHaveBeenCalledWith(expect.any(String));
    expect(host.refreshSessions).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "draft composer route save failed",
      expect.objectContaining({ sessionId: "session-failed" }),
    );

    let retryResult: string | null = null;
    await act(async () => {
      retryResult = await result.current.ensureConnected();
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(prefsSave).toHaveBeenCalledTimes(2);
    expect(operations.slice(0, 3)).toEqual(["prefs", "prefs", "session"]);
    expect(prefsSave).toHaveBeenLastCalledWith({
      sessionId: "session-new",
      projectId: null,
      providerId: "custom-provider",
      modelId: "raw-model",
      effort: "medium",
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(retryResult).toBe("session-new");
    expect(host.draftComposerRouteRef.current).toBeNull();
  });

  it("persists transient draft Plan mode on the new session before connect", async () => {
    const operations: string[] = [];
    vi.spyOn(api, "hasHost").mockReturnValue(true);
    vi.spyOn(api, "isTauri").mockReturnValue(true);
    vi.spyOn(api, "sessionCreate").mockResolvedValue({
      id: "plan-session",
      title: "Plan",
    });
    const prefsSave = vi
      .spyOn(api, "composerPrefsSet")
      .mockImplementation(async (prefs) => {
        operations.push("prefs");
        expect(prefs.mode).toBe("plan");
        return {
          modelId: "grok-4.7",
          providerId: "official",
          effort: "xhigh",
          mode: "plan",
          permissionPolicy: "ask",
          scope: "session",
          source: "session",
        };
      });
    const connect = vi
      .spyOn(api, "sessionConnect")
      .mockImplementation(async () => {
        operations.push("connect");
        return {
          ...IDLE_SNAPSHOT,
          sessionId: "plan-session",
          state: "ready",
        };
      });

    const host = createSessionConnectHost();
    host.mode = "plan";
    host.currentViewFocus = () => ({
      sessionId: host.viewingSessionIdRef.current,
      epoch: 0,
    });
    host.setSession = (update) => {
      operations.push("session");
      host.session =
        typeof update === "function" ? update(host.session) : update;
    };
    host.setLiveHost = (update) => {
      host.liveHostRef.current =
        typeof update === "function" ? update(host.liveHostRef.current) : update;
    };
    const { result } = renderHook(() =>
      useSessionConnect({
        hostRef: { current: host },
        liveMapEnabled: false,
        viewedSessionId: null,
      }),
    );

    let connectedSession: string | null = null;
    await act(async () => {
      connectedSession = await result.current.ensureConnected();
    });

    expect(prefsSave).toHaveBeenCalledWith({
      sessionId: "plan-session",
      projectId: null,
      mode: "plan",
    });
    expect(operations.indexOf("prefs")).toBeLessThan(
      operations.indexOf("session"),
    );
    expect(operations.indexOf("prefs")).toBeLessThan(
      operations.indexOf("connect"),
    );
    expect(connect).toHaveBeenCalledOnce();
    expect(connectedSession).toBe("plan-session");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
