/**
 * Composer chip menus (model + this model's reasoning variants):
 * - One trigger: model + effort
 * - Simple open: raw reasoning variants in catalog order; Advanced for explicit lists
 * - Access: session mode + permission in one panel
 * Narrow composer widths compress triggers to icon (+ short label).
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
  filterComposerModelGroups,
  isComposerModelEntryActive,
  type ComposerModelPick,
  type ComposerProviderInput,
} from "@/lib/composerModelGroups";
import { selectableContextWindows } from "@/lib/contextWindowCommand";
import {
  composerModelChipLabel,
  resolveCustomRouteDisplay,
} from "@/lib/effectiveModel";
import { formatTokenCount } from "@/lib/contextUsage";
import { Tip } from "@/components/ui/tooltip";
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconHandStop,
  IconList,
  IconRobot,
  IconShield,
  IconShieldCheck,
} from "@/components/icons";
import {
  ComposerPortalPop,
  useComposerPortalMenu,
  type ComposerPortalMenu,
} from "@/components/ComposerPortalPop";
import { FLOATING_MENU_Z_INDEX } from "@/lib/floatingMenu";

type Pane = "simple" | "advanced";
type HubFlyout = "models" | "effort" | "window";

const FLYOUT_GAP = 8;
const FLYOUT_EDGE = 8;
const FLYOUT_MIN_W = 168;

function flyoutPreferredWidth(kind: HubFlyout, measured: number): number {
  // Window flyout needs room for token input + Save side-by-side; don't
  // collapse to a clipped hit target after the first measure pass.
  if (kind === "window") return Math.max(measured, 260);
  if (measured > 0) return measured;
  return kind === "models" ? 220 : 200;
}

/**
 * Nested-menu placement (Codex / macOS):
 * 1. Prefer the right of the hub when the full panel fits.
 * 2. Flip to the left when the right would clip (small window / chip on the
 *    trailing edge).
 * 3. If neither side fits, clamp into the viewport so the panel stays fully
 *    on-screen (may overlap the hub).
 * Vertical: align to the opening *row*, not the hub top — otherwise the
 * context-window row is unreachable.
 */
export function placeHubFlyout(
  hub: DOMRect,
  flyout: HTMLElement | null,
  kind: HubFlyout,
  row?: DOMRect | null,
): { pos: CSSProperties; side: "left" | "right" } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const wantW = flyoutPreferredWidth(kind, flyout?.offsetWidth ?? 0);
  const innerRight = hub.right + FLYOUT_GAP;
  const innerLeft = hub.left - FLYOUT_GAP;
  const rightFits = innerRight + wantW <= vw - FLYOUT_EDGE;
  const leftFits = innerLeft - wantW >= FLYOUT_EDGE;
  const spaceRight = vw - FLYOUT_EDGE - innerRight;
  const spaceLeft = innerLeft - FLYOUT_EDGE;
  const side: "left" | "right" = rightFits
    ? "right"
    : leftFits
      ? "left"
      : spaceLeft > spaceRight
        ? "left"
        : "right";
  const panelW = Math.min(
    wantW,
    Math.max(FLYOUT_MIN_W, vw - FLYOUT_EDGE * 2),
  );
  const cap = kind === "models" ? 240 : 280;
  const flyH = flyout?.offsetHeight ?? 0;
  const preferredH = flyH > 0 ? flyH : Math.min(120, cap);
  const anchorTop =
    row && Number.isFinite(row.top) ? row.top : hub.top;
  let top = Math.max(FLYOUT_EDGE, anchorTop);
  const usedH = Math.min(preferredH, cap, vh - FLYOUT_EDGE * 2);
  if (top + usedH > vh - FLYOUT_EDGE) {
    top = Math.max(FLYOUT_EDGE, vh - FLYOUT_EDGE - usedH);
  }
  const maxH = Math.min(cap, Math.max(96, vh - FLYOUT_EDGE - top));
  const pos: CSSProperties = {
    position: "fixed",
    top,
    zIndex: FLOATING_MENU_Z_INDEX,
    maxHeight: maxH,
    maxWidth: panelW,
    width: panelW,
    boxSizing: "border-box",
  };
  if (side === "left") {
    let rightEdge = innerLeft;
    if (rightEdge - panelW < FLYOUT_EDGE) {
      rightEdge = FLYOUT_EDGE + panelW;
    }
    if (rightEdge > vw - FLYOUT_EDGE) {
      rightEdge = vw - FLYOUT_EDGE;
    }
    pos.right = vw - rightEdge;
    pos.left = "auto";
  } else {
    let left = innerRight;
    if (left + panelW > vw - FLYOUT_EDGE) {
      left = vw - FLYOUT_EDGE - panelW;
    }
    if (left < FLYOUT_EDGE) left = FLYOUT_EDGE;
    pos.left = left;
  }
  return { pos, side };
}

function MenuShell({
  menu,
  triggerIcon,
  triggerText,
  triggerShort,
  ariaLabel,
  title,
  danger,
  children,
  onOpenChange,
  className = "",
  /** Applied on the portaled panel (body), not the trigger root. */
  panelClassName = "",
  tipClassName,
  /** Pin the pop to the parent chip-shell instead of the inner button. */
  pinParent,
  /** Keep the trigger as wide as the widest effort label so xhigh does not jump. */
  widthCandidates,
}: {
  menu: ComposerPortalMenu;
  triggerIcon?: ReactNode;
  /** Full label (wide layout) */
  triggerText: string;
  /** Short label (medium; icon-only when very narrow via CSS) */
  triggerShort?: string;
  ariaLabel: string;
  title?: string;
  danger?: boolean;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  panelClassName?: string;
  tipClassName?: string;
  pinParent?: boolean;
  widthCandidates?: string[];
}) {
  const { open, setOpen, requestClose, exiting, rootRef, triggerRef, positionRef, popId } =
    menu;
  const measureRef = useRef<HTMLDivElement>(null);
  const compactW = useRef(0);
  const [maxW, setMaxW] = useState(0);
  const tipLabel = title ?? ariaLabel;
  const expanded = open && !exiting;

  useLayoutEffect(() => {
    positionRef.current = pinParent
      ? (rootRef.current?.parentElement ?? rootRef.current)
      : null;
  });

  useLayoutEffect(() => {
    if (!pinParent) return;
    const shell = rootRef.current?.parentElement;
    if (!shell) return;
    const ease = "width var(--motion-pane) var(--motion-pane-ease)";
    if (expanded) {
      const id = requestAnimationFrame(() => {
        shell.style.transition = ease;
        shell.style.width = "280px";
      });
      return () => cancelAnimationFrame(id);
    }
    const to = compactW.current;
    if (!to) {
      shell.style.width = "";
      shell.style.transition = "";
      return;
    }
    shell.style.transition = ease;
    shell.style.width = `${to}px`;
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName !== "width") return;
      shell.style.width = "";
      shell.style.transition = "";
      shell.removeEventListener("transitionend", onEnd);
    };
    shell.addEventListener("transitionend", onEnd);
    return () => shell.removeEventListener("transitionend", onEnd);
  }, [expanded, pinParent]);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root || !widthCandidates?.length) return;
    let max = 0;
    for (const btn of root.querySelectorAll("button")) {
      max = Math.max(max, Math.ceil(btn.getBoundingClientRect().width));
    }
    if (max) setMaxW(max);
  }, [widthCandidates, triggerText]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className="cmm__trigger"
      aria-haspopup="dialog"
      aria-expanded={open && !exiting}
      aria-controls={popId}
      aria-label={ariaLabel}
      style={maxW ? { minWidth: maxW } : undefined}
      onClick={() => {
        if (open && !exiting) {
          requestClose();
          onOpenChange?.(false);
          return;
        }
        if (pinParent) {
          const shell = rootRef.current?.parentElement;
          if (shell) {
            const from = Math.round(shell.getBoundingClientRect().width);
            compactW.current = from;
            shell.style.transition = "none";
            shell.style.width = `${from}px`;
          }
        }
        setOpen(true);
        onOpenChange?.(true);
      }}
    >
      {triggerIcon ? (
        <span className="cmm__icon" aria-hidden>
          {triggerIcon}
        </span>
      ) : null}
      <span className="cmm__trigger-text cmm__trigger-text--full">
        {triggerText}
      </span>
      {triggerShort != null && (
        <span className="cmm__trigger-text cmm__trigger-text--short">
          {triggerShort}
        </span>
      )}
      <span className="cmm__chev" aria-hidden>
        <IconChevronDown size={12} />
      </span>
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={`cmm ${expanded ? "is-open" : ""} ${danger ? "cmm--danger" : ""} ${className}`.trim()}
    >
      {tipLabel ? (
        <Tip label={tipLabel} disabled={open} className={tipClassName}>
          {trigger}
        </Tip>
      ) : (
        trigger
      )}
      {widthCandidates && widthCandidates.length > 0 ? (
        <div ref={measureRef} className="cmm__measure" aria-hidden>
          {widthCandidates.map((text) => (
            <button
              key={text}
              type="button"
              tabIndex={-1}
              className="cmm__trigger"
              data-current={text === triggerText ? "1" : undefined}
            >
              {triggerIcon ? (
                <span className="cmm__icon" aria-hidden>
                  {triggerIcon}
                </span>
              ) : null}
              <span className="cmm__trigger-text cmm__trigger-text--full">
                {text}
              </span>
              <span className="cmm__chev" aria-hidden>
                <IconChevronDown size={12} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <ComposerPortalPop
        menu={menu}
        className={panelClassName}
        id={popId}
        role="dialog"
        ariaLabel={ariaLabel}
      >
        {children}
      </ComposerPortalPop>
    </div>
  );
}

/* ---------- Model + effort ---------- */

export interface ComposerModelMenuProps {
  modelId: string;
  effort: string;
  /** Live selectable models only (from Host catalog). */
  models?: ModelOption[];
  /** Configured custom providers for grouped menu entries. */
  providers?: ComposerProviderInput[];
  /** Active inference route: official | custom. */
  activeSource?: string;
  activeProviderId?: string | null;
  labels: {
    model: string;
    effort: string;
    effortHigh: string;
    effortMedium: string;
    effortLow: string;
    effortXhigh?: string;
    effortMax?: string;
    /** Off state, only when the model advertises `none`. */
    effortNone?: string;
    /** Shown in place of the ladder when the model rejects reasoning effort. */
    effortUnavailable?: string;
    /** @deprecated Strongest stop shows the catalog spawn id (xhigh), not Extra. */
    effortExtra?: string;
    /** Search field placeholder in the model flyout list. */
    modelSearchPlaceholder: string;
    /** Empty state when filter matches nothing. */
    modelSearchEmpty: string;
    /** Section header for official catalog models. */
    modelGroupOfficial: string;
    /** Context window sub-menu labels. */
    contextWindow: string;
    contextWindowOfficial: string;
    contextWindowCustom: string;
    contextWindowPlaceholder: string;
    contextWindowSave: string;
    contextWindowOfficialHint: string;
    /** Codex simple-view list + Advanced toggle. */
    advanced?: string;
  };
  /** Resolved UI locale — token window uses K/M (en) vs 万/千 (zh). */
  locale?: string;
  /** Effective context window (tokens) for the active route. */
  contextWindow?: number | null;
  /**
   * True for custom routes (type a token count). Official routes with more
   * than one advertised window list those sizes instead.
   */
  contextWindowEditable?: boolean;
  /** Save a custom token count, or pick an official advertised window. */
  onContextWindow?: (tokens: number) => void;
  /**
   * Reasoning options for the exact model this chat is routed to. `undefined`
   * falls back to the official model catalog; an empty array means the model
   * exposes no selectable variant.
   */
  efforts?: EffortOption[] | null;
  /** Prefer over onModel when provided. */
  onModelPick?: (pick: ComposerModelPick) => void;
  onModel?: (id: string) => void;
  onEffort: (id: string) => void;
  /**
   * Apply-path honesty when a live agent is attached (e.g. soft-respawn /
   * immediate set_model). Shown as a footer note in Advanced flyouts when set.
   */
  applyNotes?: {
    model?: string | null;
    effort?: string | null;
  };
}

function effortI18n(labels: ComposerModelMenuProps["labels"]) {
  return {
    high: labels.effortHigh,
    medium: labels.effortMedium,
    low: labels.effortLow,
    xhigh: labels.effortXhigh,
    max: labels.effortMax ?? labels.effortXhigh,
    none: labels.effortNone,
  };
}

function effortLabelFor(
  option: EffortOption | string,
  labels: ComposerModelMenuProps["labels"],
): string {
  return effortDisplayLabel(option, effortI18n(labels));
}

/** Raw model reasoning variants in catalog order (no shared ladder remap). */
function EffortOptionList({
  options,
  value,
  labels,
  onEffort,
}: {
  options: EffortOption[];
  value: string;
  labels: ComposerModelMenuProps["labels"];
  onEffort: (id: string) => void;
}) {
  if (options.length === 0) {
    return labels.effortUnavailable ? (
      <div className="cmm__opt cmm__opt--muted" role="status">
        <span className="cmm__opt-main">
          <span className="cmm__opt-title">{labels.effortUnavailable}</span>
        </span>
      </div>
    ) : null;
  }
  return (
    <div className="cmm__effort-list" role="group" aria-label={labels.effort}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            className={"cmm__opt" + (active ? " is-active" : "")}
            aria-pressed={active}
            onClick={() => onEffort(option.id)}
          >
            <span className="cmm__opt-main">
              <span className="cmm__opt-title">
                {effortLabelFor(option, labels)}
              </span>
            </span>
            {active ? (
              <span className="cmm__opt-check" aria-hidden>
                <IconCheck size={16} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function ComposerModelMenu({
  modelId,
  effort,
  models = GROK_BUILD_MODELS,
  providers = [],
  activeSource = "official",
  activeProviderId = null,
  efforts,
  labels,
  onModelPick,
  onModel,
  onEffort,
  applyNotes,
  locale = "en",
  contextWindow = null,
  contextWindowEditable = false,
  onContextWindow,
}: ComposerModelMenuProps) {
  const [pane, setPane] = useState<Pane>("simple");
  const [modelQuery, setModelQuery] = useState("");
  const [windowDraft, setWindowDraft] = useState("");
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const modelsRowRef = useRef<HTMLButtonElement>(null);
  const effortRowRef = useRef<HTMLButtonElement>(null);
  const windowRowRef = useRef<HTMLButtonElement>(null);
  const [hubFlyout, setHubFlyout] = useState<HubFlyout | null>(null);
  const [flyPos, setFlyPos] = useState<CSSProperties>();
  const [flySide, setFlySide] = useState<"left" | "right">("right");
  const flyLeave = useRef(0);
  const [bodyH, setBodyH] = useState<number | undefined>(undefined);
  const modelMenu = useComposerPortalMenu({
    estHeight: 320,
    width: 280,
    minWidth: 240,
    fitContent: false,
    align: "end",
    placement: "up",
    anchor: "bottom",
    // Titlebar is 40px; keep the panel below it when the pop opens upward.
    margin: 52,
    deps: [pane],
    extraRoots: [flyoutRef],
    exitMs: 320,
  });

  const goPane = (next: Pane) => {
    const el = stageRef.current;
    if (el) setBodyH(el.offsetHeight);
    setHubFlyout(null);
    setPane(next);
  };

  const showFlyout = (id: HubFlyout) => {
    window.clearTimeout(flyLeave.current);
    setHubFlyout(id);
  };
  const hideFlyoutSoon = () => {
    window.clearTimeout(flyLeave.current);
    flyLeave.current = window.setTimeout(() => setHubFlyout(null), 140);
  };
  const modelList = models.length > 0 ? models : GROK_BUILD_MODELS;
  const officialWindowChoices = contextWindowEditable
    ? []
    : selectableContextWindows(findModel(modelId, modelList));
  const groups = buildComposerModelGroups({
    officialModels: modelList,
    providers,
    officialGroupTitle: labels.modelGroupOfficial,
  });
  const filteredGroups = filterComposerModelGroups(groups, modelQuery);
  const activeModel = findModel(modelId, modelList);
  const effortOptions =
    efforts != null ? efforts : effortsForModel(activeModel);

  const clearModelQuery = () => setModelQuery("");

  const selectPick = (pick: ComposerModelPick) => {
    if (onModelPick) {
      onModelPick(pick);
    } else if (pick.kind === "official" && onModel) {
      onModel(pick.modelId);
    }
  };

  useEffect(() => {
    if (modelMenu.open && !modelMenu.exiting) return;
    setHubFlyout(null);
    if (modelMenu.open) return;
    setPane("simple");
    setBodyH(undefined);
    clearModelQuery();
  }, [modelMenu.open, modelMenu.exiting]);

  useEffect(() => () => window.clearTimeout(flyLeave.current), []);

  useLayoutEffect(() => {
    if (!modelMenu.open) return;
    const el = stageRef.current;
    const next = el?.offsetHeight;
    if (!next) return;
    if (bodyH == null) return;
    const id = requestAnimationFrame(() => setBodyH(next));
    return () => cancelAnimationFrame(id);
  }, [pane, modelMenu.open, bodyH]);

  useLayoutEffect(() => {
    if (!hubFlyout || pane !== "advanced" || modelMenu.exiting) {
      setFlyPos(undefined);
      return;
    }
    const hubEl = modelMenu.popRef.current;
    if (!hubEl) {
      setFlyPos(undefined);
      return;
    }
    const apply = () => {
      const hub = hubEl.getBoundingClientRect();
      const rowEl =
        hubFlyout === "models"
          ? modelsRowRef.current
          : hubFlyout === "effort"
            ? effortRowRef.current
            : windowRowRef.current;
      const row = rowEl?.getBoundingClientRect() ?? null;
      const { pos, side } = placeHubFlyout(
        hub,
        flyoutRef.current,
        hubFlyout,
        row,
      );
      setFlySide(side);
      setFlyPos((prev) => {
        if (
          prev &&
          prev.left === pos.left &&
          prev.right === pos.right &&
          prev.top === pos.top &&
          prev.maxHeight === pos.maxHeight &&
          prev.zIndex === pos.zIndex
        ) {
          return prev;
        }
        return pos;
      });
    };
    apply();
    const id = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(id);
  }, [hubFlyout, pane, modelMenu.exiting, modelMenu.pos]);

  useEffect(() => {
    if (hubFlyout !== "models") clearModelQuery();
  }, [hubFlyout]);

  useEffect(() => {
    if (!modelMenu.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (hubFlyout) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setHubFlyout(null);
          return;
        }
        if (pane === "advanced") {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          goPane("simple");
          return;
        }
      }
      if (hubFlyout !== "models") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      const active = document.activeElement;
      if (
        active === modelSearchRef.current ||
        (active instanceof HTMLElement &&
          active.closest("input, textarea, [contenteditable=true]"))
      ) {
        return;
      }
      e.preventDefault();
      setModelQuery((q) => q + e.key);
      modelSearchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [modelMenu.open, pane, hubFlyout]);

  const customRoute =
    activeSource === "custom"
      ? resolveCustomRouteDisplay(
          providers.find((x) => x.id === activeProviderId),
          modelId,
        )
      : null;
  const activeCustom = customRoute?.chip ?? null;
  const activeRequestModel = customRoute?.requestModel ?? null;
  const officialLabel = activeModel?.label ?? modelId;
  const modelLabel = composerModelChipLabel({
    modelId,
    officialLabel,
    activeCustom,
  });
  const stopLabelFor = (option: EffortOption) =>
    effortLabelFor(option, labels);
  const activeEffort =
    effortOptions.find((option) => option.id === effort) ?? null;
  const eLabel = activeEffort
    ? stopLabelFor(activeEffort)
    : effortDisplayLabel(effort, effortI18n(labels));
  const strongestId =
    effortOptions.length > 1
      ? effortOptions
          .filter((option) => option.id.trim().toLowerCase() !== "none")
          .at(-1)?.id
      : undefined;
  const activeIsStrongest =
    !!activeEffort && activeEffort.id === strongestId;
  const triggerText = `${modelLabel} ${eLabel}`;
  const advancedLabel = labels.advanced ?? "Advanced";
  const widthCandidates = useMemo(() => {
    const labelsForOptions =
      effortOptions.length > 0
        ? effortOptions.map((option) => effortLabelFor(option, labels))
        : [eLabel];
    return [
      ...new Set(labelsForOptions.map((label) => `${modelLabel} ${label}`)),
    ];
  }, [modelLabel, effortOptions, labels, eLabel]);

  return (
    <MenuShell
      menu={modelMenu}
      className={"cmm--model" + (activeIsStrongest ? " cmm--extra" : "")}
      panelClassName={
        "cmm__pop--model" + (pane === "advanced" ? " cmm__pop--hub" : "")
      }
      tipClassName="ui-tip--flat"
      pinParent
      triggerIcon={<IconBolt size={14} />}
      triggerText={triggerText}
      triggerShort={eLabel}
      widthCandidates={widthCandidates}
      ariaLabel={labels.model}
      title={`${labels.model}: ${modelLabel} · ${labels.effort}: ${eLabel}`}
    >
      <div
        style={{
          height: bodyH,
          overflow: "hidden",
          transition:
            bodyH == null
              ? "none"
              : "height var(--motion-pane) var(--motion-pane-ease)",
        }}
      >
        <div
          className={"cmm__stage" + (pane === "advanced" ? " is-hub" : "")}
          ref={stageRef}
        >
          <div className="cmm__simple-body" aria-hidden={pane !== "simple"}>
            <div className="cmm__simple-head">
              <span
                className={
                  "cmm__simple-title" + (activeIsStrongest ? " is-ultra" : "")
                }
              >
                {labels.effort} {eLabel}
              </span>
            </div>
            <EffortOptionList
              options={effortOptions}
              value={effort}
              labels={labels}
              onEffort={onEffort}
            />
          </div>
          <div
            className="cmm__hub-body cmm__hub"
            aria-hidden={pane !== "advanced"}
            onMouseLeave={hideFlyoutSoon}
          >
            <button
              ref={modelsRowRef}
              type="button"
              className={
                "cmm__row" + (hubFlyout === "models" ? " is-fly" : "")
              }
              aria-haspopup="true"
              aria-expanded={hubFlyout === "models"}
              onMouseEnter={() => showFlyout("models")}
              onFocus={() => showFlyout("models")}
              onClick={() => showFlyout("models")}
            >
              <span>{labels.model}</span>
              <span className="cmm__row-val">
                <span className="cmm__row-val-text">{modelLabel}</span>
                <IconChevronRight size={14} />
              </span>
            </button>
            <button
              ref={effortRowRef}
              type="button"
              className={
                "cmm__row" + (hubFlyout === "effort" ? " is-fly" : "")
              }
              aria-haspopup="true"
              aria-expanded={hubFlyout === "effort"}
              onMouseEnter={() => showFlyout("effort")}
              onFocus={() => showFlyout("effort")}
              onClick={() => showFlyout("effort")}
            >
              <span>{labels.effort}</span>
              <span className="cmm__row-val">
                <span
                  className={
                    "cmm__row-val-text" +
                    (activeIsStrongest ? " is-ultra" : "")
                  }
                >
                  {eLabel}
                </span>
                <IconChevronRight size={14} />
              </span>
            </button>
            <button
              ref={windowRowRef}
              type="button"
              className={
                "cmm__row" + (hubFlyout === "window" ? " is-fly" : "")
              }
              aria-haspopup="true"
              aria-expanded={hubFlyout === "window"}
              onMouseEnter={() => {
                setWindowDraft(
                  contextWindowEditable && contextWindow
                    ? String(contextWindow)
                    : "",
                );
                showFlyout("window");
              }}
              onFocus={() => showFlyout("window")}
              onClick={() => showFlyout("window")}
            >
              <span>{labels.contextWindow}</span>
              <span className="cmm__row-val">
                <span className="cmm__row-val-text">
                  {contextWindow
                    ? formatTokenCount(contextWindow, locale)
                    : "—"}
                </span>
                <IconChevronRight size={14} />
              </span>
            </button>
            {applyNotes?.model ? (
              <div className="cmm__apply-note" role="note">
                {applyNotes.model}
              </div>
            ) : null}
            {applyNotes?.effort ? (
              <div className="cmm__apply-note" role="note">
                {applyNotes.effort}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="cmm__advanced"
            onClick={() =>
              goPane(pane === "advanced" ? "simple" : "advanced")
            }
          >
            {advancedLabel}
            {pane === "advanced" ? (
              <IconChevronUp size={14} />
            ) : (
              <IconChevronRight size={14} />
            )}
          </button>
        </div>
      {hubFlyout && flyPos && pane === "advanced" && !modelMenu.exiting
        ? createPortal(
            <div
              ref={flyoutRef}
              className={
                "cmm__pop cmm__pop--portal cmm__pop--flyout" +
                (hubFlyout === "models" ? " cmm__pop--flyout-models" : "")
              }
              data-side={flySide}
              data-kind={hubFlyout}
              style={flyPos}
              onMouseEnter={() => hubFlyout && showFlyout(hubFlyout)}
              onMouseLeave={hideFlyoutSoon}
            >
              {hubFlyout === "models" ? (
                groups.length === 0 ? (
                  <div className="cmm__opt cmm__opt--muted" role="status">
                    <span className="cmm__opt-main">
                      <span className="cmm__opt-title">{modelId || "—"}</span>
                    </span>
                  </div>
                ) : (
                  <div className="cmm__flyout-stack">
                    <div className="cmm__search">
                      <input
                        ref={modelSearchRef}
                        type="search"
                        className="cmm__search-input"
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        placeholder={labels.modelSearchPlaceholder}
                        aria-label={labels.modelSearchPlaceholder}
                        autoComplete="off"
                        spellCheck={false}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.preventDefault();
                        }}
                      />
                    </div>
                    <div className="cmm__flyout-list">
                      {filteredGroups.length === 0 ? (
                        <div className="cmm__opt cmm__opt--muted" role="status">
                          <span className="cmm__opt-main">
                            <span className="cmm__opt-title">
                              {labels.modelSearchEmpty}
                            </span>
                          </span>
                        </div>
                      ) : (
                        filteredGroups.map((group) => (
                          <div key={group.key}>
                            {filteredGroups.length > 1 ? (
                              <div className="cmm__section">{group.title}</div>
                            ) : null}
                            {group.entries.map((entry) => {
                              const active = isComposerModelEntryActive(
                                entry,
                                {
                                  activeSource,
                                  activeProviderId,
                                  activeRequestModel,
                                  modelId,
                                },
                              );
                              return (
                                <button
                                  key={entry.key}
                                  type="button"
                                  className={
                                    "cmm__opt" + (active ? " is-active" : "")
                                  }
                                  title={
                                    entry.subtitle
                                      ? `${entry.title} · ${entry.subtitle}`
                                      : entry.title
                                  }
                                  onClick={() => selectPick(entry.pick)}
                                >
                                  <span className="cmm__opt-main">
                                    <span className="cmm__opt-title">
                                      {entry.title}
                                    </span>
                                  </span>
                                  {active ? (
                                    <span
                                      className="cmm__opt-check"
                                      aria-hidden
                                    >
                                      <IconCheck size={16} />
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )
              ) : hubFlyout === "effort" ? (
                effortOptions.length > 0 ? (
                  effortOptions.map((option) => {
                    const active = option.id === effort;
                    const strongest =
                      option.id ===
                      effortOptions
                        .filter(
                          (candidate) =>
                            candidate.id.trim().toLowerCase() !== "none",
                        )
                        .at(-1)?.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={"cmm__opt" + (active ? " is-active" : "")}
                        aria-pressed={active}
                        onClick={() => onEffort(option.id)}
                      >
                        <span className="cmm__opt-main">
                          <span
                            className={
                              "cmm__opt-title" +
                              (strongest ? " is-ultra" : "")
                            }
                          >
                            {stopLabelFor(option)}
                          </span>
                        </span>
                        {active ? (
                          <span className="cmm__opt-check" aria-hidden>
                            <IconCheck size={16} />
                          </span>
                        ) : null}
                      </button>
                    );
                  })
                ) : labels.effortUnavailable ? (
                  <div className="cmm__opt cmm__opt--muted" role="status">
                    <span className="cmm__opt-main">
                      <span className="cmm__opt-title">
                        {labels.effortUnavailable}
                      </span>
                    </span>
                  </div>
                ) : null
              ) : officialWindowChoices.length > 1 ? (
                officialWindowChoices.map((n) => {
                  const active = contextWindow === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      className={"cmm__opt" + (active ? " is-active" : "")}
                      onClick={() => onContextWindow?.(n)}
                    >
                      <span className="cmm__opt-main">
                        <span className="cmm__opt-title">
                          {formatTokenCount(n, locale)}
                        </span>
                      </span>
                      {active ? (
                        <span className="cmm__opt-check" aria-hidden>
                          <IconCheck size={16} />
                        </span>
                      ) : null}
                    </button>
                  );
                })
              ) : contextWindowEditable ? (
                <div className="cmm__window-edit">
                  <div className="cmm__window-edit__label">
                    {labels.contextWindowCustom}
                  </div>
                  <div className="cmm__inline-edit">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={windowDraft}
                      placeholder={labels.contextWindowPlaceholder}
                      aria-label={labels.contextWindowCustom}
                      onChange={(e) => setWindowDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const n = parseInt(windowDraft, 10);
                          if (Number.isFinite(n) && n > 0) {
                            onContextWindow?.(n);
                          }
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="cmm__inline-save"
                      disabled={!Number.isFinite(parseInt(windowDraft, 10))}
                      onClick={() => {
                        const n = parseInt(windowDraft, 10);
                        if (Number.isFinite(n) && n > 0) {
                          onContextWindow?.(n);
                        }
                      }}
                    >
                      {labels.contextWindowSave}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="cmm__opt cmm__opt--muted">
                  <span className="cmm__opt-main">
                    <span className="cmm__opt-title">
                      {contextWindow
                        ? formatTokenCount(contextWindow, locale)
                        : "—"}
                    </span>
                    <span className="cmm__opt-desc">
                      {contextWindow
                        ? labels.contextWindowOfficial
                        : labels.contextWindowOfficialHint}
                    </span>
                  </span>
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
      </div>
    </MenuShell>
  );
}

/* ---------- Access: mode + permission (Codex-style one entry) ---------- */

export interface ComposerAccessMenuProps {
  mode: string;
  policy: string;
  labels: {
    access: string;
    accessHint: string;
    mode: string;
    modeAgent: string;
    modePlan: string;
    modeAsk: string;
    modeAgentDesc: string;
    modePlanDesc: string;
    modeAskDesc: string;
    permission: string;
    policyAsk: string;
    policyAcceptEdits: string;
    policySession: string;
    policyAuto: string;
    policyDontAsk: string;
    policyYolo: string;
    policyAskDesc: string;
    policyAcceptEditsDesc: string;
    policySessionDesc: string;
    policyAutoDesc: string;
    policyDontAskDesc: string;
    policyYoloDesc: string;
    policyShortAsk: string;
    policyShortAccept: string;
    policyShortSession: string;
    policyShortAuto: string;
    policyShortDontAsk: string;
    policyShortYolo: string;
  };
  onMode: (id: string) => void;
  onPolicy: (id: PermissionPolicyId) => void;
}

function modeLabel(id: string, labels: ComposerAccessMenuProps["labels"]): string {
  if (id === "plan") return labels.modePlan;
  if (id === "ask") return labels.modeAsk;
  return labels.modeAgent;
}

function modeDesc(id: string, labels: ComposerAccessMenuProps["labels"]): string {
  if (id === "plan") return labels.modePlanDesc;
  if (id === "ask") return labels.modeAskDesc;
  return labels.modeAgentDesc;
}

function policyLabel(
  id: string,
  labels: ComposerAccessMenuProps["labels"],
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

function policyShort(
  id: string,
  labels: ComposerAccessMenuProps["labels"],
): string {
  switch (id) {
    case "accept_edits":
      return labels.policyShortAccept;
    case "allow_for_session":
      return labels.policyShortSession;
    case "auto":
      return labels.policyShortAuto;
    case "dont_ask":
      return labels.policyShortDontAsk;
    case "always_approve":
      return labels.policyShortYolo;
    default:
      return labels.policyShortAsk;
  }
}

function policyDesc(
  id: string,
  labels: ComposerAccessMenuProps["labels"],
): string {
  switch (id) {
    case "accept_edits":
      return labels.policyAcceptEditsDesc;
    case "allow_for_session":
      return labels.policySessionDesc;
    case "auto":
      return labels.policyAutoDesc;
    case "dont_ask":
      return labels.policyDontAskDesc;
    case "always_approve":
      return labels.policyYoloDesc;
    default:
      return labels.policyAskDesc;
  }
}

function policyIcon(id: string) {
  switch (id) {
    case "accept_edits":
      return <IconShieldCheck size={18} />;
    case "allow_for_session":
      return <IconShield size={18} />;
    case "auto":
      return <IconBolt size={18} />;
    case "dont_ask":
      return <IconHandStop size={18} />;
    case "always_approve":
      return <IconAlertTriangle size={18} />;
    default:
      return <IconHandStop size={18} />;
  }
}

function modeIcon(id: string) {
  if (id === "plan") return <IconList size={18} />;
  if (id === "ask") return <IconHandStop size={18} />;
  return <IconRobot size={18} />;
}

export function ComposerAccessMenu({
  mode,
  policy,
  labels,
  onMode,
  onPolicy,
}: ComposerAccessMenuProps) {
  /* Wider dual-column sheet: mode | permission side by side. */
  const menu = useComposerPortalMenu({
    estHeight: 280,
    width: 300,
    minWidth: 260,
    fitContent: false,
  });
  const isDanger = policy === "always_approve";
  const full = policyLabel(policy, labels);
  const short = policyShort(policy, labels);
  const title = `${labels.mode}: ${modeLabel(mode, labels)} · ${labels.permission}: ${full}`;

  return (
    <MenuShell
      menu={menu}
      className="cmm--access"
      panelClassName="cmm__pop--access"
      triggerIcon={policyIcon(policy)}
      triggerText={full}
      triggerShort={short}
      ariaLabel={labels.access}
      title={title}
      danger={isDanger}
    >
      <div className="cmm__header">
        <div className="cmm__header-title">{labels.accessHint}</div>
      </div>

      <div className="cmm__access-cols">
        <div className="cmm__access-col" role="group" aria-label={labels.mode}>
          <div className="cmm__section">{labels.mode}</div>
          {SESSION_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={
                "cmm__opt cmm__opt--access" + (m.id === mode ? " is-active" : "")
              }
              title={modeDesc(m.id, labels)}
              onClick={() => onMode(m.id)}
            >
              <span className="cmm__opt-icon" aria-hidden>
                {modeIcon(m.id)}
              </span>
              <span className="cmm__opt-main">
                <span className="cmm__opt-title">{modeLabel(m.id, labels)}</span>
                <span className="cmm__opt-desc">{modeDesc(m.id, labels)}</span>
              </span>
              {m.id === mode && (
                <span className="cmm__opt-check" aria-hidden>
                  <IconCheck size={16} />
                </span>
              )}
            </button>
          ))}
        </div>

        <div
          className="cmm__access-col"
          role="group"
          aria-label={labels.permission}
        >
          <div className="cmm__section">{labels.permission}</div>
          {PERMISSION_POLICIES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={
                "cmm__opt cmm__opt--access" +
                (p.id === policy ? " is-active" : "") +
                (p.dangerous ? " is-danger" : "")
              }
              title={policyDesc(p.id, labels)}
              onClick={() => {
                onPolicy(p.id);
                menu.setOpen(false);
              }}
            >
              <span className="cmm__opt-icon" aria-hidden>
                {policyIcon(p.id)}
              </span>
              <span className="cmm__opt-main">
                <span className="cmm__opt-title">
                  {policyLabel(p.id, labels)}
                </span>
                <span className="cmm__opt-desc">
                  {policyDesc(p.id, labels)}
                </span>
              </span>
              {p.id === policy && (
                <span className="cmm__opt-check" aria-hidden>
                  <IconCheck size={16} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </MenuShell>
  );
}

