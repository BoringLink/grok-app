/**
 * Per-model metadata for a custom provider: context window, reasoning levels,
 * and whether the model supports reasoning at all. Legacy image/video flags
 * stay on the stored row but are not editable here.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { GlassModal } from "@/components/GlassModal";
import { UiCheck } from "@/components/settings/shared";
import { IconHelp, IconPlus, IconTrash } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import { createT, type Locale } from "@/i18n";
import type {
  ProviderEffortEntry,
  ProviderModelFieldSource,
} from "@/lib/api";
import type { FormModel } from "@/lib/providerForm";
import {
  DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW,
  defaultProviderModelEfforts,
  effectiveModelContextWindow,
  effectiveModelEfforts,
  effectiveModelSupportsReasoningEffort,
  normalizeModelEfforts,
  type RemoteModelMetadata,
} from "@/lib/providerModelConfig";

export type ProviderModelSettingsValue = {
  contextWindow: number;
  contextWindowSource: ProviderModelFieldSource;
  efforts: ProviderEffortEntry[];
  effortsSource: ProviderModelFieldSource;
  supportsReasoningEffort: boolean;
  supportsReasoningEffortSource: ProviderModelFieldSource;
};

type DraftEffort = { id: string; name: string; isDefault: boolean };

function FieldHelp({ label, tip }: { label: string; tip: string }) {
  return (
    <span className="prov-field__label">
      <span>{label}</span>
      <Tip label={tip} placement="top" className="ui-tip--wrap" delayMs={280}>
        <button
          type="button"
          className="settings-label-help"
          aria-label={tip}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconHelp size={14} stroke={1.75} />
        </button>
      </Tip>
    </span>
  );
}

/** Strict positive integer: separators are friendly, decimals are not. */
function parseWindow(raw: string): number | null {
  const normalized = raw.replace(/[_\s,]/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function toDraftEfforts(list: ProviderEffortEntry[]): DraftEffort[] {
  return normalizeModelEfforts(list).map((effort) => ({
    id: effort.id,
    name: effort.name?.trim() || effort.id,
    isDefault: !!effort.isDefault,
  }));
}

function resetEffortsFor(
  remote: RemoteModelMetadata | null | undefined,
): { efforts: ProviderEffortEntry[]; source: ProviderModelFieldSource } {
  const remoteEfforts = normalizeModelEfforts(remote?.reasoningEfforts);
  return remoteEfforts.length > 0
    ? { efforts: remoteEfforts, source: "remote" }
    : { efforts: defaultProviderModelEfforts(), source: "fallback" };
}

export function ProviderModelSettingsModal({
  open,
  locale,
  model,
  remote,
  onClose,
  onSave,
}: {
  open: boolean;
  locale: Locale;
  model: FormModel | null;
  remote?: RemoteModelMetadata | null;
  onClose: () => void;
  onSave: (next: ProviderModelSettingsValue) => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const windowInputRef = useRef<HTMLInputElement>(null);
  const [windowDraft, setWindowDraft] = useState("");
  const [windowSource, setWindowSource] =
    useState<ProviderModelFieldSource>("fallback");
  const [windowDirty, setWindowDirty] = useState(false);
  const [windowInvalid, setWindowInvalid] = useState(false);
  const [efforts, setEfforts] = useState<DraftEffort[]>([]);
  const [effortsSource, setEffortsSource] =
    useState<ProviderModelFieldSource>("fallback");
  const [effortsDirty, setEffortsDirty] = useState(false);
  const [supportsReasoning, setSupportsReasoning] = useState(true);
  const [supportsReasoningSource, setSupportsReasoningSource] =
    useState<ProviderModelFieldSource>("fallback");
  const [supportsReasoningDirty, setSupportsReasoningDirty] = useState(false);
  const [draftEffortId, setDraftEffortId] = useState("");
  const [draftEffortName, setDraftEffortName] = useState("");

  useEffect(() => {
    if (!open || !model) return;
    const window = effectiveModelContextWindow(model);
    const modelEfforts = effectiveModelEfforts(model);
    const reasoning = effectiveModelSupportsReasoningEffort(model);
    setWindowDraft(String(window.value));
    setWindowSource(window.source);
    setWindowDirty(false);
    setWindowInvalid(false);
    setEfforts(toDraftEfforts(modelEfforts.value));
    setEffortsSource(modelEfforts.source);
    setEffortsDirty(false);
    setSupportsReasoning(reasoning.value);
    setSupportsReasoningSource(reasoning.source);
    setSupportsReasoningDirty(false);
    setDraftEffortId("");
    setDraftEffortName("");
  }, [open, model]);

  const addEffort = () => {
    const id = draftEffortId.trim();
    if (!id) return;
    setEfforts((list) => {
      if (list.some((row) => row.id === id)) return list;
      return [
        ...list,
        {
          id,
          name: draftEffortName.trim() || id,
          isDefault: list.length === 0,
        },
      ];
    });
    setEffortsDirty(true);
    setDraftEffortId("");
    setDraftEffortName("");
  };

  const resetEfforts = () => {
    const reset = resetEffortsFor(remote);
    setEfforts(toDraftEfforts(reset.efforts));
    setEffortsSource(reset.source);
    setEffortsDirty(false);
  };

  const save = () => {
    const trimmed = windowDraft.trim();
    let nextWindow: number;
    let nextWindowSource: ProviderModelFieldSource;
    if (!trimmed) {
      const remoteWindow =
        remote?.contextWindow != null && remote.contextWindow > 0
          ? Math.floor(remote.contextWindow)
          : null;
      nextWindow = remoteWindow ?? DEFAULT_PROVIDER_MODEL_CONTEXT_WINDOW;
      nextWindowSource = remoteWindow != null ? "remote" : "fallback";
    } else {
      const parsed = parseWindow(trimmed);
      if (parsed == null) {
        setWindowInvalid(true);
        windowInputRef.current?.focus();
        return;
      }
      nextWindow = parsed;
      nextWindowSource = windowDirty ? "user" : windowSource;
    }

    let nextEfforts: ProviderEffortEntry[] = efforts
      .map((effort) => ({
        id: effort.id.trim(),
        name: effort.name.trim() || effort.id.trim(),
        isDefault: !!effort.isDefault,
      }))
      .filter((effort) => effort.id);
    let nextEffortsSource: ProviderModelFieldSource;
    if (nextEfforts.length === 0) {
      const reset = resetEffortsFor(remote);
      nextEfforts = reset.efforts;
      nextEffortsSource = reset.source;
    } else {
      nextEfforts = normalizeModelEfforts(nextEfforts);
      nextEffortsSource = effortsDirty ? "user" : effortsSource;
    }

    onSave({
      contextWindow: nextWindow,
      contextWindowSource: nextWindowSource,
      efforts: nextEfforts,
      effortsSource: nextEffortsSource,
      supportsReasoningEffort: supportsReasoning,
      supportsReasoningEffortSource: supportsReasoningDirty
        ? "user"
        : supportsReasoningSource,
    });
  };

  const title = model
    ? tr("prov.modelSettingsTitle", { name: model.name || model.id })
    : tr("prov.modelSettings");

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      closeLabel={tr("common.close")}
      wrapBody
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {tr("common.cancel")}
          </button>
          <button type="button" className="btn btn--solid" onClick={save}>
            {tr("common.save")}
          </button>
        </>
      }
    >
      <div className="prov-model-settings">
        <div className="prov-field">
          <FieldHelp
            label={tr("prov.modelContextWindow")}
            tip={tr("prov.modelContextWindowHint")}
          />
          <input
            ref={windowInputRef}
            className="settings-input"
            inputMode="numeric"
            value={windowDraft}
            onChange={(e) => {
              setWindowDraft(e.target.value);
              setWindowDirty(true);
              setWindowInvalid(false);
            }}
            placeholder={tr("prov.modelContextWindowPh")}
            aria-label={tr("prov.modelContextWindow")}
            aria-invalid={windowInvalid}
            aria-describedby={
              windowInvalid ? "prov-model-context-window-error" : undefined
            }
            autoComplete="off"
            spellCheck={false}
            maxLength={16}
          />
          {windowInvalid ? (
            <p
              className="prov-field__hint prov-field__hint--error"
              id="prov-model-context-window-error"
              role="alert"
            >
              {tr("prov.modelContextWindowInvalid")}
            </p>
          ) : null}
        </div>

        <div className="prov-field">
          <FieldHelp
            label={tr("prov.modelSupportsReasoning")}
            tip={tr("prov.modelSupportsReasoningHint")}
          />
          <div className="prov-model-settings__caps">
            <UiCheck
              checked={supportsReasoning}
              onChange={(checked) => {
                setSupportsReasoning(checked);
                setSupportsReasoningDirty(true);
              }}
              label={tr("prov.modelSupportsReasoningOn")}
            />
          </div>
        </div>

        <div className="prov-field">
          <span className="prov-field__label-row">
            <FieldHelp
              label={tr("prov.efforts")}
              tip={tr("prov.effortsModelHint")}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={resetEfforts}
            >
              {tr("prov.modelUseApiDefault")}
            </button>
          </span>
          <div
            className="prov-models prov-efforts"
            role="group"
            aria-label={tr("prov.efforts")}
          >
            <div className="prov-models__head" aria-hidden>
              <span>{tr("prov.effortDisplayName")}</span>
              <span>{tr("prov.effortId")}</span>
              <span />
            </div>
            {efforts.length === 0 ? (
              <p className="prov-models__empty">{tr("prov.effortsEmpty")}</p>
            ) : (
              efforts.map((effort, index) => (
                <div key={index} className="prov-models__row">
                  <input
                    className="settings-input"
                    value={effort.name}
                    onChange={(ev) => {
                      const name = ev.target.value;
                      setEfforts((list) =>
                        list.map((row, i) =>
                          i === index ? { ...row, name } : row,
                        ),
                      );
                      setEffortsDirty(true);
                    }}
                    placeholder={tr("prov.effortDisplayNamePh")}
                    aria-label={tr("prov.effortDisplayName")}
                    autoComplete="off"
                    maxLength={80}
                  />
                  <input
                    className="settings-input"
                    value={effort.id}
                    onChange={(ev) => {
                      const next = ev.target.value;
                      setEfforts((list) =>
                        list.map((row, i) =>
                          i === index
                            ? {
                                ...row,
                                id: next,
                                name:
                                  !row.name.trim() || row.name.trim() === row.id
                                    ? next
                                    : row.name,
                              }
                            : row,
                        ),
                      );
                      setEffortsDirty(true);
                    }}
                    placeholder={tr("prov.effortIdPh")}
                    aria-label={tr("prov.effortId")}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={64}
                  />
                  <button
                    type="button"
                    className="icon-btn prov-models__remove"
                    onClick={() => {
                      setEfforts((list) =>
                        list.filter((_, i) => i !== index),
                      );
                      setEffortsDirty(true);
                    }}
                    aria-label={tr("prov.removeEffort")}
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              ))
            )}
            <div className="prov-models__add-row">
              <input
                className="settings-input"
                value={draftEffortName}
                onChange={(ev) => setDraftEffortName(ev.target.value)}
                placeholder={tr("prov.effortDisplayNamePh")}
                aria-label={tr("prov.effortDisplayName")}
                autoComplete="off"
                maxLength={80}
              />
              <input
                className="settings-input"
                value={draftEffortId}
                onChange={(ev) => {
                  const id = ev.target.value;
                  setDraftEffortId(id);
                  setDraftEffortName((n) =>
                    !n.trim() || n.trim() === draftEffortId.trim() ? id : n,
                  );
                }}
                placeholder={tr("prov.effortIdPh")}
                aria-label={tr("prov.effortId")}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    addEffort();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm prov-models__add-btn"
                disabled={!draftEffortId.trim()}
                onClick={addEffort}
              >
                <IconPlus size={14} />
                {tr("prov.addEffort")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </GlassModal>
  );
}
