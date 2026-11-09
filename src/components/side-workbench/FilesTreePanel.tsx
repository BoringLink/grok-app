/**
 * Files tree column: resize handle, project-wide search field, flat search
 * results, and the virtualized project tree.
 */

import type { PointerEvent } from "react";
import type { MessageKey } from "@/i18n";
import * as api from "@/lib/api";
import { OverlayScroll } from "@/components/OverlayScroll";
import { VirtualList } from "@/components/VirtualList";
import { FileKindMark } from "@/components/resource-viewer/FileKindMark";
import { TREE_WIDTH_MIN } from "@/components/resource-viewer/helpers";
import type { FileTab, TreeNode } from "@/components/resource-viewer/types";
import {
  RESOURCE_TREE_ROW_HEIGHT_PX,
  RESOURCE_TREE_VIRTUALIZE_THRESHOLD,
  type VisibleResourceTreeRow,
} from "@/lib/resourceTree";
import {
  IconChevronDown,
  IconChevronRight,
  IconSearch,
} from "@/components/icons";

/** Chevron/gap + kind mark shared by tree rows and flat search-result rows. */
function TreeRowLeading({
  name,
  isDir,
  open = false,
}: {
  name: string;
  isDir: boolean;
  open?: boolean;
}) {
  return (
    <>
      <span className="rp-tree__chev">
        {isDir ? (
          open ? (
            <IconChevronDown size={14} />
          ) : (
            <IconChevronRight size={14} />
          )
        ) : (
          <span className="rp-tree__gap" />
        )}
      </span>
      <FileKindMark name={name} isDir={isDir} />
    </>
  );
}

export type FilesTreePanelProps = {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
  width: number;
  query: string;
  onQueryChange: (value: string) => void;
  hostSearchEnabled: boolean;
  showProjectHits: boolean;
  projectSearchPending: boolean;
  searchFailed: boolean;
  projectHits: readonly api.FileIndexHit[];
  searchTruncated: boolean;
  searchIndexTruncated: boolean;
  loadingTree: boolean;
  treeEmpty: boolean;
  rows: readonly VisibleResourceTreeRow<TreeNode>[];
  activeTab: FileTab | null;
  expanded: Record<string, boolean>;
  selectedTreeKey: string | null;
  onOpenFile: (relativePath: string, name: string) => void | Promise<void>;
  onToggleDir: (node: TreeNode) => void | Promise<void>;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
};

export function FilesTreePanel({
  tr,
  width,
  query,
  onQueryChange,
  hostSearchEnabled,
  showProjectHits,
  projectSearchPending,
  searchFailed,
  projectHits,
  searchTruncated,
  searchIndexTruncated,
  loadingTree,
  treeEmpty,
  rows,
  activeTab,
  expanded,
  selectedTreeKey,
  onOpenFile,
  onToggleDir,
  onResizeStart,
}: FilesTreePanelProps) {
  return (
    <>
      <div
        className="rp-split__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-label={tr("resources.resizeTree")}
        onPointerDown={(event) => {
          event.preventDefault();
          onResizeStart(event);
        }}
      />
      <div
        className="rp-split__tree"
        style={{
          width,
          flex: `0 0 ${Math.max(TREE_WIDTH_MIN, width)}px`,
          maxWidth: width,
        }}
        data-testid="files-tree"
      >
        <div className="rp-tree-search">
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={tr("resources.searchPh")}
            aria-label={tr("resources.searchPh")}
          />
        </div>
        {!hostSearchEnabled && query.trim() ? (
          <div className="rp-tree__search-note">
            {tr("resources.searchLocalOnly")}
          </div>
        ) : null}
        <OverlayScroll className="rp-tree-scroll">
          {showProjectHits ? (
            projectSearchPending ? (
              <div className="rp__empty-desc" style={{ padding: 12 }}>
                {tr("resources.searching")}
              </div>
            ) : searchFailed ? (
              <div className="rp__empty-desc" style={{ padding: 12 }}>
                {tr("resources.searchFailed")}
              </div>
            ) : projectHits.length === 0 ? (
              <div className="rp__empty-desc" style={{ padding: 12 }}>
                {tr("resources.searchEmpty")}
              </div>
            ) : (
              <>
                <VirtualList
                  items={projectHits}
                  getKey={(hit) => hit.path || hit.relativePath}
                  rowHeight={RESOURCE_TREE_ROW_HEIGHT_PX}
                  threshold={RESOURCE_TREE_VIRTUALIZE_THRESHOLD}
                  renderItem={(hit) => {
                    const selected =
                      !!activeTab &&
                      (activeTab.relativePath === hit.relativePath ||
                        activeTab.absolutePath === hit.path);
                    return (
                      <button
                        type="button"
                        className={
                          "rp-tree__row rp-tree__row--search" +
                          (selected ? " is-selected" : "")
                        }
                        style={{ paddingLeft: 8 }}
                        title={hit.relativePath || hit.path}
                        disabled={!hit.relativePath}
                        onClick={() => {
                          if (!hit.relativePath) return;
                          void onOpenFile(hit.relativePath, hit.name);
                        }}
                      >
                        <TreeRowLeading name={hit.name} isDir={false} />
                        <span className="rp-tree__name">{hit.name}</span>
                        <span className="rp-tree__search-path">
                          {hit.relativePath || hit.path}
                        </span>
                      </button>
                    );
                  }}
                />
                {searchTruncated ? (
                  <div className="rp-tree__search-note">
                    {tr("resources.searchTruncated", {
                      count: String(projectHits.length),
                    })}
                  </div>
                ) : null}
                {searchIndexTruncated ? (
                  <div className="rp-tree__search-note">
                    {tr("resources.searchIndexPartial")}
                  </div>
                ) : null}
              </>
            )
          ) : loadingTree ? (
            <div className="rp__empty-desc" style={{ padding: 12 }}>
              {tr("resources.loading")}
            </div>
          ) : treeEmpty ? (
            <div className="rp__empty-desc" style={{ padding: 12 }}>
              {query.trim()
                ? tr("resources.filterEmpty")
                : tr("resources.empty")}
            </div>
          ) : (
            <VirtualList
              items={rows}
              getKey={(row) => row.node.relativePath || row.node.name}
              rowHeight={RESOURCE_TREE_ROW_HEIGHT_PX}
              threshold={RESOURCE_TREE_VIRTUALIZE_THRESHOLD}
              scrollToKey={selectedTreeKey}
              renderItem={(row) => {
                const node = row.node;
                const open = !!expanded[node.relativePath];
                const selected =
                  !!activeTab &&
                  (activeTab.relativePath === node.relativePath ||
                    activeTab.absolutePath === node.relativePath);
                return (
                  <button
                    type="button"
                    className={
                      "rp-tree__row" + (selected ? " is-selected" : "")
                    }
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                    onClick={() => {
                      if (node.isDir) void onToggleDir(node);
                      else void onOpenFile(node.relativePath, node.name);
                    }}
                  >
                    <TreeRowLeading
                      name={node.name}
                      isDir={node.isDir}
                      open={open}
                    />
                    <span className="rp-tree__name">{node.name}</span>
                  </button>
                );
              }}
            />
          )}
        </OverlayScroll>
      </div>
    </>
  );
}
