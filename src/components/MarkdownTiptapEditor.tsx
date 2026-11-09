/**
 * Markdown file editor — TipTap + tiptap-markdown.
 * Edits as WYSIWYG, serializes back to Markdown for disk save.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { ChatFindBar, type ChatFindBarLabels } from "@/components/ChatFindBar";
import { Tip } from "@/components/ui/tooltip";
import { findPmTextMatches } from "@/lib/pmFind";
import { useFindSession } from "@/hooks/useFindSession";
import { matchGlobalShortcut } from "@/lib/shortcuts";
import {
  IconBlockquote,
  IconBold,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconSeparator,
  IconStrikethrough,
} from "@/components/icons";

export type MarkdownTiptapLabels = {
  bold: string;
  italic: string;
  strike: string;
  code: string;
  h1: string;
  h2: string;
  h3: string;
  bulletList: string;
  orderedList: string;
  blockquote: string;
  link: string;
  hr: string;
  linkPlaceholder: string;
  linkApply: string;
  placeholder: string;
  editorAria: string;
};

export type MarkdownTiptapEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  onSave?: () => void;
  disabled?: boolean;
  labels: MarkdownTiptapLabels;
  /** Enables in-editor Cmd/Ctrl+F; omit to leave find to the host. */
  findLabels?: ChatFindBarLabels;
  className?: string;
};

function readMarkdown(editor: {
  // tiptap-markdown augments storage at runtime; Storage type stays empty.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storage: any;
}): string {
  try {
    const md = editor.storage?.markdown?.getMarkdown?.();
    return typeof md === "string" ? md : "";
  } catch {
    return "";
  }
}

function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t)) return true;
  return false;
}

export function MarkdownTiptapEditor({
  value,
  onChange,
  onSave,
  disabled = false,
  labels,
  findLabels,
  className = "",
}: MarkdownTiptapEditorProps) {
  const lastEmitted = useRef(value);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Keep hard breaks available; Markdown extension serializes them.
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: {
          class: "rp-md-editor__link",
          rel: "noopener noreferrer",
        },
      }),
      Placeholder.configure({
        placeholder: labels.placeholder,
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: "-",
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "rp-md-editor__prose",
        "aria-label": labels.editorAria,
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          onSave?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = readMarkdown(ed);
      lastEmitted.current = md;
      onChange(md);
    },
  });

  const findDoc = editor?.state.doc ?? null;
  const findPmMatches = useCallback(
    (query: string) => (findDoc ? findPmTextMatches(findDoc, query) : []),
    [findDoc],
  );
  const {
    open: findOpen,
    query: findQuery,
    matches: findMatches,
    active: findActive,
    nonce: findNonce,
    setQuery: setFindQuery,
    openFind,
    close: resetFind,
    step: stepFind,
  } = useFindSession(findPmMatches);
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;
  const closeFind = useCallback(() => {
    resetFind();
    editor?.commands.focus();
  }, [editor, resetFind]);

  // Select the active match and scroll it into view without moving focus away
  // from the find input. Reads the latest matches through a ref so typing in
  // the document does not re-select the match on every transaction.
  const findMatchesRef = useRef(findMatches);
  findMatchesRef.current = findMatches;
  useEffect(() => {
    const match = findMatchesRef.current[findActive];
    if (!editor || !findOpen || !match) return;
    editor.view.dispatch(
      editor.state.tr
        .setSelection(
          TextSelection.create(editor.state.doc, match.from, match.to),
        )
        .scrollIntoView(),
    );
  }, [editor, findActive, findOpen, findQuery]);

  useEffect(() => {
    if (!findLabels) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const root = rootRef.current;
      const target = e.target as Node | null;
      if (!root || !target || !root.contains(target)) return;
      if (e.key === "Escape" && findOpenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
        return;
      }
      const matched = matchGlobalShortcut({
        key: e.key.toLowerCase(),
        mod: e.metaKey || e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        typing: false,
      });
      if (matched !== "findInChat") return;
      e.preventDefault();
      e.stopPropagation();
      openFind();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeFind, findLabels, openFind]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // External value (revert / reload / tab switch content) → editor
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmitted.current) return;
    const current = readMarkdown(editor);
    if (value === current) {
      lastEmitted.current = value;
      return;
    }
    editor.commands.setContent(value);
    lastEmitted.current = value;
  }, [value, editor]);

  useEffect(() => {
    if (linkOpen) {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    }
  }, [linkOpen]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href })
        .run();
    }
    setLinkOpen(false);
  }, [editor, linkUrl]);

  const openLinkUi = useCallback(() => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const { from, to, empty } = editor.state.selection;
    const selected = empty
      ? ""
      : editor.state.doc.textBetween(from, to, " ");
    const existing = editor.getAttributes("link").href as string | undefined;
    if (existing) {
      setLinkUrl(existing);
    } else if (looksLikeUrl(selected)) {
      setLinkUrl(selected.trim());
    } else {
      setLinkUrl("");
    }
    setLinkOpen(true);
  }, [editor]);

  if (!editor) {
    return (
      <div className={"rp-md-editor" + (className ? ` ${className}` : "")}>
        <div className="rp-md-editor__loading" aria-hidden />
      </div>
    );
  }

  const fmt = (
    active: boolean,
    onClick: () => void,
    label: string,
    children: ReactNode,
  ) => (
    <Tip label={label}>
      <button
        type="button"
        className={"rp-md-editor__fmt-btn" + (active ? " is-on" : "")}
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
      >
        {children}
      </button>
    </Tip>
  );

  return (
    <div
      ref={rootRef}
      className={
        "rp-md-editor" +
        (disabled ? " is-disabled" : "") +
        (className ? ` ${className}` : "")
      }
    >
      {findOpen && findLabels ? (
        <ChatFindBar
          query={findQuery}
          activeIndex={findActive}
          matchCount={findMatches.length}
          focusNonce={findNonce}
          testId="md-find-bar"
          labels={findLabels}
          onQueryChange={setFindQuery}
          onPrev={() => stepFind(-1)}
          onNext={() => stepFind(1)}
          onClose={closeFind}
        />
      ) : null}
      <div
        className="rp-md-editor__fmt"
        role="toolbar"
        aria-label={labels.editorAria}
      >
        {fmt(
          editor.isActive("bold"),
          () => editor.chain().focus().toggleBold().run(),
          labels.bold,
          <IconBold size={14} />,
        )}
        {fmt(
          editor.isActive("italic"),
          () => editor.chain().focus().toggleItalic().run(),
          labels.italic,
          <IconItalic size={14} />,
        )}
        {fmt(
          editor.isActive("strike"),
          () => editor.chain().focus().toggleStrike().run(),
          labels.strike,
          <IconStrikethrough size={14} />,
        )}
        {fmt(
          editor.isActive("code"),
          () => editor.chain().focus().toggleCode().run(),
          labels.code,
          <IconCode size={14} />,
        )}
        <span className="rp-md-editor__fmt-sep" aria-hidden />
        {fmt(
          editor.isActive("heading", { level: 1 }),
          () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
          labels.h1,
          <IconH1 size={14} />,
        )}
        {fmt(
          editor.isActive("heading", { level: 2 }),
          () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          labels.h2,
          <IconH2 size={14} />,
        )}
        {fmt(
          editor.isActive("heading", { level: 3 }),
          () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
          labels.h3,
          <IconH3 size={14} />,
        )}
        <span className="rp-md-editor__fmt-sep" aria-hidden />
        {fmt(
          editor.isActive("bulletList"),
          () => editor.chain().focus().toggleBulletList().run(),
          labels.bulletList,
          <IconList size={14} />,
        )}
        {fmt(
          editor.isActive("orderedList"),
          () => editor.chain().focus().toggleOrderedList().run(),
          labels.orderedList,
          <IconListNumbers size={14} />,
        )}
        {fmt(
          editor.isActive("blockquote"),
          () => editor.chain().focus().toggleBlockquote().run(),
          labels.blockquote,
          <IconBlockquote size={14} />,
        )}
        {fmt(
          editor.isActive("link"),
          openLinkUi,
          labels.link,
          <IconLink size={14} />,
        )}
        {fmt(
          false,
          () => editor.chain().focus().setHorizontalRule().run(),
          labels.hr,
          <IconSeparator size={14} />,
        )}
        {linkOpen ? (
          <div className="rp-md-editor__link-row">
            <input
              ref={linkInputRef}
              type="url"
              className="rp-md-editor__link-input"
              value={linkUrl}
              placeholder={labels.linkPlaceholder}
              disabled={disabled}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLink();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setLinkOpen(false);
                  editor.chain().focus().run();
                }
              }}
            />
            <button
              type="button"
              className="rp-md-editor__fmt-btn is-on"
              disabled={disabled}
              onClick={applyLink}
            >
              {labels.linkApply}
            </button>
          </div>
        ) : null}
      </div>
      <div className="rp-md-editor__scroll">
        <EditorContent editor={editor} className="rp-md-editor__content" />
      </div>
    </div>
  );
}
