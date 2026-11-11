/**
 * Rendered markdown preview with in-place find marks.
 *
 * Keeps the preview mounted while the Files find bar is open, so closing the
 * bar never resets the reading position to the top. Windowed previews mount
 * sections on demand; the mutation observer re-marks after a section mounts.
 */

import { useEffect, useRef } from "react";
import type { Locale } from "@/i18n";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { OverlayScroll } from "@/components/OverlayScroll";
import {
  clearRenderedFindMarks,
  markRenderedFindMatches,
} from "@/lib/domFindMarks";

export type MarkdownFindPreviewProps = {
  text: string;
  locale: Locale;
  findQuery: string;
  findActive: number;
  /** 1-based line of the active hit; keeps windowed previews on-section. */
  findLine?: number | null;
  footer?: string | null;
};

export function MarkdownFindPreview({
  text,
  locale,
  findQuery,
  findActive,
  findLine = null,
  footer = null,
}: MarkdownFindPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    let lastText = "";

    const paint = (scrollActive: boolean) => {
      const active = markRenderedFindMatches(host, findQuery, findActive);
      lastText = host.textContent ?? "";
      if (scrollActive && active && typeof active.scrollIntoView === "function") {
        active.scrollIntoView({ block: "center", inline: "nearest" });
      }
    };

    paint(true);
    // A windowed preview swaps sections in/out; our marks do not change the
    // concatenated text, so comparing it filters out our own mutations.
    const observer = new MutationObserver(() => {
      if ((host.textContent ?? "") === lastText) return;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        paint(false);
      });
    });
    observer.observe(host, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      clearRenderedFindMarks(host);
    };
  }, [findQuery, findActive]);

  return (
    <>
      <OverlayScroll className="rp-editor__preview-scroll">
        <div ref={hostRef} className="rp-editor__preview-body rp-preview__md">
          <MarkdownPreview locale={locale} focusLine={findLine}>
            {text}
          </MarkdownPreview>
        </div>
      </OverlayScroll>
      {footer ? <div className="rp-code__footer">{footer}</div> : null}
    </>
  );
}
