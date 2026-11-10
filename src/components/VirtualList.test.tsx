/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import "@/test/jsdomStubs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { OverlayScroll } from "./OverlayScroll";
import { VirtualList } from "./VirtualList";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const items = (n: number) => Array.from({ length: n }, (_, i) => `row-${i}`);

const listAt = (list: string[], scrollToKey?: string | null): ReactElement => (
  <OverlayScroll syncTreeReveal>
    <VirtualList
      items={list}
      getKey={(s) => s}
      renderItem={(s) => <div>{s}</div>}
      rowHeight={30}
      scrollToKey={scrollToKey}
    />
  </OverlayScroll>
);

/** Stub viewport/list geometry so alignment math runs on real numbers. */
const mockViewport = (container: HTMLElement, totalHeight: number) => {
  const viewport = container.querySelector(
    ".overlay-scroll__viewport",
  ) as HTMLElement;
  const root = container.querySelector(".virtual-list") as HTMLElement;
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    value: 300,
  });
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: totalHeight,
    left: 0,
    right: 0,
    width: 200,
    height: totalHeight,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return viewport;
};

describe("VirtualList inside OverlayScroll", () => {
  it("marks the OverlayScroll viewport for scroll-parent lookup", () => {
    const { container } = render(listAt(items(41)));
    expect(
      container.querySelector(".overlay-scroll__viewport"),
    ).toHaveAttribute("data-overlay-scroll-viewport");
  });

  it("renders scrolled rows even when the viewport is overflow:hidden at mount", () => {
    // syncTreeReveal pins overflowY to "hidden" whenever the content does not
    // overflow (jsdom: always) or a reveal animation runs. Resolving the scroll
    // parent by computed overflow in that window skips the real viewport, so
    // the scroll listener lands outside and the render window stays frozen.
    const { container } = render(listAt(items(41)));
    const viewport = mockViewport(container, 41 * 30);
    const root = container.querySelector(".virtual-list") as HTMLElement;
    expect(viewport.style.overflowY).toBe("hidden");
    expect(screen.queryByText("row-30")).not.toBeInTheDocument();

    // Simulate scrolling 30 rows down: the list top sits 900px above the
    // viewport top (rects are what recompute reads, not scrollTop).
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      top: -900,
      bottom: -900 + 41 * 30,
      left: 0,
      right: 0,
      width: 200,
      height: 41 * 30,
      x: 0,
      y: -900,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.scroll(viewport);

    expect(screen.getByText("row-30")).toBeInTheDocument();
  });

  it("does not re-align to scrollToKey when items count changes without a key change", () => {
    // Expanding a directory changes the visible row count. Re-running the
    // alignment pass then yanks the viewport back to the opened file (CLS
    // jump on every directory toggle). A settled key must not re-align.
    const { container, rerender } = render(listAt(items(60), "row-30"));
    const viewport = mockViewport(container, 60 * 30);

    // First alignment pass moves the viewport to the target row.
    expect(viewport.scrollTop).toBeGreaterThan(0);
    const alignedTop = viewport.scrollTop;

    // User scrolled elsewhere after the reveal (simulated), then toggles a
    // directory: count grows, same scrollToKey — the viewport must stay.
    viewport.scrollTop = 0;
    rerender(listAt(items(80), "row-30"));
    expect(viewport.scrollTop).toBe(0);

    // A key change still aligns (row-50 sits lower than row-30).
    rerender(listAt(items(80), "row-50"));
    expect(viewport.scrollTop).toBeGreaterThan(alignedTop);
  });

  it("re-aligns to the same key after it is deselected", () => {
    // FilesWorkspace emits null when the last tab closes; reopening the
    // same file must re-align, so a null key clears the settled guard.
    const { container, rerender } = render(listAt(items(60), "row-30"));
    const viewport = mockViewport(container, 60 * 30);
    expect(viewport.scrollTop).toBeGreaterThan(0);

    viewport.scrollTop = 0;
    rerender(listAt(items(60), null));
    expect(viewport.scrollTop).toBe(0);

    rerender(listAt(items(60), "row-30"));
    expect(viewport.scrollTop).toBeGreaterThan(0);
  });

  it("re-aligns when the key reappears after being absent from items", () => {
    // A filtered-out row must re-align once the filter clears; async root
    // load exercises the same first-appearance path.
    const without30 = items(60).filter((s) => s !== "row-30");
    const { container, rerender } = render(listAt(items(60), "row-30"));
    const viewport = mockViewport(container, 60 * 30);
    expect(viewport.scrollTop).toBeGreaterThan(0);

    viewport.scrollTop = 0;
    rerender(listAt(without30, "row-30"));
    expect(viewport.scrollTop).toBe(0);

    rerender(listAt(items(60), "row-30"));
    expect(viewport.scrollTop).toBeGreaterThan(0);
  });
});
