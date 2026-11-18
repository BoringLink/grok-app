/**
 * Phone-only composer tools bottom sheet.
 * Replaces the five unlabeled desktop chips (attach / project / model / access / context)
 * with labelled ≥44px rows. Not mounted on desktop (≥821px).
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  IconActivity,
  IconAttach,
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconHandStop,
  IconHome,
  IconPlus,
} from "@/components/icons";
import { installDialogFocus } from "@/lib/a11yFocus";
import {
  GROK_BUILD_MODELS,
  PERMISSION_POLICIES,
  SESSION_MODES,
  effortDisplayLabel,
  effortsForModel,
  findModel,
  type EffortOption,
  type ModelOption,
  type PermissionPolicyId,
} from "@/lib/grokCatalog";
import {
  buildComposerModelGroups,
  isComposerModelEntryActive,
  type ComposerModelPick,
  type ComposerProviderInput,
} from "@/lib/composerModelGroups";
import {
  composerModelChipLabel,
  resolveCustomRouteDisplay,
} from "@/lib/effectiveModel";
import type { ProviderRouteId } from "@/lib/sessionProviderRoute";
import {
  formatTokenCount,
  hasContextUsageData,
  type ContextUsageDisplay,
} from "@/lib/contextUsage";

export type PhoneToolsPanel =
  | "root"
  | "project"
  | "model"
  | "effort"
  | "access"
  | "context";

export type PhoneProjectOption = {
  id: string;
  name: string;
  path: string;
  trusted: boolean;
};

export type PhoneComposerToolsSheetProps = {
  open: boolean;
  onClose: () => void;
  labels: {
    title: string;
    close: string;
    attach: string;
    project: string;
    model: string;
    effort: string;
    access: string;
    context: string;
    noProject: string;
    addProject: string;
    mode: string;
    permission: string;
    modeAgent: string;
    modePlan: string;
    modeAsk: string;
    /** Section header for official catalog models. */
    modelGroupOfficial: string;
    /** @deprecated Prefer real custom groups via `providers`. */
    modelViaProvider?: string;
    policyAsk: string;
    policyAcceptEdits: string;
    policySession: string;
    policyAuto: string;
    policyDontAsk: string;
    policyYolo: string;
    effortHigh: string;
    effortMedium: string;
    effortLow: string;
    effortXhigh?: string;
    effortMax?: string;
    effortNone?: string;
    /** Shown in place of the ladder when the model rejects reasoning effort. */
    effortUnavailable?: string;
    /** Shown when the provider catalog failed to load (not still loading). */
    effortLoadError?: string;
    contextCurrent: string;
    contextUnknown: string;
    contextCompact: string;
    sourceKnown: string;
    sourceEstimated: string;
    sourceUnknown: string;
    /** Context window / percent / cache-hit rows. */
    contextWindow?: string;
    contextPercentUsed?: string;
    contextCacheHit?: string;
    breakdownUser?: string;
    breakdownAssistant?: string;
    breakdownThought?: string;
    back: string;
  };
  activeProject: PhoneProjectOption | null;
  projects: PhoneProjectOption[];
  modelId: string;
  effort: string;
  models?: ModelOption[];
  /** Configured custom providers for grouped menu entries. */
  providers?: ComposerProviderInput[];
  /** Active inference route: `providerId === null` means official. */
  providerRoute: ProviderRouteId;
  /** Reasoning options for this chat's exact model; `undefined` uses official catalog. */
  efforts?: EffortOption[] | null;
  effortOptionsPending?: boolean;
  /** 自定义 provider 目录加载失败时，档位区显示错误而非中性加载态。 */
  effortOptionsFailed?: boolean;
  mode: string;
  policy: string;
  contextDisplay: ContextUsageDisplay;
  /** Resolved UI locale — fallback token counts use K/M (en) vs 万/千 (zh). */
  locale?: string;
  onAttach: () => void;
  onSelectProject: (project: PhoneProjectOption | null) => void;
  onAddProject: () => void;
  /** Prefer over onModel when provided. */
  onModelPick?: (pick: ComposerModelPick) => void;
  onModel?: (id: string) => void;
  onEffort: (id: EffortOption["id"]) => void;
  onMode: (id: string) => void;
  onPolicy: (id: PermissionPolicyId) => void;
  onCompact: () => void;
};

function effortLabel(
  option: EffortOption | string,
  labels: PhoneComposerToolsSheetProps["labels"],
): string {
  return effortDisplayLabel(option, {
    high: labels.effortHigh,
    medium: labels.effortMedium,
    low: labels.effortLow,
    xhigh: labels.effortXhigh,
    max: labels.effortMax ?? labels.effortXhigh,
    none: labels.effortNone,
  });
}

function modeLabel(
  id: string,
  labels: PhoneComposerToolsSheetProps["labels"],
): string {
  if (id === "plan") return labels.modePlan;
  if (id === "ask") return labels.modeAsk;
  return labels.modeAgent;
}

function policyLabel(
  id: string,
  labels: PhoneComposerToolsSheetProps["labels"],
): string {
  switch (id) {
    case "accept_edits":
      return labels.policyAcceptEdits;
    case "allow_for_session":
      return labels.policySession;
    case "auto":
      return labels.policyAuto;
    case "dont_ask":
      return labels.policyDontAsk;
    case "always_approve":
      return labels.policyYolo;
    default:
      return labels.policyAsk;
  }
}

function SheetRow({
  icon,
  label,
  value,
  onClick,
  chevron,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  onClick: () => void;
  chevron?: boolean;
}) {
  return (
    <button type="button" className="phone-sheet__row" onClick={onClick}>
      <span className="phone-sheet__row-icon" aria-hidden>
        {icon}
      </span>
      <span className="phone-sheet__row-label">{label}</span>
      {value ? (
        <span className="phone-sheet__row-value">{value}</span>
      ) : null}
      {chevron ? (
        <span className="phone-sheet__row-chevron" aria-hidden>
          <IconChevronRight size={18} />
        </span>
      ) : null}
    </button>
  );
}

export function PhoneComposerToolsSheet({
  open,
  onClose,
  labels,
  activeProject,
  projects,
  modelId,
  effort,
  models = GROK_BUILD_MODELS,
  providers = [],
  providerRoute,
  efforts,
  effortOptionsPending = false,
  effortOptionsFailed = false,
  mode,
  policy,
  contextDisplay,
  locale = "en",
  onAttach,
  onSelectProject,
  onAddProject,
  onModelPick,
  onModel,
  onEffort,
  onMode,
  onPolicy,
  onCompact,
}: PhoneComposerToolsSheetProps) {
  const titleId = useId();
  const [panel, setPanel] = useState<PhoneToolsPanel>("root");
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const toolsPanelRef = useRef(panel);
  toolsPanelRef.current = panel;
  const modelList = models.length > 0 ? models : GROK_BUILD_MODELS;
  const modelGroups = buildComposerModelGroups({
    officialModels: modelList,
    providers,
    officialGroupTitle: labels.modelGroupOfficial,
  });
  const routeProviderId = providerRoute.providerId;
  const customRoute = routeProviderId
    ? resolveCustomRouteDisplay(
        providers.find((x) => x.id === routeProviderId),
        modelId,
      )
    : null;
  const activeCustom = customRoute?.chip ?? null;
  const activeRequestModel = customRoute?.requestModel ?? null;
  const effortOptions =
    efforts != null ? efforts : effortsForModel(findModel(modelId, modelList));
  const activeEffortOption =
    effortOptions.find((option) => option.id === effort) ?? null;
  const effortDisplay = effortOptionsPending
    ? labels.effort
    : effortOptions.length === 0
      ? effortOptionsFailed
        ? labels.effortLoadError ?? labels.effort
        : labels.effortUnavailable ?? labels.effort
      : activeEffortOption
        ? effortLabel(activeEffortOption, labels)
        : labels.effort;
  const officialLabel =
    modelList.find((m) => m.id === modelId)?.label ?? modelId;
  const modelLabel = composerModelChipLabel({
    modelId,
    officialLabel,
    activeCustom,
  });

  const selectPick = (pick: ComposerModelPick) => {
    if (onModelPick) {
      onModelPick(pick);
    } else if (pick.kind === "official" && onModel) {
      onModel(pick.modelId);
    }
    onClose();
  };

  useEffect(() => {
    if (!open) setPanel("root");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Escape: drill up sub-panels, then close. Tab cycles inside the sheet.
    return installDialogFocus(() => panelRef.current, {
      onEscape: () => {
        const p = toolsPanelRef.current;
        if (p !== "root") {
          if (p === "effort") setPanel("model");
          else setPanel("root");
          return;
        }
        onCloseRef.current();
      },
      capture: true,
      initialFocus: "first",
      restoreFocus: true,
    });
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  // Prefer pre-resolved chip label (already locale-aware units).
  const contextValue =
    contextDisplay.tokens != null
      ? contextDisplay.label.replace(/^~/, "") ||
        formatTokenCount(contextDisplay.tokens, locale)
      : labels.contextUnknown;

  const headerTitle =
    panel === "root"
      ? labels.title
      : panel === "project"
        ? labels.project
        : panel === "model"
          ? labels.model
          : panel === "effort"
            ? labels.effort
            : panel === "access"
              ? labels.access
              : labels.context;

  return createPortal(
    <div className="phone-sheet" role="presentation">
      <button
        type="button"
        className="phone-sheet__scrim"
        aria-label={labels.close}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="phone-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="phone-sheet__handle" aria-hidden />
        <div className="phone-sheet__head">
          {panel !== "root" ? (
            <button
              type="button"
              className="phone-sheet__icon-btn"
              onClick={() =>
                setPanel(panel === "effort" ? "model" : "root")
              }
              aria-label={labels.back}
            >
              <IconClose size={18} />
            </button>
          ) : (
            <span className="phone-sheet__icon-btn phone-sheet__icon-btn--spacer" />
          )}
          <h2 id={titleId} className="phone-sheet__title">
            {headerTitle}
          </h2>
          <button
            type="button"
            className="phone-sheet__icon-btn"
            onClick={onClose}
            aria-label={labels.close}
          >
            <IconClose size={18} />
          </button>
        </div>

        <div className="phone-sheet__body">
          {panel === "root" && (
            <>
              <SheetRow
                icon={<IconAttach size={20} />}
                label={labels.attach}
                onClick={() => {
                  onAttach();
                  onClose();
                }}
              />
              <SheetRow
                icon={
                  activeProject ? (
                    <IconFolder size={20} />
                  ) : (
                    <IconHome size={20} />
                  )
                }
                label={labels.project}
                value={activeProject?.name ?? labels.noProject}
                chevron
                onClick={() => setPanel("project")}
              />
              <SheetRow
                icon={<IconBolt size={20} />}
                label={labels.model}
                value={`${modelLabel} ${effortDisplay}`}
                chevron
                onClick={() => setPanel("model")}
              />
              <SheetRow
                icon={<IconHandStop size={20} />}
                label={labels.access}
                value={`${modeLabel(mode, labels)} · ${policyLabel(policy, labels)}`}
                chevron
                onClick={() => setPanel("access")}
              />
              {hasContextUsageData(contextDisplay) ? (
                <SheetRow
                  icon={<IconActivity size={20} />}
                  label={labels.context}
                  value={contextValue}
                  chevron
                  onClick={() => setPanel("context")}
                />
              ) : null}
            </>
          )}

          {panel === "project" && (
            <>
              <SheetRow
                icon={<IconHome size={20} />}
                label={labels.noProject}
                onClick={() => {
                  onSelectProject(null);
                  onClose();
                }}
              />
              {projects.map((p) => (
                <SheetRow
                  key={p.id}
                  icon={<IconFolder size={20} />}
                  label={p.name}
                  value={activeProject?.id === p.id ? "✓" : undefined}
                  onClick={() => {
                    onSelectProject(p);
                    onClose();
                  }}
                />
              ))}
              <SheetRow
                icon={<IconPlus size={20} />}
                label={labels.addProject}
                onClick={() => {
                  onAddProject();
                  onClose();
                }}
              />
            </>
          )}

          {panel === "model" && (
            <>
              {modelGroups.map((group) => (
                <div key={group.key}>
                  <div className="phone-sheet__section">{group.title}</div>
                  {group.entries.map((entry) => {
                    const active = isComposerModelEntryActive(entry, {
                      providerId: routeProviderId,
                      activeRequestModel,
                      modelId,
                    });
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        className={
                          "phone-sheet__row" +
                          (active ? " is-active" : "") +
                          (entry.subtitle ? " phone-sheet__row--stacked" : "")
                        }
                        onClick={() => selectPick(entry.pick)}
                      >
                        <span className="phone-sheet__row-label">
                          {entry.subtitle ? (
                            <>
                              <span className="phone-sheet__row-title">
                                {entry.title}
                              </span>
                              <span className="phone-sheet__row-sub">
                                {entry.subtitle}
                              </span>
                            </>
                          ) : (
                            entry.title
                          )}
                        </span>
                        {active ? (
                          <span className="phone-sheet__row-value" aria-hidden>
                            <IconCheck size={18} />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              <SheetRow
                icon={<IconActivity size={20} />}
                label={labels.effort}
                value={effortDisplay}
                chevron
                onClick={() => setPanel("effort")}
              />
            </>
          )}

          {panel === "effort" &&
            (effortOptions.length > 0 ? (
              effortOptions.map((option) => {
                const active = option.id === effort;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={
                      "phone-sheet__row" + (active ? " is-active" : "")
                    }
                    aria-pressed={active}
                    onClick={() => {
                      onEffort(option.id);
                      setPanel("model");
                    }}
                  >
                    <span className="phone-sheet__row-label">
                      {effortLabel(option, labels)}
                    </span>
                    {active ? (
                      <span className="phone-sheet__row-value" aria-hidden>
                        <IconCheck size={18} />
                      </span>
                    ) : null}
                  </button>
                );
              })
            ) : (
              <div className="phone-sheet__row phone-sheet__row--muted" role="status">
                <span className="phone-sheet__row-label">
                  {effortOptionsPending
                    ? labels.effort
                    : effortOptionsFailed
                      ? labels.effortLoadError
                      : labels.effortUnavailable}
                </span>
              </div>
            ))}

          {panel === "access" && (
            <>
              <div className="phone-sheet__section">{labels.mode}</div>
              {SESSION_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={
                    "phone-sheet__row" + (m.id === mode ? " is-active" : "")
                  }
                  onClick={() => onMode(m.id)}
                >
                  <span className="phone-sheet__row-label">
                    {modeLabel(m.id, labels)}
                  </span>
                  {m.id === mode ? (
                    <span className="phone-sheet__row-value" aria-hidden>
                      <IconCheck size={18} />
                    </span>
                  ) : null}
                </button>
              ))}
              <div className="phone-sheet__section">{labels.permission}</div>
              {PERMISSION_POLICIES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={
                    "phone-sheet__row" +
                    (p.id === policy ? " is-active" : "")
                  }
                  onClick={() => onPolicy(p.id as PermissionPolicyId)}
                >
                  <span className="phone-sheet__row-label">
                    {policyLabel(p.id, labels)}
                  </span>
                  {p.id === policy ? (
                    <span className="phone-sheet__row-value" aria-hidden>
                      <IconCheck size={18} />
                    </span>
                  ) : null}
                </button>
              ))}
            </>
          )}

          {panel === "context" && (
            <>
              <div className="phone-sheet__info">
                <div className="phone-sheet__info-row">
                  <span>{labels.contextCurrent}</span>
                  <strong>{contextValue}</strong>
                </div>
                <div className="phone-sheet__info-row">
                  <span>
                    {contextDisplay.source === "known"
                      ? labels.sourceKnown
                      : contextDisplay.source === "estimated"
                        ? labels.sourceEstimated
                        : labels.sourceUnknown}
                  </span>
                </div>
                {contextDisplay.windowSize != null &&
                contextDisplay.windowSize > 0 ? (
                  <div className="phone-sheet__info-row">
                    <span>{labels.contextWindow}</span>
                    <strong className="phone-sheet__nums">
                      {formatTokenCount(contextDisplay.windowSize, locale)}
                    </strong>
                  </div>
                ) : null}
                {contextDisplay.percent != null ? (
                  <div className="phone-sheet__info-row">
                    <span>{labels.contextPercentUsed}</span>
                    <strong className="phone-sheet__nums">
                      {contextDisplay.percent}%
                    </strong>
                  </div>
                ) : null}
                {contextDisplay.cacheHitRate != null ? (
                  <div className="phone-sheet__info-row">
                    <span>{labels.contextCacheHit}</span>
                    <strong className="phone-sheet__nums">
                      {contextDisplay.cacheHitRate}%
                    </strong>
                  </div>
                ) : null}
                {contextDisplay.breakdown && labels.breakdownUser
                  ? [
                      "user",
                      "assistant",
                      "thought",
                    ].map((role) => {
                      const tokens =
                        role === "user"
                          ? contextDisplay.breakdown!.userTokens
                          : role === "assistant"
                            ? contextDisplay.breakdown!.assistantTokens
                            : contextDisplay.breakdown!.thoughtTokens;
                      if (tokens <= 0) return null;
                      const lab =
                        role === "user"
                          ? labels.breakdownUser
                          : role === "assistant"
                            ? labels.breakdownAssistant
                            : labels.breakdownThought;
                      return (
                        <div
                          key={role}
                          className="phone-sheet__info-row"
                        >
                          <span>{lab}</span>
                          <strong className="phone-sheet__nums">
                            ~{formatTokenCount(tokens, locale)}
                          </strong>
                        </div>
                      );
                    })
                  : null}
              </div>
              <SheetRow
                icon={<IconActivity size={20} />}
                label={labels.contextCompact}
                onClick={() => {
                  onCompact();
                  onClose();
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
