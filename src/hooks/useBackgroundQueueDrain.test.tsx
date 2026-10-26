/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteSendFromQueue } from "@/hooks/useSendQueue";
import { createT } from "@/i18n";
import type { SessionSnapshot, SessionState } from "@/lib/session";
import { sessionLiveMapStore } from "@/lib/sessionLiveMapStore";
import { emptyLiveSnapshot } from "@/lib/sessionLiveStore";
import { useSendQueue } from "./useSendQueue";

function snap(id: string | null, state: SessionState): SessionSnapshot {
  return {
    sessionId: id,
    state,
    lastError: null,
    streamingMessageId: null,
    backend: "test",
  };
}

function row(id: string, state: SessionState) {
  return { ...emptyLiveSnapshot(id, 1), state };
}

describe("useSendQueue background drain", () => {
  const tr = createT("en");

  beforeEach(() => {
    sessionLiveMapStore.resetForTests();
  });

  afterEach(() => {
    cleanup();
    sessionLiveMapStore.resetForTests();
  });

  function mount(execute: ExecuteSendFromQueue) {
    const liveHostRef = { current: snap("c", "streaming") };
    const viewingSessionIdRef = { current: "c" as string | null };
    const sendInFlightRef = { current: false };
    const sendInFlightBySessionRef = { current: new Set<string>() };
    const connectingBySessionRef = { current: new Set<string>() };
    const executeSendRef = { current: execute };
    const showToast = vi.fn();
    sessionLiveMapStore.setMap({
      a: row("a", "streaming"),
      b: row("b", "streaming"),
      c: row("c", "streaming"),
    });
    const view = renderHook(
      (props: { sessionId: string | null; sessionState: SessionState }) =>
        useSendQueue({
          sessionId: props.sessionId,
          sessionState: props.sessionState,
          connecting: false,
          liveHostRef,
          viewingSessionIdRef,
          sendInFlightRef,
          sendInFlightBySessionRef,
          connectingBySessionRef,
          executeSendRef,
          showToast,
          acceptExternal: false,
          tr,
        }),
      { initialProps: { sessionId: "c", sessionState: "streaming" as SessionState } },
    );
    const enqueue = (sessionId: string, storedDisplay: string) => {
      viewingSessionIdRef.current = sessionId;
      act(() => {
        view.result.current.enqueue({
          storedDisplay,
          attachments: [],
          goalMode: false,
        });
      });
    };
    return { ...view, viewingSessionIdRef, liveHostRef, enqueue, showToast };
  }

  it("sends a background session's next item when its turn ends, and not before", async () => {
    const calls: string[] = [];
    const execute = vi.fn<ExecuteSendFromQueue>(async (opts) => {
      calls.push(`${opts.targetSessionId}:${opts.storedDisplay}`);
      const id = opts.targetSessionId;
      if (id) {
        sessionLiveMapStore.setMap((prev) => ({
          ...prev,
          [id]: row(id, "streaming"),
        }));
      }
      return true;
    });
    const view = mount(execute);
    view.enqueue("a", "a1");
    view.enqueue("a", "a2");
    view.enqueue("b", "b1");
    view.viewingSessionIdRef.current = "c";

    act(() => {
      sessionLiveMapStore.setMap({
        a: row("a", "streaming"),
        b: row("b", "ready"),
        c: row("c", "streaming"),
      });
    });

    await waitFor(() => {
      expect(calls).toEqual(["b:b1"]);
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual(["b:b1"]);

    act(() => {
      sessionLiveMapStore.setMap((prev) => ({
        ...prev,
        a: row("a", "ready"),
      }));
    });
    await waitFor(() => {
      expect(calls).toEqual(["b:b1", "a:a1"]);
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual(["b:b1", "a:a1"]);

    act(() => {
      sessionLiveMapStore.setMap((prev) => ({
        ...prev,
        a: row("a", "ready"),
      }));
    });
    await waitFor(() => {
      expect(calls).toEqual(["b:b1", "a:a1", "a:a2"]);
    });
  });

  it("a failed session stays held and does not block or repeat", async () => {
    const calls: string[] = [];
    const execute = vi.fn<ExecuteSendFromQueue>(async (opts) => {
      calls.push(String(opts.targetSessionId));
      return opts.targetSessionId !== "a";
    });
    const view = mount(execute);
    view.enqueue("a", "a1");
    view.enqueue("b", "b1");
    view.viewingSessionIdRef.current = "c";
    act(() => {
      sessionLiveMapStore.setMap({
        a: row("a", "ready"),
        b: row("b", "ready"),
        c: row("c", "streaming"),
      });
    });
    await waitFor(() => {
      expect(calls.slice().sort()).toEqual(["a", "b"]);
    });
    await new Promise((r) => setTimeout(r, 90));
    expect(calls.filter((id) => id === "a")).toEqual(["a"]);
    expect(calls.filter((id) => id === "b")).toEqual(["b"]);
    expect(view.showToast).not.toHaveBeenCalled();
  });

  it("does not send the same head twice while the first send is in flight", async () => {
    let release: (ok: boolean) => void = () => {};
    const calls: string[] = [];
    const execute = vi.fn<ExecuteSendFromQueue>((opts) => {
      calls.push(opts.storedDisplay);
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    const view = mount(execute);
    view.enqueue("a", "a1");
    view.enqueue("a", "a2");
    view.viewingSessionIdRef.current = "c";
    act(() => {
      sessionLiveMapStore.setMap({
        a: row("a", "ready"),
        c: row("c", "streaming"),
      });
    });
    await waitFor(() => {
      expect(calls).toEqual(["a1"]);
    });
    act(() => {
      sessionLiveMapStore.setMap({
        a: row("a", "ready"),
        c: row("c", "streaming"),
      });
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual(["a1"]);
    await act(async () => {
      release(true);
    });
    await waitFor(() => {
      expect(calls).toEqual(["a1", "a2"]);
    });
    expect(calls.filter((text) => text === "a1")).toEqual(["a1"]);
  });

  it("drops a disconnected session's queue instead of sending it", async () => {
    const execute = vi.fn<ExecuteSendFromQueue>(async () => true);
    const view = mount(execute);
    view.enqueue("a", "a1");
    view.viewingSessionIdRef.current = "c";
    act(() => {
      sessionLiveMapStore.setMap({
        a: row("a", "disconnected"),
        c: row("c", "streaming"),
      });
    });
    view.rerender({ sessionId: "a", sessionState: "disconnected" });
    await waitFor(() => {
      expect(view.result.current.activeQueue).toEqual([]);
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
