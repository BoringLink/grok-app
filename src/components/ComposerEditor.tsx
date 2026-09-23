/**
 * TipTap (ProseMirror) composer editor — inline Markdown WYSIWYG.
 *
 * 数据边界：文档态为 ProseMirror 模型；draft / 发送给 CLI 的始终是
 * Markdown 源码（tiptap-markdown 序列化），`[[skill:name]]` /
 * `[[plugin:name]]` token 以原子节点渲染、原样序列化，旧会话数据可直接编辑。
 *
 * IME（中文输入）由 ProseMirror 原生处理，不再需要自研 composition /
 * ZWSP 光标垫片逻辑；slash 调色板范围换算到 Markdown 源码坐标后上报。
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { buildComposerExtensions } from "@/components/composerExtensions";
import { matchPastedUrl } from "@/lib/composerRefToken";
import {
  clipboardLooksLikeMedia,
  clipboardLooksLikeOsFiles,
  clipboardPlainText,
  collectFilesFromDataTransfer,
  isFileUrlOnlyText,
  readClipboardMediaFiles,
} from "@/lib/clipboardPaste";
import {
  installComposerControlHeldTracking,
} from "@/lib/composerSendKey";
import {
  detectSlashRangeOnStored,
} from "@/lib/draftDoc";
import { detectAppPlatform } from "@/lib/appPlatform";
import {
  hugePlainTextFileName,
  hugePlainTextToFile,
  shouldSpillHugePlainText,
} from "@/lib/longAssistantSpill";
import {
  docPosForEditorTextOffset,
  editorTextBeforePos,
  editorTextOffsetForDocPos,
  locateSlashRangeInMarkdown,
  normalizeSerializedMarkdown,
} from "@/lib/composerMarkdown";

const COMPOSER_LINE_PX = 22;
const COMPOSER_MAX_LINES = 10;

/** 编辑器 DOM → Editor 实例注册表（serializeDom / caret 换算入口）。 */
const editorsByDom = new WeakMap<HTMLElement, Editor>();

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

function normalizedMarkdown(editor: Editor): string {
  return normalizeSerializedMarkdown(readMarkdown(editor));
}

/**
 * After an external draft mutation (skill chip insert, history, …) place the
 * caret at this stored offset on the next value projection. `'end'` = after
 * all content. Cleared once consumed.
 */
let pendingStoredCaret: number | "end" | null = null;

/** Request caret placement after the next `value`-driven re-render. */
export function requestComposerStoredCaret(at: number | "end") {
  pendingStoredCaret = at;
}

function takePendingStoredCaret(): number | "end" | null {
  const p = pendingStoredCaret;
  pendingStoredCaret = null;
  return p;
}

/**
 * Contenteditable → stored draft (Markdown source + tokens).
 * `el` must be the live TipTap editor DOM; falls back to textContent when the
 * editor is already unmounted (callers wrap in try/catch).
 */
export function serializeDom(el: HTMLElement): string {
  const editor = editorsByDom.get(el);
  if (!editor || editor.isDestroyed) {
    return el.textContent ?? "";
  }
  return normalizedMarkdown(editor);
}

/** Caret offset as editor-text length before the caret (voice dictation). */
export function getComposerCaretOffset(
  el: HTMLElement | null | undefined,
): number | null {
  const editor = el ? editorsByDom.get(el) : undefined;
  if (!editor || editor.isDestroyed) return null;
  const { from } = editor.state.selection;
  return editorTextOffsetForDocPos(editor.state.doc, from);
}

/**
 * 整篇草稿的编辑器文本（token 按存储形式等长，Markdown 语法字符不计入）。
 * 供调用方把 Markdown 源码偏移换算到编辑器文本空间，见
 * {@link import("@/lib/composerMarkdown").refCaretInEditorText}。
 */
export function getComposerEditorText(
  el: HTMLElement | null | undefined,
): string | null {
  const editor = el ? editorsByDom.get(el) : undefined;
  if (!editor || editor.isDestroyed) return null;
  return editorTextBeforePos(editor.state.doc, editor.state.doc.content.size);
}

/**
 * Keep the contenteditable caret inside the editor scrollport and auto-grow
 * the input up to max lines (same constraints as the previous editor).
 */
export function resizeComposerInput(el: HTMLElement): void {
  const min = COMPOSER_LINE_PX;
  const max = COMPOSER_LINE_PX * COMPOSER_MAX_LINES;
  const prevScrollTop = el.scrollTop;
  const clientH = el.clientHeight;
  const scrollH = el.scrollHeight;

  if (scrollH > clientH + 1 && clientH < max - 1) {
    const nextH = Math.min(Math.max(scrollH, min), max);
    el.style.height = `${nextH}px`;
    if (scrollH > nextH) el.scrollTop = el.scrollHeight - el.clientHeight;
    return;
  }
  if (clientH >= max - 1 && scrollH > clientH + 1) {
    el.style.height = `${max}px`;
    el.scrollTop = el.scrollHeight - el.clientHeight;
    return;
  }
  el.style.height = "auto";
  const contentH = el.scrollHeight;
  const nextH = Math.min(Math.max(contentH, min), max);
  el.style.height = `${nextH}px`;
  if (contentH > nextH) el.scrollTop = prevScrollTop;
}

export type ComposerEditorProps = {
  value: string;
  onChange: (stored: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Accessible name for the contenteditable (screen readers). */
  "aria-label"?: string;
  className?: string;
  /** Browser spellcheck on the editable root. Default false. */
  spellCheck?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
  onSlashQueryChange?: (
    q: { start: number; query: string; end: number } | null,
  ) => void;
  editorRef?: Ref<HTMLDivElement | null>;
  onPasteFiles?: (files: File[]) => void;
  /**
   * When the paste event looks like media but has no File objects (and async
   * Clipboard API also fails), parent should try native OS clipboard.
   * `expectMedia: true` → show a failure toast if nothing was attached.
   */
  onPasteMediaFallback?: (opts?: {
    expectMedia?: boolean;
  }) => void | Promise<void>;
};

export const ComposerEditor = memo(function ComposerEditor({
  value,
  onChange,
  disabled,
  placeholder,
  "aria-label": ariaLabel,
  className,
  spellCheck,
  onKeyDown,
  onContextMenu,
  onSlashQueryChange,
  editorRef,
  onPasteFiles,
  onPasteMediaFallback,
}: ComposerEditorProps) {
  const lastEmitted = useRef(value);
  // 回调经 ref 转发，避免 useEditor / 监听器闭包依赖 props 身份。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSlashRef = useRef(onSlashQueryChange);
  onSlashRef.current = onSlashQueryChange;
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const pasteProps = useRef({ onPasteFiles, onPasteMediaFallback });
  pasteProps.current = { onPasteFiles, onPasteMediaFallback };

  /** 每次文档变更后统一做：序列化上报 + slash 检测 + 高度自适应。 */
  const emitSlash = useCallback((ed: Editor) => {
    const report = onSlashRef.current;
    if (!report) return;
    // caret 前缀用编辑器文本空间（token 等长），/query 再定位回 Markdown 坐标。
    const prefix = editorTextBeforePos(ed.state.doc, ed.state.selection.from);
    const detected = detectSlashRangeOnStored(prefix);
    if (!detected) {
      report(null);
      return;
    }
    const md = normalizedMarkdown(ed);
    const range = locateSlashRangeInMarkdown(md, detected.query);
    if (!range) {
      report(null);
      return;
    }
    report({
      start: range.start,
      query: detected.query,
      end: range.end,
    });
  }, []);

  /** 文档变更：序列化上报 + slash 检测 + 高度自适应。 */
  const syncFromEditor = useCallback(
    (ed: Editor) => {
      const md = normalizedMarkdown(ed);
      if (md !== lastEmitted.current) {
        lastEmitted.current = md;
        onChangeRef.current(md);
      }
      emitSlash(ed);
      resizeComposerInput(ed.view.dom);
    },
    [emitSlash],
  );

  const placePendingCaret = useCallback((ed: Editor) => {
    const pending = takePendingStoredCaret();
    if (pending == null) return;
    const size = ed.state.doc.content.size;
    const pos =
      pending === "end"
        ? size
        : docPosForEditorTextOffset(ed.state.doc, pending);
    // 用 `focus` 而非 `setTextSelection`：外部的 focus（尤其是把选区塌到末尾的那种）
    // 会把光标从落点挤走，这里让落点自己负责聚焦与 DOM 选区同步。
    ed.commands.focus(Math.max(0, Math.min(pos, size)), {
      scrollIntoView: false,
    });
  }, []);

  const createdEditor = useEditor({
    immediatelyRender: false,
    extensions: buildComposerExtensions({
      placeholder: placeholder ?? "",
    }),
    content: value,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: className ?? "composer__input",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel ?? "",
        "aria-placeholder": placeholder ?? "",
        "data-placeholder": placeholder ?? "",
        spellcheck: spellCheck ? "true" : "false",
      },
      handleKeyDown: (_view, event) => {
        // 父级键盘路由（capture 阶段）已优先处理；被 preventDefault 的键
        // （Enter 发送、菜单导航等）不再进入 ProseMirror 默认行为。
        if (event.defaultPrevented) return true;
        return false;
      },
      handlePaste: (view, event) => {
        const cd = event.clipboardData;
        const { onPasteFiles: pasteFiles, onPasteMediaFallback: mediaFallback } =
          pasteProps.current;
        const files = collectFilesFromDataTransfer(cd);
        const plain = clipboardPlainText(cd);

        if ((files.length || clipboardLooksLikeOsFiles(cd)) && pasteFiles) {
          event.preventDefault();
          // Explorer/Finder copy: File blobs are often unreadable; parent
          // prefers native clipboard paths over arrayBuffer.
          pasteFiles(files);
          return true;
        }
        if (pasteFiles && clipboardLooksLikeMedia(cd)) {
          event.preventDefault();
          void (async () => {
            try {
              const asyncFiles = await readClipboardMediaFiles();
              if (asyncFiles.length) {
                pasteFiles(asyncFiles);
                return;
              }
              await mediaFallback?.({ expectMedia: true });
            } catch {
              await mediaFallback?.({ expectMedia: false });
            }
          })();
          return true;
        }
        if (!plain && pasteFiles && mediaFallback) {
          // Empty-looking paste on Mac can still be a pure bitmap clipboard.
          event.preventDefault();
          void (async () => {
            try {
              const asyncFiles = await readClipboardMediaFiles();
              if (asyncFiles.length) pasteFiles(asyncFiles);
              else await mediaFallback({ expectMedia: false });
            } catch {
              /* soft try — no toast when clipboard has no image */
            }
          })();
          return true;
        }
        // Windows: a huge clipboard insert freezes the editor + draft store.
        // Attach as .txt instead — same path as image/file paste.
        if (
          pasteFiles &&
          shouldSpillHugePlainText(plain.length, detectAppPlatform())
        ) {
          event.preventDefault();
          pasteFiles([
            hugePlainTextToFile(plain, hugePlainTextFileName(plain)),
          ]);
          return true;
        }
        if (plain && files.length && isFileUrlOnlyText(plain)) {
          event.preventDefault();
          view.dispatch(
            view.state.tr.insertText(plain, view.state.selection.from),
          );
          return true;
        }
        // 粘贴一整条 http(s) 链接 → 直接成为内联 URL chip（BOR-57）。
        // 只在整段内容就是一个链接时成立；含空白的普通文本照旧走 Markdown。
        const pastedUrl = plain ? matchPastedUrl(plain) : null;
        if (pastedUrl) {
          event.preventDefault();
          view.dispatch(
            view.state.tr.replaceSelectionWith(
              view.state.schema.nodes.refToken.create({
                kind: "url",
                value: pastedUrl,
              }),
            ),
          );
          return true;
        }
        // 其余交给 tiptap-markdown：粘贴的 Markdown 直接解析为 WYSIWYG。
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      syncFromEditor(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      emitSlash(ed);
    },
  });

  // Editor DOM 就绪后对齐外部 editorRef（AppWorkbench 的 focus / resize 入口）。
  useEffect(() => {
    const dom = createdEditor && !createdEditor.isDestroyed
      ? (createdEditor.view.dom as HTMLDivElement)
      : null;
    if (dom) editorsByDom.set(dom, createdEditor!);
    if (typeof editorRef === "function") editorRef(dom);
    else if (editorRef && "current" in editorRef) {
      (editorRef as { current: HTMLDivElement | null }).current = dom;
    }
    return () => {
      if (dom) editorsByDom.delete(dom);
      if (typeof editorRef === "function") editorRef(null);
      else if (editorRef && "current" in editorRef) {
        (editorRef as { current: HTMLDivElement | null }).current = null;
      }
    };
  }, [createdEditor, editorRef]);

  // Mac WKWebView often drops `ctrlKey` on Control+Return; remember Control itself.
  useEffect(() => installComposerControlHeldTracking(), []);

  useEffect(() => {
    if (!createdEditor || createdEditor.isDestroyed) return;
    createdEditor.setEditable(!disabled);
  }, [createdEditor, disabled]);

  // Placeholder 文案随会话状态切换（goalMode 等）：直接更新扩展 options。
  useEffect(() => {
    if (!createdEditor || createdEditor.isDestroyed) return;
    const ext = createdEditor.extensionManager.extensions.find(
      (e) => e.name === "placeholder",
    );
    if (ext) ext.options.placeholder = placeholder ?? "";
  }, [createdEditor, placeholder]);

  // 外部 draft 变更（skill 插入、历史回填、清空）→ 反解析重建文档。
  useEffect(() => {
    if (!createdEditor || createdEditor.isDestroyed) return;
    if (value === lastEmitted.current) {
      placePendingCaret(createdEditor);
      return;
    }
    createdEditor.commands.setContent(value, { emitUpdate: false });
    lastEmitted.current = value;
    placePendingCaret(createdEditor);
    resizeComposerInput(createdEditor.view.dom);
  }, [value, createdEditor, placePendingCaret]);

  // 粘贴文件兜底：React onPaste 覆盖 handlePaste 未拦截的场景（无文件负载）。
  const onPasteFallback = useCallback((e: ClipboardEvent<HTMLDivElement>) => {
    const cd =
      e.clipboardData ??
      (e.nativeEvent as globalThis.ClipboardEvent | undefined)?.clipboardData ??
      null;
    const files = collectFilesFromDataTransfer(cd);
    if (!files.length || !pasteProps.current.onPasteFiles) return;
    e.preventDefault();
    pasteProps.current.onPasteFiles(files);
  }, []);

  const onKeyDownCapture = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // IME 组合期间不下发键盘路由（与旧编辑器一致，229/isComposing）。
      const ne = e.nativeEvent;
      if (ne.isComposing || ne.keyCode === 229) return;
      onKeyDownRef.current?.(e);
    },
    [],
  );

  return (
    <div className="composer-editor-wrap">
      <EditorContent
        editor={createdEditor}
        className="composer-editor-tiptap"
        onKeyDownCapture={onKeyDownCapture}
        onPaste={onPasteFallback}
        onContextMenu={onContextMenu}
      />
    </div>
  );
});
