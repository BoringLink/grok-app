// @vitest-environment jsdom
/**
 * End-to-end: an out-of-band fold changes a shell's ledger height, the shell
 * re-renders (a real DOM mutation), and the viewport controller restores the
 * escaped anchor inside that mutation batch.
 *
 * The resident list's fold projection is covered with a fake controller, and
 * the anchor restore with in-content mutations; this wires the real resident
 * list to the real viewport controller so the whole chain — model fold → ledger
 * re-seed → DOM mutation → `MutationObserver` → restore — runs in one test.
 * Geometry is stubbed (jsdom has no layout); the observers, the ledger and the
 * React commit are real.
 */

import { act, cleanup, render } from "@testing-library/react";
import {
  useEffect,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useChatViewportController,
  type ChatViewportControllerHandle,
  type EscapedAnchorElement,
} from "./useChatViewportController";
import {
  useChatResidentList,
  type UseChatResidentListResult,
} from "./useChatResidentList";
import type { RowActivityFoldSnapshot } from "./chatResidentListShared";

/** The controller subscribes to a host event; jsdom has no Tauri. */
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

class ControlledResizeObserver {
  private static readonly instances = new Set<ControlledResizeObserver>();
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControlledResizeObserver.instances.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    ControlledResizeObserver.instances.delete(this);
  }
  static emit(target: Element, height: number, width = 800) {
    const entry = { target, contentRect: { height, width } } as ResizeObserverEntry;
    ControlledResizeObserver.instances.forEach((observer) => {
      if (observer.targets.has(target)) {
        observer.callback([entry], observer as unknown as ResizeObserver);
      }
    });
  }
  static reset() {
    ControlledResizeObserver.instances.clear();
  }
}

const ITEM_COUNT = 24;
/** Every row's seed estimate; also what an out-of-band fold re-seeds to. */
const ROW_ESTIMATE = 200;
/** The shell's measured height while its activity was expanded. */
const MEASURED_SHELL = 600;
/** Where the reader sits after the fold re-seeds the shell above them. */
const SHELL_SHIFT_PX = MEASURED_SHELL - ROW_ESTIMATE;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Fold source whose input identity changes on every `set`, like a model tick. */
function makeFoldSource() {
  const rows = new Map<
    number,
    { hasActivity: boolean; expanded: boolean; inputs: [number] }
  >();
  return {
    set(index: number, fold: { hasActivity: boolean; expanded: boolean }): void {
      const prev = rows.get(index);
      rows.set(index, { ...fold, inputs: [(prev?.inputs[0] ?? 0) + 1] });
    },
    get(index: number): RowActivityFoldSnapshot | null {
      const row = rows.get(index);
      return row ? { ...row } : null;
    },
  };
}

function Row({
  index,
  list,
}: {
  index: number;
  list: UseChatResidentListResult;
}) {
  // The shell re-renders when its fold height changes; a rich row when its band
  // membership flips. Both halves are part of one snapshot.
  useSyncExternalStore(
    list.bandStore.subscribeFor(index),
    () =>
      `${list.bandStore.isRich(index) ? "rich" : "shell"}:${list.bandStore.heightRevision(index)}`,
  );
  const isRich = list.bandStore.isRich(index);
  return (
    <div
      ref={isRich ? list.measureRef(index) : undefined}
      data-virt-index={index}
      style={{ height: list.rowHeight(index) }}
    />
  );
}

type Handles = {
  controller: ChatViewportControllerHandle;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<EscapedAnchorElement | null>;
};

function Harness({
  folds,
  revision,
  onReady,
}: {
  folds: (index: number) => RowActivityFoldSnapshot | null;
  revision: number;
  onReady: (handles: Handles) => void;
}) {
  const {
    viewportRef,
    contentRef,
    isPinnedRef,
    controller,
    anchorRef,
  } = useChatViewportController({});
  const list = useChatResidentList({
    itemCount: ITEM_COUNT,
    getEstimateHeight: () => ROW_ESTIMATE,
    viewportRef,
    isPinnedRef,
    controller,
    getActivityFold: folds,
    activityRevision: revision,
  });
  useEffect(() => {
    onReady({ controller, viewportRef, contentRef, anchorRef });
  }, [onReady, controller, viewportRef, contentRef, anchorRef]);
  return (
    <div ref={viewportRef}>
      <div ref={contentRef}>
        {Array.from({ length: ITEM_COUNT }, (_, index) => (
          <Row key={index} index={index} list={list} />
        ))}
      </div>
    </div>
  );
}

/** Give the rendered viewport / content / rows the geometry jsdom cannot. */
function stubGeometry(
  viewport: HTMLDivElement,
  content: HTMLDivElement,
  controller: ChatViewportControllerHandle,
): void {
  let scrollTop = 0;
  Object.defineProperties(viewport, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => controller.ledger().totalHeight(),
    },
    clientHeight: { configurable: true, get: () => 400 },
    clientWidth: { configurable: true, get: () => 800 },
  });
  Object.defineProperty(viewport, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(0, 400),
  });
  Object.defineProperty(content, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(-viewport.scrollTop, controller.ledger().totalHeight()),
  });
  for (const row of content.querySelectorAll<HTMLElement>("[data-virt-index]")) {
    const index = Number(row.dataset.virtIndex);
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        rect(
          controller.ledger().offsetOf(index) - viewport.scrollTop,
          controller.ledger().heightOf(index),
        ),
    });
  }
}

describe("escaped anchor through an out-of-band fold (end to end)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ControlledResizeObserver.reset();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    cleanup();
    ControlledResizeObserver.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("holds the anchor when a shell above the reader re-seeds from the model", async () => {
    // Arrange — row 2 has foldable activity, currently expanded.
    const folds = makeFoldSource();
    folds.set(2, { hasActivity: true, expanded: true });
    let handles: Handles | null = null;
    const onReady = (next: Handles) => {
      handles = next;
    };
    const { rerender } = render(
      <Harness folds={folds.get} revision={1} onReady={onReady} />,
    );
    const ready = handles as unknown as Handles;
    const { controller, viewportRef, contentRef, anchorRef } = ready;
    const viewport = viewportRef.current!;
    const content = contentRef.current!;
    /**
     * Let one task boundary pass: flush pending microtasks (MutationObserver,
     * effects), then advance a frame so the restore latch clears — the same
     * order a real frame gives. Skipping it would leave a prior step's mutation
     * queued into the fold's frame and consume the latch before the height
     * change lands.
     */
    const settle = async () => {
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(60);
      });
    };

    stubGeometry(viewport, content, controller);
    await settle();

    // Escape near the top so row 2 is inside the band and renders real content.
    act(() => {
      controller.escape("test:near");
      controller.assign("test:near", 300);
    });
    await settle();

    // Row 2 is measured at its expanded height while rich.
    const row2 = content.querySelector<HTMLElement>('[data-virt-index="2"]')!;
    await act(async () => {
      ControlledResizeObserver.emit(row2, MEASURED_SHELL);
    });
    expect(controller.ledger().heightOf(2)).toBe(MEASURED_SHELL);
    expect(controller.ledger().sourceOf(2)).toBe("measured");
    await settle();

    // Move the reader down so row 2 is a shell above them (a programmatic move
    // re-escapes, exactly as a rail / find jump does) and capture the anchor.
    act(() => {
      controller.escape("test:down");
      controller.assign("test:down", 3000);
    });
    await settle();
    act(() => controller.restoreLayout());
    const anchor = anchorRef.current;
    expect(anchor?.element).toBeTruthy();
    expect(anchor!.element!.dataset.virtIndex).toBe("13");
    const heldTop = anchor!.element!.getBoundingClientRect().top;
    const heldScrollTop = viewport.scrollTop;

    // Act — the fold flips while the row is out of band. The list re-seeds the
    // shell from the model (a ledger write), which re-renders the shell (a real
    // DOM mutation) and the controller restores the anchor inside that batch.
    act(() => folds.set(2, { hasActivity: true, expanded: false }));
    await act(async () => {
      rerender(<Harness folds={folds.get} revision={2} onReady={onReady} />);
    });

    // Assert — the shell shrank to the estimate and the anchor kept its screen
    // position; the writer moved the transcript by exactly that shrink.
    expect(controller.ledger().heightOf(2)).toBe(ROW_ESTIMATE);
    expect(controller.ledger().sourceOf(2)).toBe("estimate");
    expect(viewport.scrollTop).toBe(heldScrollTop - SHELL_SHIFT_PX);
    expect(
      Math.abs(anchor!.element!.getBoundingClientRect().top - heldTop),
    ).toBeLessThanOrEqual(0.5);
  });
});
