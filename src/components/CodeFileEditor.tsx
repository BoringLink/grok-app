/** Syntax-highlighted code file editor (CodeMirror 6). */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentUnit,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Facet, StateField } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import {
  codeEditorLanguageExtension,
} from "@/lib/codeEditorLang";
import {
  codeEditorThemeExtensions,
  readCodeEditorTheme,
} from "@/lib/codeEditorTheme";
import { findFileTextMatches } from "@/lib/filesFind";
import { useFindSession } from "@/hooks/useFindSession";
import { ChatFindBar, type ChatFindBarLabels } from "@/components/ChatFindBar";
import { matchGlobalShortcut } from "@/lib/shortcuts";

export type CodeFileEditorProps = {
  value: string;
  fileName?: string;
  language?: string;
  onChange: (text: string) => void;
  onSave?: () => void;
  disabled?: boolean;
  ariaLabel: string;
  /** Enables the shared in-editor find bar; omit to keep CodeMirror's panel. */
  findLabels?: ChatFindBarLabels;
  /** Bumped by the host to open the bar while focus is outside the editor. */
  findRequest?: number;
};

type EditorProbe = {
  valueLen: number;
  domLen: number;
  width: number;
  height: number;
  lines: number;
};

function readProbe(view: EditorView, value: string): EditorProbe {
  const rect = view.contentDOM.getBoundingClientRect();
  return {
    valueLen: value.length,
    domLen: (view.contentDOM.textContent ?? "").length,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    lines: view.state.doc.lines,
  };
}

const findQueryFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

const findActiveFacet = Facet.define<number, number>({
  combine: (values) => values[0] ?? -1,
});

/** Rebuilds literal match marks from the current document and query. */
const findDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    if (!tr.docChanged && !tr.reconfigured) return decorations;
    const query = tr.state.facet(findQueryFacet);
    if (!query) return Decoration.none;
    const active = tr.state.facet(findActiveFacet);
    const matches = findFileTextMatches(tr.state.doc.toString(), query);
    return Decoration.set(
      matches.map((match, index) =>
        Decoration.mark({
          class:
            index === active
              ? "cm-find-hit cm-find-hit--active"
              : "cm-find-hit",
        }).range(
          match.index,
          Math.min(match.index + query.length, tr.state.doc.length),
        ),
      ),
      true,
    );
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function CodeFileEditor({
  value,
  fileName,
  language,
  onChange,
  onSave,
  disabled = false,
  ariaLabel,
  findLabels,
  findRequest = 0,
}: CodeFileEditorProps): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const editComp = useRef(new Compartment());
  const findComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const [probe, setProbe] = useState<EditorProbe | null>(null);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  const findMatchesFor = useCallback(
    (query: string) => findFileTextMatches(value, query),
    [value],
  );
  const {
    open: findOpen,
    query: findQuery,
    matches: findMatches,
    active: findActive,
    nonce: findNonce,
    setQuery: setFindQuery,
    openFind,
    close: closeFindSession,
    step: stepFind,
  } = useFindSession(findMatchesFor);
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;
  const closeFind = useCallback(() => {
    closeFindSession();
    viewRef.current?.focus();
  }, [closeFindSession]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const saveCmd = () => {
      onSaveRef.current?.();
      return true;
    };

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        highlightSelectionMatches(),
        history(),
        indentUnit.of("  "),
        EditorState.tabSize.of(2),
        keymap.of([
          { key: "Mod-s", run: saveCmd, preventDefault: true },
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        langComp.current.of(codeEditorLanguageExtension(fileName, language)),
        themeComp.current.of(codeEditorThemeExtensions(readCodeEditorTheme())),
        editComp.current.of([
          EditorState.readOnly.of(disabled),
          EditorView.editable.of(!disabled),
        ]),
        findComp.current.of([
          findQueryFacet.of(""),
          findActiveFacet.of(-1),
          findDecorationField,
        ]),
        // Theme extensions already provide Atom One dark/light highlighting.
        // Do not mount defaultHighlightStyle (light-theme ink).
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel,
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    // Packaged WebViews can mount before the flex host has a real box;
    // re-measure so .cm-content gets a non-zero width.
    const measure = () => {
      view.requestMeasure();
      setProbe(readProbe(view, view.state.doc.toString()));
    };
    const raf = window.requestAnimationFrame(() => {
      measure();
      window.setTimeout(measure, 50);
      window.setTimeout(measure, 250);
    });

    return () => {
      window.cancelAnimationFrame(raf);
      view.destroy();
      viewRef.current = null;
    };
    // Mount once per editor instance (parent should key by file tab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) {
      setProbe(readProbe(view, value));
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
    view.requestMeasure();
    setProbe(readProbe(view, value));
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langComp.current.reconfigure(
        codeEditorLanguageExtension(fileName, language),
      ),
    });
  }, [fileName, language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editComp.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    });
  }, [disabled]);

  useEffect(() => {
    const apply = () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeComp.current.reconfigure(
          codeEditorThemeExtensions(readCodeEditorTheme()),
        ),
      });
      view.requestMeasure();
    };
    apply();
    const el = document.documentElement;
    const mo = new MutationObserver(apply);
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // Match marks follow query + active index; the state field rebuilds them
  // automatically when the document changes underneath.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const query = findOpen ? findQuery : "";
    view.dispatch({
      effects: findComp.current.reconfigure([
        findQueryFacet.of(query),
        findActiveFacet.of(findOpen ? findActive : -1),
        findDecorationField,
      ]),
    });
    const match = findOpen ? findMatches[findActive] : undefined;
    if (!match) return;
    const length = Math.min(
      findQuery.length,
      view.state.doc.length - match.index,
    );
    view.dispatch({
      selection: { anchor: match.index, head: match.index + length },
      effects: EditorView.scrollIntoView(match.index, { y: "center" }),
    });
  }, [findActive, findMatches, findOpen, findQuery]);

  useEffect(() => {
    if (findRequest > 0 && findLabels) openFind();
  }, [findRequest, findLabels, openFind]);

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

  const showProbe =
    probe != null &&
    (probe.domLen === 0 ||
      probe.width < 8 ||
      (probe.valueLen > 0 && probe.domLen < Math.min(probe.valueLen, 8)));

  return (
    <div
      ref={rootRef}
      className="rp-code-editor"
      data-testid="code-file-editor"
      style={{ position: "relative", height: "100%", minHeight: 0 }}
    >
      {findOpen && findLabels ? (
        <div className="rp-find-overlay">
          <ChatFindBar
            query={findQuery}
            activeIndex={findActive}
            matchCount={findMatches.length}
            focusNonce={findNonce}
            testId="code-find-bar"
            labels={findLabels}
            onQueryChange={setFindQuery}
            onPrev={() => stepFind(-1)}
            onNext={() => stepFind(1)}
            onClose={closeFind}
          />
        </div>
      ) : null}
      <div ref={hostRef} style={{ height: "100%", minHeight: 0 }} />
      {showProbe ? (
        <div className="rp-code-editor__probe" role="status">
          {`CM probe value=${probe.valueLen} dom=${probe.domLen} lines=${probe.lines} box=${probe.width}x${probe.height}`}
        </div>
      ) : null}
    </div>
  );
}
