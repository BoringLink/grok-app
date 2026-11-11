/**
 * Find bar shared by the conversation and the Files pane (Cmd/Ctrl+F).
 * Query + prev/next + match count; Escape closes via parent.
 */

import { useEffect, useRef } from "react";
import {
  IconChevronDown,
  IconChevronLeft,
  IconClose,
  IconSearch,
} from "@/components/icons";
import { formatChatFindCount } from "@/lib/chatFind";
import type { MessageKey } from "@/i18n";

export type ChatFindBarLabels = {
  placeholder: string;
  prev: string;
  next: string;
  close: string;
  /** "{current} / {total}" */
  count: string;
  noMatches: string;
  aria: string;
};

/** Labels for file-pane find bars sharing this component. */
export function findBarLabelsFromT(
  tr: (key: MessageKey) => string,
): ChatFindBarLabels {
  return {
    placeholder: tr("resources.findPh"),
    aria: tr("resources.findAria"),
    prev: tr("chatFind.prev"),
    next: tr("chatFind.next"),
    close: tr("chatFind.close"),
    count: tr("chatFind.count"),
    noMatches: tr("chatFind.noMatches"),
  };
}

export type ChatFindBarProps = {
  query: string;
  activeIndex: number;
  matchCount: number;
  labels: ChatFindBarLabels;
  /** Bump to focus+select the input without remounting the live island. */
  focusNonce?: number;
  /** Distinguishes the conversation bar from the Files pane bar in tests. */
  testId?: string;
  onQueryChange: (q: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
};

export function ChatFindBar({
  query,
  activeIndex,
  matchCount,
  labels,
  focusNonce = 0,
  testId = "chat-find-bar",
  onQueryChange,
  onPrev,
  onNext,
  onClose,
}: ChatFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [focusNonce]);

  const { current, total } = formatChatFindCount(activeIndex, matchCount);
  const countText =
    total === 0
      ? labels.noMatches
      : labels.count
          .replace("{current}", String(current))
          .replace("{total}", String(total));

  return (
    <div
      className="chat-find"
      role="search"
      aria-label={labels.aria}
      data-testid={testId}
    >
      <span className="chat-find__icon" aria-hidden>
        <IconSearch size={15} />
      </span>
      <input
        ref={inputRef}
        type="search"
        className="chat-find__input"
        value={query}
        placeholder={labels.placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={labels.placeholder}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
      />
      <span
        className={
          "chat-find__count" + (total === 0 && query.trim() ? " is-empty" : "")
        }
        aria-live="polite"
      >
        {query.trim() ? countText : ""}
      </span>
      <div className="chat-find__actions">
        <button
          type="button"
          className="chat-find__btn"
          aria-label={labels.prev}
          title={labels.prev}
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          <IconChevronLeft
            size={16}
            className="chat-find__chev chat-find__chev--up"
          />
        </button>
        <button
          type="button"
          className="chat-find__btn"
          aria-label={labels.next}
          title={labels.next}
          disabled={matchCount === 0}
          onClick={onNext}
        >
          <IconChevronDown size={16} />
        </button>
        <button
          type="button"
          className="chat-find__btn chat-find__btn--close"
          aria-label={labels.close}
          title={labels.close}
          onClick={onClose}
        >
          <IconClose size={15} />
        </button>
      </div>
    </div>
  );
}
