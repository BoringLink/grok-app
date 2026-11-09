/**
 * Files workbench top chrome: editor action cluster (or breadcrumb) plus the
 * reload / tree-toggle / open-location actions.
 */

import type { MessageKey } from "@/i18n";
import { OpenLocationButton } from "@/components/OpenLocationButton";
import { ResourceEditorActions } from "@/components/resource-viewer/ResourceEditorActions";
import { Tip } from "@/components/ui/tooltip";
import { IconListTree, IconRefresh } from "@/components/icons";
import { detectAppPlatform, revealInOsLabel } from "@/lib/appPlatform";
import {
  formatOpenEditorErrorMessage,
  resolveOpenEditorError,
} from "@/lib/openEditorHonesty";
import type { FileTab } from "@/components/resource-viewer/types";

export type FilesToolbarProps = {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
  previewTab: FileTab | null;
  activeTab: FileTab | null;
  crumbs: string[];
  projectName?: string | null;
  showEditorChrome: boolean;
  previewDirty: boolean;
  canReloadPreview: boolean;
  treeVisible: boolean;
  absPath: string | null;
  activeLine: number | null;
  openWithTarget: string;
  onOpenTargetChange: (target: string) => void;
  onToggleEdit: () => void;
  onSave: () => void;
  onRevert: () => void;
  onReload: () => void;
  onToggleTree: () => void;
  onOpenError: (message: string) => void;
};

export function FilesToolbar({
  tr,
  previewTab,
  activeTab,
  crumbs,
  projectName,
  showEditorChrome,
  previewDirty,
  canReloadPreview,
  treeVisible,
  absPath,
  activeLine,
  openWithTarget,
  onOpenTargetChange,
  onToggleEdit,
  onSave,
  onRevert,
  onReload,
  onToggleTree,
  onOpenError,
}: FilesToolbarProps) {
  const refreshLabel = previewDirty
    ? tr("resources.unsaved")
    : tr("resources.refresh");
  const treeLabel = treeVisible
    ? tr("resources.collapseTree")
    : tr("resources.expandTree");

  return (
    <div className="rp-files-toolbar" data-testid="files-toolbar">
      {showEditorChrome ? (
        <ResourceEditorActions
          tr={tr}
          editMode={!!previewTab?.editMode}
          saving={!!previewTab?.saving}
          dirty={previewDirty}
          onToggleEdit={onToggleEdit}
          onSave={onSave}
          onRevert={onRevert}
          align="start"
          className="rp-files-toolbar__editor"
          title={previewTab?.relativePath || projectName || ""}
          testIds={{
            edit: "files-editor-edit",
            save: "files-editor-save",
            revert: "files-editor-revert",
          }}
        />
      ) : (
        <div
          className="rp-files-toolbar__crumbs"
          title={activeTab?.relativePath || projectName || ""}
        >
          {crumbs.length === 0 ? (
            <span className="rp-files-toolbar__muted">
              {projectName || tr("resources.files")}
            </span>
          ) : (
            crumbs.map((crumb, index) => (
              <span
                key={`${crumb}-${index}`}
                className="rp-files-toolbar__crumb-wrap"
              >
                {index > 0 ? (
                  <span className="rp-files-toolbar__sep" aria-hidden>
                    ›
                  </span>
                ) : null}
                <span
                  className={
                    "rp-files-toolbar__crumb" +
                    (index === crumbs.length - 1 ? " is-current" : "")
                  }
                >
                  {crumb}
                </span>
              </span>
            ))
          )}
        </div>
      )}
      <div className="rp-files-toolbar__actions">
        <Tip label={refreshLabel}>
          <button
            type="button"
            className="chrome-btn"
            aria-label={refreshLabel}
            data-testid="files-reload"
            disabled={!canReloadPreview}
            onClick={onReload}
          >
            <IconRefresh size={16} />
          </button>
        </Tip>
        <Tip label={treeLabel}>
          <button
            type="button"
            className={
              "chrome-btn main__pane-toggle" + (treeVisible ? " is-on" : "")
            }
            aria-label={treeLabel}
            data-testid="files-tree-toggle"
            onClick={onToggleTree}
          >
            <IconListTree size={16} />
          </button>
        </Tip>
        {absPath ? (
          <OpenLocationButton
            path={absPath}
            line={activeTab?.focusLine ?? activeLine}
            target={openWithTarget}
            onTargetChange={onOpenTargetChange}
            onOpenError={(error) => {
              const resolved = resolveOpenEditorError(error);
              if (resolved.silent) return;
              onOpenError(formatOpenEditorErrorMessage(resolved, tr));
            }}
            compact
            platform={detectAppPlatform()}
            labels={{
              openLocation: tr("resources.open"),
              openHint: tr("main.openLocationHint"),
              openMenu: tr("main.openLocationMenu"),
              finder: revealInOsLabel(tr),
              systemDefault: tr("resources.openDefault"),
              copyPath: tr("attach.copyPath"),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
