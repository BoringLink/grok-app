/**
 * Resource markdown preview — short files are one tree; long files window sections.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { Locale } from "@/i18n";
import {
  MARKDOWN_PREVIEW_VIRTUALIZE_THRESHOLD,
  MARKDOWN_SECTION_OVERSCAN,
  computeMarkdownSectionWindow,
  countMarkdownLines,
  initialMarkdownSectionWindow,
  markdownSectionLayout,
  markdownSectionIndexForLine,
  shouldWindowMarkdownPreview,
  splitMarkdownSections,
  type MarkdownSectionWindow,
} from "@/lib/markdownPreviewWindow";

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function windowsEqual(a: MarkdownSectionWindow, b: MarkdownSectionWindow): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.paddingTop === b.paddingTop &&
    a.paddingBottom === b.paddingBottom &&
    a.totalHeight === b.totalHeight
  );
}

export function MarkdownPreview({
  children,
  locale = "en",
  focusLine = null,
}: {
  children: string;
  locale?: Locale;
  /** 1-based source line; windowed previews scroll its section into view. */
  focusLine?: number | null;
}) {
  const text = children || "";
  const lineCount = useMemo(() => countMarkdownLines(text), [text]);
  const windowed = shouldWindowMarkdownPreview(lineCount);
  const sections = useMemo(
    () => (windowed ? splitMarkdownSections(text) : []),
    [text, windowed],
  );
  const layout = useMemo(
    () => (windowed ? markdownSectionLayout(sections) : null),
    [sections, windowed],
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [win, setWin] = useState<MarkdownSectionWindow>(() =>
    initialMarkdownSectionWindow(sections.length, windowed),
  );

  const recompute = useCallback(() => {
    if (!windowed || !layout) {
      setWin((prev) => {
        const next = initialMarkdownSectionWindow(0, false);
        next.end = 0;
        return windowsEqual(prev, next) ? prev : next;
      });
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const scrollParent = scrollParentRef.current ?? findScrollParent(root);
    scrollParentRef.current = scrollParent;
    if (!scrollParent) {
      setWin((prev) => {
        const next = initialMarkdownSectionWindow(
          sections.length,
          true,
          MARKDOWN_SECTION_OVERSCAN,
        );
        return windowsEqual(prev, next) ? prev : next;
      });
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    const next = computeMarkdownSectionWindow({
      offsets: layout.offsets,
      heights: layout.heights,
      totalHeight: layout.total,
      scrollOffset: parentRect.top - rootRect.top,
      viewportHeight: scrollParent.clientHeight,
      overscan: MARKDOWN_SECTION_OVERSCAN,
    });
    setWin((prev) => (windowsEqual(prev, next) ? prev : next));
  }, [layout, sections.length, windowed]);

  useLayoutEffect(() => {
    if (!windowed) return;
    const root = rootRef.current;
    if (!root) return;
    const scrollParent = findScrollParent(root);
    scrollParentRef.current = scrollParent;
    const onScroll = () => recompute();
    scrollParent?.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => recompute());
    ro.observe(root);
    if (scrollParent) ro.observe(scrollParent);
    recompute();
    return () => {
      scrollParent?.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [recompute, windowed, sections.length]);

  // Find navigation: park the section that owns the active source line in the
  // middle of the viewport so its rendered hits mount and stay visible.
  useLayoutEffect(() => {
    if (!windowed || !layout || !focusLine) return;
    const index = markdownSectionIndexForLine(sections, focusLine);
    if (index < 0) return;
    const root = rootRef.current;
    if (!root) return;
    const parent = scrollParentRef.current ?? findScrollParent(root);
    if (!parent) return;
    scrollParentRef.current = parent;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const listOffsetTop =
      rootRect.top - parentRect.top + parent.scrollTop;
    const height = layout.heights[index] ?? 0;
    const target =
      listOffsetTop +
      (layout.offsets[index] ?? 0) -
      Math.max(0, (parent.clientHeight - height) / 2);
    parent.scrollTop = Math.max(0, target);
    recompute();
  }, [focusLine, windowed, layout, sections, recompute]);

  if (!windowed) {
    return <MarkdownBody locale={locale}>{text}</MarkdownBody>;
  }

  const slice = sections.slice(win.start, win.end);

  return (
    <div
      ref={rootRef}
      className="md-preview md-preview--windowed"
      data-virtualized="1"
      data-sections={String(sections.length)}
    >
      {win.paddingTop > 0 ? (
        <div
          className="md-preview__spacer"
          style={{ height: win.paddingTop }}
          aria-hidden
        />
      ) : null}
      {slice.map((section, i) => (
        <div
          key={`${section.startLine}-${win.start + i}`}
          className="md-preview__section"
          data-md-section={section.startLine}
        >
          <MarkdownBody locale={locale}>{section.source}</MarkdownBody>
        </div>
      ))}
      {win.paddingBottom > 0 ? (
        <div
          className="md-preview__spacer"
          style={{ height: win.paddingBottom }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

export { MARKDOWN_PREVIEW_VIRTUALIZE_THRESHOLD };
