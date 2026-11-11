/**
 * Files workbench confirmation modals: discard an unsaved draft on close, and
 * resolve an on-disk conflict after an external change.
 */

import type { MessageKey } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";

export type FilesCloseModalsProps = {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
  discardOpen: boolean;
  onDiscardClose: () => void;
  onDiscardConfirm: () => void;
  conflictOpen: boolean;
  onConflictClose: () => void;
  onConflictReload: () => void;
  onConflictOverwrite: () => void;
};

export function FilesCloseModals({
  tr,
  discardOpen,
  onDiscardClose,
  onDiscardConfirm,
  conflictOpen,
  onConflictClose,
  onConflictReload,
  onConflictOverwrite,
}: FilesCloseModalsProps) {
  return (
    <>
      <GlassModal
        open={discardOpen}
        onClose={onDiscardClose}
        title={tr("resources.discardTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onDiscardClose}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={onDiscardConfirm}
            >
              {tr("resources.discardConfirm")}
            </button>
          </>
        }
      >
        <p className="modal__body-text">{tr("resources.discardBody")}</p>
      </GlassModal>

      <GlassModal
        open={conflictOpen}
        onClose={onConflictClose}
        title={tr("resources.conflictTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onConflictReload}
            >
              {tr("resources.conflictReload")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onConflictOverwrite}
            >
              {tr("resources.conflictOverwrite")}
            </button>
          </>
        }
      >
        <p className="modal__body-text">{tr("resources.conflictBody")}</p>
      </GlassModal>
    </>
  );
}
