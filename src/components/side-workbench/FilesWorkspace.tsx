/**
 * Files workbench (Phase 1): dual-row chrome under shared SideTabBar —
 * editor actions (or breadcrumb) + tree toggle +「打开」; one shared tree;
 * multi-file preview driven by parent SideTab file paths.
 * Preview | tree split (not exclusive stack).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { ChatFindBar, findBarLabelsFromT } from "@/components/ChatFindBar";
import { ResourcePreviewBody } from "@/components/resource-viewer/ResourcePreviewBody";
import {
  clampTreeWidth,
  loadTreeWidth,
  persistTreeWidth,
} from "@/components/resource-viewer/helpers";
import type { FileTab, TreeNode } from "@/components/resource-viewer/types";
import { useResourceFileTabs } from "@/components/resource-viewer/useResourceFileTabs";
import {
  readOpenTargetStorage,
  writeOpenTargetStorage,
} from "@/lib/openEditorHonesty";
import { resolveFilesWorkbenchSplitLayout } from "@/lib/resourceTabs";
import {
  expandKeysForResourcePath,
  expandKeysForResourceTreeFilter,
  filterResourceTreeNodes,
  flattenVisibleResourceTree,
  loadTreeExpanded,
  mergeTreeExpandedForFilter,
  replaceResourceTreeChildren,
  saveTreeExpanded,
  sessionChangePathsKey,
} from "@/lib/resourceTree";
import { isResourceDraftDirty } from "@/lib/resourceEdit";
import {
  clampCodebaseSearchLimit,
  CODEBASE_SEARCH_DEBOUNCE_MS,
} from "@/lib/codebaseSearch";
import { activeFileFindLine, findFileTextMatches } from "@/lib/filesFind";
import { matchGlobalShortcut } from "@/lib/shortcuts";
import { useFindSession } from "@/hooks/useFindSession";
import {
  pathBaseName,
  type SessionFileChange,
} from "@/lib/sessionChanges";
import { sshChatRelative, sshRemoteDirToList } from "@/lib/sshChatPath";
import { sshListDirShouldSetPaneError } from "@/lib/sshListDirHonesty";
import { FilesToolbar } from "./FilesToolbar";
import { FilesCloseModals } from "./FilesCloseModals";
import { FilesTreePanel } from "./FilesTreePanel";

export type FilesWorkspaceProps = {
  locale: Locale | string;
  projectPath: string | null;
  /** OpenSSH Host alias — list/read/write go over SSH. */
  sshAlias?: string | null;
  projectName?: string | null;
  /** Shared tree visibility (SideWorkbenchState.treeVisible). */
  treeVisible: boolean;
  onTreeVisibleChange: (v: boolean) => void;
  /**
   * Active file path from Side Workbench (absolute or project-relative).
   * When set, focus/open that path in the shared preview tabs.
   */
  activePath?: string | null;
  /** 1-based line from path:line open request (soft-fail if out of range). */
  activeLine?: number | null;
  activeColumn?: number | null;
  /** Report file open from tree so parent can create/focus a SideTab. */
  onFileOpen?: (path: string, name: string) => void;
  /** Dirty path keys for side-tab dirty markers / close honesty. */
  onDirtyPathsChange?: (paths: string[]) => void;
  /**
   * Parent asks to close a path (side tab ×). Returns false when discard
   * modal is shown instead of closing immediately.
   */
  closePathRequest?: { path: string; token: number } | null;
  onClosePathResult?: (path: string, closed: boolean) => void;
  paneActive?: boolean;
  sessionChanges: SessionFileChange[];
};

const NOOP = () => {};
const NOOP_ASYNC = async () => {};

export function FilesWorkspace({
  locale,
  projectPath,
  sshAlias = null,
  projectName,
  treeVisible,
  onTreeVisibleChange,
  activePath,
  activeLine = null,
  activeColumn = null,
  onFileOpen,
  onDirtyPathsChange,
  closePathRequest,
  onClosePathResult,
  paneActive = true,
  sessionChanges,
}: FilesWorkspaceProps) {
  const tr = useMemo(() => createT(locale as Locale), [locale]);
  const [root, setRoot] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    loadTreeExpanded(projectPath || ""),
  );
  const [loadingTree, setLoadingTree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** Host-wide file name search (project root). Empty → tree filter fallback. */
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [projectHits, setProjectHits] = useState<api.FileIndexHit[]>([]);
  const [searchingProject, setSearchingProject] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchIndexTruncated, setSearchIndexTruncated] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth);
  const [resizingTree, setResizingTree] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const findReturnFocusRef = useRef<HTMLElement | null>(null);
  /** Bumped to open the mounted editor's own find bar (edit mode). */
  const [editorFindRequest, setEditorFindRequest] = useState(0);
  const splitRef = useRef<HTMLDivElement>(null);
  const lastCloseToken = useRef<number | null>(null);
  const pendingSideClosePath = useRef<string | null>(null);
  const [openWithTarget, setOpenWithTarget] = useState(() =>
    readOpenTargetStorage("finder"),
  );

  const persistOpenWithTarget = useCallback((t: string) => {
    setOpenWithTarget(t);
    writeOpenTargetStorage(t);
    void api
      .settingsGet()
      .then((s) => api.settingsSet({ ...s, defaultOpenTarget: t }))
      .catch(() => {
        /* soft-fail — localStorage still holds session default */
      });
  }, []);

  const fileTabs = useResourceFileTabs({
    projectPath,
    sshAlias,
    sideMode: "files",
    tr,
    setError,
  });

  const {
    activeTab,
    activeTabEditable,
    openFile,
    openAbsoluteFile,
    updateActiveDraft,
    saveActiveFile,
    revertActiveDraft,
    toggleActiveEditMode,
    filesTabsEmpty,
    dirtyPaths,
    closeByPath,
    discardTabId,
    setDiscardTabId,
    closeTabForced,
    conflictTabId,
    setConflictTabId,
    reloadActiveFile,
  } = fileTabs;

  const splitLayout = resolveFilesWorkbenchSplitLayout({ treeVisible });
  // Pathless「文件」chip is a tree-only workspace, not a preview target.
  const previewTab = activePath?.trim() ? activeTab : null;

  const previewText = previewTab?.draftText ?? previewTab?.preview?.text ?? "";
  const findFileMatches = useCallback(
    (query: string) => findFileTextMatches(previewText, query),
    [previewText],
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
  } = useFindSession(findFileMatches);
  const findFocusLine = activeFileFindLine(findMatches, findActive);
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;

  const restoreFindFocus = useCallback(() => {
    const back = findReturnFocusRef.current;
    findReturnFocusRef.current = null;
    if (back?.isConnected) back.focus();
  }, []);
  const closeFind = useCallback(() => {
    resetFind();
    restoreFindFocus();
  }, [resetFind, restoreFindFocus]);

  const cancelDiscardClose = useCallback(() => {
    const sidePath = pendingSideClosePath.current;
    setDiscardTabId(null);
    pendingSideClosePath.current = null;
    if (sidePath) onClosePathResult?.(sidePath, false);
  }, [onClosePathResult, setDiscardTabId]);

  const confirmDiscardClose = useCallback(() => {
    const id = discardTabId;
    const sidePath = pendingSideClosePath.current;
    setDiscardTabId(null);
    pendingSideClosePath.current = null;
    if (id) closeTabForced(id);
    if (sidePath) onClosePathResult?.(sidePath, true);
  }, [closeTabForced, discardTabId, onClosePathResult, setDiscardTabId]);

  // A new preview tab (or edit mode) ends the find session so focus and
  // query never leak across files.
  useEffect(() => {
    resetFind();
  }, [previewTab?.id, previewTab?.editMode, resetFind]);

  // Window capture runs before the App shell's document-level ⌘F handler, so
  // the pane can claim find without editing AppWorkbench.
  const findContextRef = useRef({
    hasPreview: false,
    canFind: false,
    editMode: false,
  });
  findContextRef.current = {
    hasPreview: !!previewTab,
    canFind: !!previewText,
    editMode: !!previewTab?.editMode,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const root = paneRef.current;
      const target = e.target as Node | null;
      const element = target instanceof Element ? target : null;
      const insidePane = !!root && !!target && root.contains(target);
      // Preview surfaces have no focusable text node. When the Files pane is
      // the active aside, claim the chord from an unfocused body/page target
      // so read-only previews are searchable; real inputs keep the
      // conversation find.
      const previewOwnsChord =
        !insidePane &&
        paneActive &&
        findContextRef.current.hasPreview &&
        !element?.closest(
          "input, textarea, select, [contenteditable='true'], .cm-editor, .ProseMirror",
        );
      if (!insidePane && !previewOwnsChord) return;

      if (e.key === "Escape" && findOpenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        resetFind();
        restoreFindFocus();
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

      // CodeMirror and TipTap editors own their find bar.
      if (element?.closest?.(".cm-editor, .ProseMirror")) return;
      // Tree-only pane keeps the conversation find.
      if (!findContextRef.current.hasPreview) return;
      // Edit mode: focus may sit on the toolbar or page body. Ask the mounted
      // editor to open its own bar instead of the preview bar, which cannot
      // mark or scroll the live editor.
      if (findContextRef.current.editMode) {
        e.preventDefault();
        e.stopPropagation();
        setEditorFindRequest((current) => current + 1);
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      // Binary / office previews have no searchable text: claim the chord so
      // it cannot open the conversation find.
      if (!findContextRef.current.canFind) return;
      const active = document.activeElement;
      findReturnFocusRef.current =
        insidePane && active instanceof HTMLElement ? active : null;
      openFind();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openFind, paneActive, resetFind, restoreFindFocus]);

  useEffect(() => {
    onDirtyPathsChange?.(dirtyPaths);
  }, [dirtyPaths, onDirtyPathsChange]);

  useEffect(() => {
    if (!closePathRequest) return;
    if (lastCloseToken.current === closePathRequest.token) return;
    lastCloseToken.current = closePathRequest.token;
    const closed = closeByPath(closePathRequest.path);
    if (closed) {
      pendingSideClosePath.current = null;
      onClosePathResult?.(closePathRequest.path, true);
    } else {
      // Discard modal open — remember path for confirm.
      pendingSideClosePath.current = closePathRequest.path;
    }
  }, [closePathRequest, closeByPath, onClosePathResult]);

  const loadDir = useCallback(
    async (relative: string): Promise<TreeNode[]> => {
      if (!projectPath || !api.isTauri()) return [];
      try {
        if (sshAlias) {
          const dir = sshRemoteDirToList(projectPath, relative);
          if (!dir) {
            setError(tr("resources.openFailed"));
            return [];
          }
          const listing = await api.sshListDir(sshAlias, dir);
          if (!listing.ok) {
            if (
              sshListDirShouldSetPaneError({
                relative,
                result: listing,
              })
            ) {
              setError(listing.error || tr("resources.openFailed"));
            }
            return [];
          }
          setError(null);
          return (listing.entries || []).map((e) => {
            const rel = relative ? `${relative.replace(/\/+$/, "")}/${e.name}` : e.name;
            const ext = e.isDir
              ? ""
              : (e.name.split(".").pop() || "").toLowerCase();
            return {
              name: e.name,
              relativePath: rel,
              isDir: !!e.isDir,
              size: 0,
              ext,
              children: e.isDir ? [] : undefined,
              loaded: !e.isDir,
            };
          });
        }
        const entries = await api.fsListDir(projectPath, relative);
        return (entries || []).map((e) => ({
          name: e.name,
          relativePath: e.relativePath || e.name,
          isDir: !!e.isDir,
          size: typeof e.size === "number" ? e.size : 0,
          ext: e.ext || "",
          children: e.isDir ? [] : undefined,
          loaded: !e.isDir,
        }));
      } catch (e) {
        setError(String(e));
        throw e;
      }
    },
    [projectPath, sshAlias, tr],
  );

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setRoot([]);
      return;
    }
    setLoadingTree(true);
    try {
      setRoot(await loadDir(""));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingTree(false);
    }
  }, [loadDir, projectPath]);

  useEffect(() => {
    void refresh();
    setExpanded(loadTreeExpanded(projectPath || ""));
    setQuery("");
    setDebouncedQuery("");
    setProjectHits([]);
    resetFind();
  }, [projectPath]); // eslint-disable-line react-hooks/exhaustive-deps -- refresh on path only

  // Host search covers the whole project; SSH / browser hosts keep the
  // loaded-tree filter (no remote rg endpoint yet).
  const hostSearchEnabled = !sshAlias && api.isTauri();

  useEffect(() => {
    if (!hostSearchEnabled || !query.trim()) {
      setDebouncedQuery("");
      return;
    }
    const id = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      CODEBASE_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [query, hostSearchEnabled]);

  useEffect(() => {
    if (!hostSearchEnabled || !debouncedQuery) {
      setProjectHits([]);
      setSearchingProject(false);
      setSearchTruncated(false);
      setSearchIndexTruncated(false);
      setSearchFailed(false);
      return;
    }
    let cancelled = false;
    setSearchingProject(true);
    setSearchFailed(false);
    void api
      .projectFileIndexSearch({
        projectPath: projectPath || "",
        query: debouncedQuery,
        limit: clampCodebaseSearchLimit(100),
      })
      .then((res) => {
        if (cancelled) return;
        setProjectHits(res.hits || []);
        setSearchTruncated(!!res.truncated);
        setSearchIndexTruncated(!!res.indexTruncated);
        // Untrusted / missing roots surface as softFail — do not report them
        // as an empty result.
        setSearchFailed(!!res.softFail);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("[files] project file search failed", e);
        setProjectHits([]);
        setSearchTruncated(false);
        setSearchIndexTruncated(false);
        setSearchFailed(true);
      })
      .finally(() => {
        if (!cancelled) setSearchingProject(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, hostSearchEnabled, projectPath]);

  // Persist expand map when it changes (per project).
  useEffect(() => {
    if (!projectPath) return;
    saveTreeExpanded(projectPath, expanded);
  }, [expanded, projectPath]);

  const { sessionChangeRevisionKey, completedChangeRevisionKey } = useMemo(() => {
    const revisions = sessionChanges.map((change) => {
      const status = change.status.trim().toLowerCase();
      return {
        key: `${change.path}\u001f${change.toolCallId?.trim() || ""}\u001f${status}`,
        status,
      };
    });
    return {
      sessionChangeRevisionKey: sessionChangePathsKey(
        revisions.map((revision) => revision.key),
      ),
      completedChangeRevisionKey: sessionChangePathsKey(
        revisions
          .filter((revision) => revision.status === "completed")
          .map((revision) => revision.key),
      ),
    };
  }, [sessionChanges]);
  const sessionChangeRevisionSeen = useRef("");
  const completedChangeRevisionSeen = useRef("");
  const softRefreshGeneration = useRef(0);
  const expandedRef = useRef(expanded);
  const rootRef = useRef(root);
  expandedRef.current = expanded;
  rootRef.current = root;

  useEffect(() => {
    sessionChangeRevisionSeen.current = "";
    completedChangeRevisionSeen.current = "";
    softRefreshGeneration.current += 1;
  }, [projectPath]);

  const softRefreshTree = useCallback(async () => {
    if (!projectPath) return;
    const generation = ++softRefreshGeneration.current;
    const isCurrent = () => generation === softRefreshGeneration.current;
    const previousRoot = rootRef.current;
    let refreshError: string | null = null;
    try {
      let next = await loadDir("");
      if (!isCurrent()) return;
      const openDirs = Object.entries(expandedRef.current)
        .filter(([, open]) => open)
        .map(([path]) => path)
        .filter(Boolean);
      for (const dir of openDirs) {
        try {
          const children = await loadDir(dir);
          if (!isCurrent()) return;
          next = replaceResourceTreeChildren(next, dir, children);
        } catch (e) {
          if (!isCurrent()) return;
          const find = (nodes: TreeNode[]): TreeNode | undefined => {
            for (const node of nodes) {
              if (node.relativePath === dir) return node;
              const nested = node.children?.length
                ? find(node.children)
                : undefined;
              if (nested) return nested;
            }
            return undefined;
          };
          const previousChildren = find(previousRoot)?.children;
          if (previousChildren) {
            next = replaceResourceTreeChildren(next, dir, previousChildren);
          }
          refreshError = String(e);
        }
      }
      if (!isCurrent()) return;
      if (refreshError) setError(refreshError);
      setRoot(next);
    } catch (e) {
      if (isCurrent()) setError(String(e));
    }
  }, [loadDir, projectPath]);

  useEffect(() => {
    if (!projectPath || !paneActive) return;
    if (sessionChangeRevisionSeen.current === sessionChangeRevisionKey) return;
    sessionChangeRevisionSeen.current = sessionChangeRevisionKey;
    const completedChanged =
      completedChangeRevisionSeen.current !== completedChangeRevisionKey;
    completedChangeRevisionSeen.current = completedChangeRevisionKey;
    if (!completedChanged || !completedChangeRevisionKey) return;
    void softRefreshTree();
  }, [
    sessionChangeRevisionKey,
    completedChangeRevisionKey,
    projectPath,
    paneActive,
    softRefreshTree,
  ]);

  // Focus/open when Side Workbench active file path changes.
  // Directories stay on empty preview; always expand the tree to that path.
  useEffect(() => {
    if (!paneActive || !activePath?.trim()) return;
    const p = activePath.trim();
    let cancelled = false;
    void (async () => {
      const root = (projectPath || "")
        .replace(/[/\\]+$/, "")
        .replace(/\\/g, "/");
      const norm = p.replace(/[/\\]+$/, "").replace(/\\/g, "/");
      if (root && (norm === root || norm === "")) return;

      const rel = root
        ? sshChatRelative(root, norm) ||
          (norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : norm)
        : norm;
      {
        try {
          const top = await loadDir("");
          if (cancelled) return;
          setRoot(top);
        } catch {
          if (cancelled) return;
        }
      }

      const base = norm.split("/").pop() || norm;
      const looksLikeFile = base.includes(".") && !base.endsWith(".");
      let isDir = false;
      if (!looksLikeFile && api.isTauri()) {
        if (sshAlias) {
          try {
            const listing = await api.sshListDir(sshAlias, norm);
            if (cancelled) return;
            isDir = !!listing.ok;
          } catch {
            /* try as file */
          }
        } else {
          try {
            const classified = await api.pathsClassify([p]);
            if (cancelled) return;
            const entry = classified?.[0];
            if (entry?.exists && entry.isDir) isDir = true;
          } catch {
            /* classify soft-fail → try open as file */
          }
        }
      }

      const dirKeys = expandKeysForResourcePath(rel, { includeSelfIfDir: isDir });
      if (dirKeys.length) {
        setExpanded((e) => {
          const next = { ...e };
          for (const k of dirKeys) next[k] = true;
          return next;
        });
        let loadedRel = "";
        for (const key of dirKeys) {
          if (cancelled) return;
          try {
            const kids = await loadDir(key);
            if (cancelled) return;
            setRoot((r) => replaceResourceTreeChildren(r, key, kids));
            loadedRel = key;
          } catch {
            if (cancelled) return;
          }
        }
        void loadedRel;
      }

      if (cancelled || isDir) return;
      void openAbsoluteFile(p, undefined, {
        line: activeLine,
        column: activeColumn,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, activeLine, activeColumn, paneActive, projectPath, sshAlias]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDir = useCallback(
    async (node: TreeNode) => {
      const key = node.relativePath;
      const isOpen = !!expanded[key];
      if (isOpen) {
        setExpanded((e) => {
          const n = { ...e };
          delete n[key];
          return n;
        });
        return;
      }
      setExpanded((e) => ({ ...e, [key]: true }));
      if (!node.loaded) {
        try {
          const kids = await loadDir(node.relativePath);
          setRoot((r) => replaceResourceTreeChildren(r, key, kids));
        } catch (e) {
          setError(String(e));
        }
      }
    },
    [expanded, loadDir],
  );

  const filteredRoot = useMemo(
    () => filterResourceTreeNodes(root, query) as TreeNode[],
    [root, query],
  );

  const displayExpanded = useMemo(() => {
    if (!query.trim()) return expanded;
    const force = expandKeysForResourceTreeFilter(root, query);
    return mergeTreeExpandedForFilter(expanded, force);
  }, [expanded, query, root]);

  const onTreeFileClick = useCallback(
    async (relativePath: string, name: string) => {
      // Opening a file never flips tree off — split stays preview | tree.
      await openFile(relativePath);
      onFileOpen?.(relativePath, name || pathBaseName(relativePath));
    },
    [openFile, onFileOpen],
  );

  const visibleRows = useMemo(
    () => flattenVisibleResourceTree(filteredRoot, displayExpanded),
    [filteredRoot, displayExpanded],
  );
  const selectedTreeKey =
    activeTab?.relativePath || activeTab?.absolutePath || null;

  // Tree resize — persist final width via functional update (no stale width).
  useEffect(() => {
    if (!resizingTree) return;
    const onMove = (e: PointerEvent) => {
      const el = splitRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Tree is on the right; width from pointer to right edge.
      const next = clampTreeWidth(rect.right - e.clientX, rect.width);
      setTreeWidth(next);
    };
    const onUp = () => {
      setResizingTree(false);
      setTreeWidth((w) => {
        const box = splitRef.current?.getBoundingClientRect();
        return persistTreeWidth(w, box?.width ?? 800);
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizingTree]);

  const absPath =
    previewTab?.absolutePath ||
    (projectPath && previewTab?.relativePath
      ? `${projectPath.replace(/\/$/, "")}/${previewTab.relativePath.replace(/^\//, "")}`
      : projectPath);

  const crumbs = useMemo(() => {
    const rel = previewTab?.relativePath || "";
    if (!rel) return [] as string[];
    return rel.replace(/\\/g, "/").split("/").filter(Boolean);
  }, [previewTab?.relativePath]);

  const previewDirty = isResourceDraftDirty(
    previewTab?.draftText,
    previewTab?.baselineText,
  );
  const canReloadPreview =
    !!previewTab &&
    previewTab.tabKind !== "url" &&
    !previewTab.loading &&
    !previewDirty;
  const showEditorChrome =
    !!previewTab &&
    previewTab.tabKind !== "url" &&
    !!activeTabEditable &&
    previewTab.draftText != null;

  const showProjectHits = hostSearchEnabled && !!query.trim();
  // While the debounce runs, `debouncedQuery` still holds the previous term.
  const projectSearchPending =
    showProjectHits &&
    (searchingProject || query.trim() !== debouncedQuery);

  if (!projectPath) {
    return (
      <div className="sw-files" data-testid="files-workspace">
        <div className="rp__empty-state">
          <div className="rp__empty-title">{tr("main.noProject")}</div>
          <div className="rp__empty-desc">{tr("resources.needProject")}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={paneRef}
      className="sw-files rp--embedded"
      data-testid="files-workspace"
    >
      <FilesToolbar
        tr={tr}
        previewTab={previewTab}
        activeTab={activeTab}
        crumbs={crumbs}
        projectName={projectName}
        showEditorChrome={showEditorChrome}
        previewDirty={previewDirty}
        canReloadPreview={canReloadPreview}
        treeVisible={treeVisible}
        absPath={absPath}
        activeLine={activeLine}
        openWithTarget={openWithTarget}
        onOpenTargetChange={persistOpenWithTarget}
        onToggleEdit={toggleActiveEditMode}
        onSave={() => void saveActiveFile()}
        onRevert={() => revertActiveDraft()}
        onReload={() => void reloadActiveFile()}
        onToggleTree={() => onTreeVisibleChange(!treeVisible)}
        onOpenError={setError}
      />

      {error ? (
        <div className="rp__error" role="alert">
          {error}
        </div>
      ) : null}

      <div
        ref={splitRef}
        className={
          "rp-split" +
          (splitLayout.mode === "solo" ? " rp-split--solo" : "") +
          (resizingTree ? " is-resizing" : "")
        }
        data-split-mode={splitLayout.mode}
      >
        <div className="rp-split__preview">
          {findOpen ? (
            <div className="rp-find-overlay">
              <ChatFindBar
                query={findQuery}
                activeIndex={findActive}
                matchCount={findMatches.length}
                focusNonce={findNonce}
                testId="files-find-bar"
                labels={findBarLabelsFromT(tr)}
                onQueryChange={setFindQuery}
                onPrev={() => stepFind(-1)}
                onNext={() => stepFind(1)}
                onClose={closeFind}
              />
            </div>
          ) : null}
          {(() => {
            // Directory / failed "not a file" → empty placeholder, not an error wall.
            const isDirOpenError =
              !!previewTab?.error &&
              /not a file/i.test(previewTab.error);
            const emptyPres = filesTabsEmpty;
            const showEmpty =
              !previewTab ||
              isDirOpenError ||
              (!previewTab.loading && !previewTab.preview && !previewTab.error);
            if (showEmpty && !previewTab?.loading) {
              return (
                <div
                  className="rp__empty-state"
                  data-testid="files-preview-empty"
                >
                  <div className="rp__empty-title">
                    {tr(emptyPres?.titleKey ?? "resources.emptyPreview")}
                  </div>
                  <div className="rp__empty-desc">
                    {tr(emptyPres?.hintKey ?? "resources.emptyPreviewHint")}
                  </div>
                </div>
              );
            }
            if (previewTab?.loading) {
              return (
                <div className="rp__empty-state">
                  <div className="rp__empty-desc">{tr("resources.loading")}</div>
                </div>
              );
            }
            return (
              <ResourcePreviewBody
                tr={tr}
                locale={locale as Locale}
                sideMode="files"
                diffView={null}
                diffLayout="unified"
                setDiffLayout={NOOP as (v: "unified" | "split") => void}
                activeTab={previewTab as FileTab}
                projectPath={projectPath}
                pathCopyFlash={false}
                diffDecisionByPath={{}}
                restorableAfterByPath={{}}
                diffActionBusy={false}
                diffHunks={[]}
                remainingHunkCount={0}
                setDiffCommentError={NOOP}
                setDiffCommentNote={NOOP}
                setDiffCommentTarget={NOOP}
                openChangeInEditor={NOOP}
                openChangeInPane={NOOP}
                revealChangePath={NOOP}
                copyChangePath={NOOP}
                updateActiveDraft={updateActiveDraft}
                saveActiveFile={saveActiveFile}
                revertActiveDraft={revertActiveDraft}
                toggleActiveEditMode={toggleActiveEditMode}
                runAcceptFile={NOOP_ASYNC}
                requestRejectFile={NOOP}
                runRestoreFile={NOOP_ASYNC}
                runAcceptHunk={NOOP_ASYNC}
                runRejectHunk={NOOP_ASYNC}
                requestBatchAcceptHunks={NOOP}
                requestBatchRejectHunks={NOOP}
                hideToolbar={showEditorChrome}
                findFocusLine={findOpen ? findFocusLine : null}
                findMode={findOpen && !!findQuery.trim()}
                findQuery={findOpen ? findQuery : ""}
                findActive={findOpen ? findActive : -1}
                findRequest={editorFindRequest}
              />
            );
          })()}
        </div>
        {splitLayout.mode === "split" ? (
          <FilesTreePanel
            tr={tr}
            width={treeWidth}
            query={query}
            onQueryChange={setQuery}
            hostSearchEnabled={hostSearchEnabled}
            showProjectHits={showProjectHits}
            projectSearchPending={projectSearchPending}
            searchFailed={searchFailed}
            projectHits={projectHits}
            searchTruncated={searchTruncated}
            searchIndexTruncated={searchIndexTruncated}
            loadingTree={loadingTree}
            treeEmpty={filteredRoot.length === 0}
            rows={visibleRows}
            activeTab={activeTab}
            expanded={displayExpanded}
            selectedTreeKey={selectedTreeKey}
            onOpenFile={onTreeFileClick}
            onToggleDir={toggleDir}
            onResizeStart={() => setResizingTree(true)}
          />
        ) : null}
      </div>

      <FilesCloseModals
        tr={tr}
        discardOpen={!!discardTabId}
        onDiscardClose={cancelDiscardClose}
        onDiscardConfirm={confirmDiscardClose}
        conflictOpen={!!conflictTabId}
        onConflictClose={() => setConflictTabId(null)}
        onConflictReload={() => {
          setConflictTabId(null);
          void reloadActiveFile();
        }}
        onConflictOverwrite={() => {
          setConflictTabId(null);
          void saveActiveFile({ force: true });
        }}
      />
    </div>
  );
}
