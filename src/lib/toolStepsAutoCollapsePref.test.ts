import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOOL_STEPS_AUTO_COLLAPSE,
  TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT,
  TOOL_STEPS_AUTO_COLLAPSE_STORAGE_KEY,
  activityUnitDefaultOpen,
  loadToolStepsAutoCollapsePref,
  parseToolStepsAutoCollapsePref,
  saveToolStepsAutoCollapsePref,
  thoughtDefaultOpen,
  toolStepDefaultOpen,
  workPhaseDefaultOpen,
  resolveFoldExpanded,
  type ToolStepsAutoCollapseStorage,
} from "./toolStepsAutoCollapsePref";

function memoryStorage(
  initial: Record<string, string> = {},
): ToolStepsAutoCollapseStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return key in data ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
  };
}

describe("toolStepsAutoCollapsePref", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to true (auto-collapse finished tools)", () => {
    expect(DEFAULT_TOOL_STEPS_AUTO_COLLAPSE).toBe(true);
    expect(parseToolStepsAutoCollapsePref(null)).toBe(true);
    expect(parseToolStepsAutoCollapsePref("")).toBe(true);
    expect(parseToolStepsAutoCollapsePref("maybe")).toBe(true);
    expect(loadToolStepsAutoCollapsePref(memoryStorage())).toBe(true);
  });

  it("parses true/false variants", () => {
    expect(parseToolStepsAutoCollapsePref("1")).toBe(true);
    expect(parseToolStepsAutoCollapsePref("true")).toBe(true);
    expect(parseToolStepsAutoCollapsePref(true)).toBe(true);
    expect(parseToolStepsAutoCollapsePref("0")).toBe(false);
    expect(parseToolStepsAutoCollapsePref("false")).toBe(false);
    expect(parseToolStepsAutoCollapsePref(false)).toBe(false);
  });

  it("round-trips preference", () => {
    const s = memoryStorage();
    saveToolStepsAutoCollapsePref(false, s);
    expect(s.data[TOOL_STEPS_AUTO_COLLAPSE_STORAGE_KEY]).toBe("0");
    expect(loadToolStepsAutoCollapsePref(s)).toBe(false);
    saveToolStepsAutoCollapsePref(true, s);
    expect(s.data[TOOL_STEPS_AUTO_COLLAPSE_STORAGE_KEY]).toBe("1");
    expect(loadToolStepsAutoCollapsePref(s)).toBe(true);
  });

  it("toolStepDefaultOpen: follows pref only (running does not force open)", () => {
    expect(toolStepDefaultOpen(true, true)).toBe(false);
    expect(toolStepDefaultOpen(true, false)).toBe(true);
    expect(toolStepDefaultOpen(false, true)).toBe(false);
    expect(toolStepDefaultOpen(false, false)).toBe(true);
    // Default arg uses DEFAULT_TOOL_STEPS_AUTO_COLLAPSE (true)
    expect(toolStepDefaultOpen(false)).toBe(false);
    expect(toolStepDefaultOpen(true)).toBe(false);
  });

  it("resolveFoldExpanded follows default until the user toggles", () => {
    expect(
      resolveFoldExpanded({
        userToggled: false,
        storedOpen: true,
        defaultOpen: false,
      }),
    ).toBe(false);
    expect(
      resolveFoldExpanded({
        userToggled: false,
        storedOpen: false,
        defaultOpen: true,
      }),
    ).toBe(true);
    expect(
      resolveFoldExpanded({
        userToggled: true,
        storedOpen: true,
        defaultOpen: false,
      }),
    ).toBe(true);
    expect(
      resolveFoldExpanded({
        userToggled: true,
        storedOpen: false,
        defaultOpen: true,
      }),
    ).toBe(false);
  });

  it("workPhaseDefaultOpen: live stays expanded; done collapses even with errors", () => {
    expect(
      workPhaseDefaultOpen({
        running: true,
        errorCount: 0,
        autoCollapse: true,
      }),
    ).toBe(true);
    expect(
      workPhaseDefaultOpen({
        running: true,
        errorCount: 2,
        autoCollapse: true,
      }),
    ).toBe(true);
    expect(
      workPhaseDefaultOpen({
        running: false,
        errorCount: 0,
        autoCollapse: true,
      }),
    ).toBe(false);
    expect(
      workPhaseDefaultOpen({
        running: false,
        errorCount: 1,
        autoCollapse: true,
      }),
    ).toBe(false);
    expect(
      workPhaseDefaultOpen({
        running: false,
        errorCount: 0,
        autoCollapse: false,
      }),
    ).toBe(true);
  });

  /**
   * The shell-side fold model (`chatRowCollapse`) reads the fold from
   * `activityUnitDefaultOpen`, so this pins that composition to the exact rule
   * functions the rich components call (TimelinePhaseBlock, GrokActivitySteps,
   * Thinking). A change to any rule that is not reflected here fails the test.
   */
  it("activityUnitDefaultOpen stays pinned to the component fold rules", () => {
    [true, false].forEach((running) => {
      [true, false].forEach((streaming) => {
        [true, false].forEach((autoCollapse) => {
          expect(
            activityUnitDefaultOpen({
              kind: "phase",
              hasBody: true,
              running,
              streaming,
              autoCollapse,
            }),
          ).toBe(workPhaseDefaultOpen({ running, autoCollapse }));
          expect(
            activityUnitDefaultOpen({
              kind: "thought",
              hasBody: true,
              running,
              streaming,
              autoCollapse,
            }),
          ).toBe(thoughtDefaultOpen(streaming));
          expect(
            activityUnitDefaultOpen({
              kind: "tool",
              hasBody: true,
              running,
              streaming,
              autoCollapse,
            }),
          ).toBe(toolStepDefaultOpen(false, autoCollapse));
        });
      });
    });
  });

  it("a unit without a body can never be open", () => {
    (["phase", "thought", "tool"] as const).forEach((kind) => {
      expect(
        activityUnitDefaultOpen({
          kind,
          hasBody: false,
          running: true,
          streaming: true,
          autoCollapse: false,
        }),
      ).toBe(false);
    });
  });

  it("thoughtDefaultOpen expands only while the episode is live", () => {
    expect(thoughtDefaultOpen(true)).toBe(true);
    expect(thoughtDefaultOpen(false)).toBe(false);
  });

  it("dispatches change event on save when window exists", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const stubWindow = {
      addEventListener(type: string, listener: EventListener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(ev: Event) {
        const set = listeners.get(ev.type);
        if (set) for (const fn of set) fn(ev);
        return true;
      },
    };
    vi.stubGlobal("window", stubWindow);
    vi.stubGlobal(
      "CustomEvent",
      class CustomEvent<T = unknown> extends Event {
        detail: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      },
    );

    const handler = vi.fn();
    stubWindow.addEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, handler);
    saveToolStepsAutoCollapsePref(false, memoryStorage());
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent;
    expect(ev.detail).toBe(false);
  });
});
