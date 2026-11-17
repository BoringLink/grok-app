/**
 * Catalogs aligned with Grok Build CLI (`grok models`, reasoning effort, permission).
 * Live selectable models come from `models_list_available` (CLI cache + custom providers).
 * Update docs/llm-wiki/catalog.md when defaults change.
 */

export interface EffortOption {
  /** Effort id passed to `--reasoning-effort` (e.g. low / medium / high). */
  id: string;
  /** CLI value when distinct from id; usually equals id. */
  value?: string;
  /** Display label from catalog when present. */
  label?: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelOption {
  id: string;
  /** Display name (language-neutral product name) */
  label: string;
  /** True if CLI lists as default */
  isDefault?: boolean;
  /** Catalog source; official list is one group in the composer model menu. */
  source?: string;
  /** Per-model reasoning efforts from CLI cache; empty/undefined → static fallback. */
  reasoningEfforts?: EffortOption[];
  /** Model context window in tokens (live-merged from `initialize`). Catalog default. */
  contextWindow?: number | null;
  /**
   * Selectable windows from CLI `info.context_windows` / `contextWindows`.
   * More than one entry is what makes `/context-window` and the Advanced
   * flyout list available. Order is the catalog order.
   */
  contextWindows?: number[] | null;
}

export interface SessionModeOption {
  id: "agent" | "plan" | "ask";
}

/**
 * Permission policies (composer + settings), aligned with Grok Build modes:
 * | Build / CLI `--permission-mode` | App id            |
 * | default                         | ask               |
 * | acceptEdits                     | accept_edits      |
 * | (session grant UX → default)    | allow_for_session |
 * | auto                            | auto              |
 * | dontAsk                         | dont_ask          |
 * | bypassPermissions               | always_approve    |
 * | plan                            | (product mode `plan`, not a policy) |
 *
 * Pure map helpers: `src/lib/permissionModeMap.ts`.
 */
export type PermissionPolicyId =
  | "ask"
  | "accept_edits"
  | "allow_for_session"
  | "auto"
  | "dont_ask"
  | "always_approve";

/** Where composer model / permission choices are remembered. */
export type ComposerPrefsScope = "global" | "project" | "session";

export const COMPOSER_PREFS_SCOPES: ComposerPrefsScope[] = [
  "global",
  "project",
  "session",
];

/**
 * Static 3-tier fallback (low / medium / high) when a model has no
 * `reasoning_efforts` in cache. Default **high** matches Grok Build 1.0
 * and the official API default. Prefer live catalog via
 * `pickDefaultEffort(model)` whenever available.
 */
export const GROK_BUILD_EFFORTS: EffortOption[] = [
  { id: "low" },
  { id: "medium" },
  { id: "high", isDefault: true },
];

/**
 * Official 4-tier efforts shared by Grok 4.6, Grok 4.7, and Grok 4.7 Fast.
 * Product default on these models is **xhigh**. Live cache may mark both
 * high and xhigh as `default: true` — callers must go through
 * `pickDefaultEffort` / `normalizeEffortDefaults`.
 */
export const GROK_4_6_EFFORTS: EffortOption[] = [
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "xhigh", isDefault: true },
];

/** Official ids that expose 极高 / `xhigh` when the live catalog has no efforts yet. */
const OFFICIAL_FOUR_TIER_IDS = new Set([
  "grok-4.7",
  "grok-4.7-build-fast",
  "grok-4.6",
]);

/**
 * CLI catalog default and the selectable list for Grok 4.7 / Fast / 4.6 / 4.5.
 * `models_cache.json` advertises `context_window: 256000` and
 * `context_windows: [256000, 500000]`. 256k is the CLI catalog default.
 * When 500k is listed, a new chat in this app starts at 500k.
 */
export const GROK_BUILD_CONTEXT_WINDOW = 256000;
export const GROK_BUILD_CONTEXT_WINDOWS = [256000, 500000];
/** Window a new official chat uses when the model advertises it. */
export const GROK_BUILD_APP_DEFAULT_CONTEXT_WINDOW = 500000;

/**
 * Fallback catalog when Host has not returned live models yet.
 * Official OAuth exposes grok-4.7 (default), grok-4.7-build-fast, grok-4.6,
 * and grok-4.5 (2026-09 probe). `grok-build` is NOT listed — CLI rejects it.
 */
export const GROK_BUILD_MODELS: ModelOption[] = [
  {
    id: "grok-4.7",
    label: "Grok 4.7",
    isDefault: true,
    source: "official",
    reasoningEfforts: GROK_4_6_EFFORTS,
    contextWindow: GROK_BUILD_CONTEXT_WINDOW,
    contextWindows: GROK_BUILD_CONTEXT_WINDOWS,
  },
  {
    id: "grok-4.7-build-fast",
    label: "Grok 4.7 Fast",
    source: "official",
    reasoningEfforts: GROK_4_6_EFFORTS,
    contextWindow: GROK_BUILD_CONTEXT_WINDOW,
    contextWindows: GROK_BUILD_CONTEXT_WINDOWS,
  },
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    source: "official",
    reasoningEfforts: GROK_4_6_EFFORTS,
    contextWindow: GROK_BUILD_CONTEXT_WINDOW,
    contextWindows: GROK_BUILD_CONTEXT_WINDOWS,
  },
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    source: "official",
    reasoningEfforts: GROK_BUILD_EFFORTS,
    contextWindow: GROK_BUILD_CONTEXT_WINDOW,
    contextWindows: GROK_BUILD_CONTEXT_WINDOWS,
  },
];

export const DEFAULT_MODEL_ID =
  GROK_BUILD_MODELS.find((m) => m.isDefault)?.id ?? "grok-4.7";

/**
 * Fallback context window (tokens) for custom providers that have not set one.
 * Official models prefer the live `contextWindow` from `initialize` / cache.
 */
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 1_000_000;

/**
 * Cold-start default reasoning depth when no live catalog is loaded yet.
 * Aligned with Grok Build 1.0 official default (**high**). Users can lower
 * effort for faster turns via the composer chip. Prefer
 * `pickDefaultEffort(model)` when the model lists a default.
 */
export const DEFAULT_EFFORT = "high";

/** Product session modes (desktop shell). */
export const SESSION_MODES: SessionModeOption[] = [
  { id: "agent" },
  { id: "plan" },
  { id: "ask" },
];

/**
 * Permission policies (composer + settings).
 * `always_approve` = YOLO / unrestricted (CLI `--always-approve` + `bypassPermissions`).
 * `auto` = CLI auto mode (fewer prompts with safety checks).
 * Product **plan** is a session mode, not a row here — see `permissionModeMap`.
 */
export const PERMISSION_POLICIES: {
  id: PermissionPolicyId;
  dangerous?: boolean;
}[] = [
  { id: "ask" },
  { id: "accept_edits" },
  { id: "allow_for_session" },
  { id: "auto" },
  { id: "dont_ask" },
  { id: "always_approve", dangerous: true },
];

export function isValidModelId(
  id: string,
  catalog: ModelOption[] = GROK_BUILD_MODELS,
): boolean {
  return catalog.some((m) => m.id === id);
}

/**
 * Collapse multiple `isDefault` flags. CLI grok-4.6 cache marks both
 * `xhigh` and `high` as default; product default on 4.6 is **xhigh**.
 */
export function normalizeEffortDefaults(
  efforts: EffortOption[],
): EffortOption[] {
  const flagged = efforts.filter((e) => e.isDefault);
  if (flagged.length <= 1) return efforts;
  const preferXhigh = flagged.some(
    (e) => e.id.trim().toLowerCase() === "xhigh",
  );
  if (preferXhigh) {
    return efforts.map((e) => ({
      ...e,
      isDefault: e.id.trim().toLowerCase() === "xhigh",
    }));
  }
  const preferHigh = flagged.some(
    (e) => e.id.trim().toLowerCase() === "high",
  );
  if (!preferHigh) return efforts;
  return efforts.map((e) => ({
    ...e,
    isDefault: e.id.trim().toLowerCase() === "high",
  }));
}

function fallbackEffortsForModelId(modelId?: string | null): EffortOption[] {
  const id = modelId?.trim().toLowerCase() ?? "";
  if (OFFICIAL_FOUR_TIER_IDS.has(id)) return GROK_4_6_EFFORTS;
  return GROK_BUILD_EFFORTS;
}

/**
 * Efforts list for a model: live catalog when non-empty, else static fallback.
 * Grok 4.7, 4.7 Fast, and 4.6 fall back to 4-tier (incl. xhigh). Grok 4.5
 * and other official models stay 3-tier.
 */
export function effortsForModel(
  model?: ModelOption | null,
  catalogEfforts?: EffortOption[] | null,
): EffortOption[] {
  const fromArg =
    catalogEfforts && catalogEfforts.length > 0 ? catalogEfforts : null;
  const fromModel =
    model?.reasoningEfforts && model.reasoningEfforts.length > 0
      ? model.reasoningEfforts
      : null;
  const raw = fromArg ?? fromModel ?? fallbackEffortsForModelId(model?.id);
  return normalizeEffortDefaults(
    raw.filter((option) => isSpawnableReasoningEffort(option.id)),
  );
}

/**
 * Validate an effort id against the selected model's efforts when known;
 * otherwise against the static GROK_BUILD_EFFORTS fallback.
 */
export function isValidEffort(
  id: string,
  modelOrEfforts?: ModelOption | EffortOption[] | null,
): boolean {
  if (!id) return false;
  if (Array.isArray(modelOrEfforts)) {
    return effortsForModel(null, modelOrEfforts).some((e) => e.id === id);
  }
  return effortsForModel(modelOrEfforts).some((e) => e.id === id);
}

/**
 * Default effort for a model: the catalog's `isDefault` flag, else the first
 * non-Off option (API provided a ladder but no default; Off is never the
 * implicit default), else `medium` when there is no effort information at
 * all (medium is always inside the CLI's fixed wire enum).
 */
export function pickDefaultEffort(
  model?: ModelOption | null,
  catalogEfforts?: EffortOption[] | null,
): string {
  const list = effortsForModel(model, catalogEfforts);
  const explicit = list.find((e) => e.isDefault)?.id;
  if (explicit) return explicit;
  const firstNonOff = list.find(
    (e) => e.id.trim().toLowerCase() !== "none",
  )?.id;
  return firstNonOff ?? list[0]?.id ?? "medium";
}

/**
 * Whether a string is safe to pass as CLI `--reasoning-effort <id>`.
 * Catalog may expose low/medium/high, custom `max`, or channel-specific tiers.
 * Host spawn must not hard-allowlist only Grok 3-tier ids.
 */
export function isSpawnableReasoningEffort(id: string): boolean {
  const t = id.trim();
  if (!t || t.length > 64) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t);
}

/**
 * Strip a shared CLI suffix so "High Effort" / "Medium Effort" collapse to
 * "High" / "Medium" (identical trailing " Effort" is noise in compact UI).
 */
export function stripCommonEffortSuffix(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  const stripped = trimmed.replace(/\s+Effort$/i, "").trim();
  return stripped || trimmed;
}

/**
 * Display label for an effort.
 * - Standard Grok ids (`high` / `medium` / `low`): prefer i18n.
 * - DeepSeek-style ids (`xhigh` / `max` / `none`): prefer i18n when provided.
 * - Other catalog labels: strip a shared " Effort" suffix, then raw id / label.
 */
/** Known effort ids that have dedicated i18n keys (`effort.<id>`). */
const I18N_EFFORT_IDS = new Set([
  "high",
  "medium",
  "low",
  "xhigh",
  "max",
  "none",
]);

export function effortDisplayLabel(
  effort: EffortOption | string,
  i18nLabels?: {
    high?: string;
    medium?: string;
    low?: string;
    xhigh?: string;
    max?: string;
    none?: string;
  },
): string {
  const id = (typeof effort === "string" ? effort : effort.id)
    .trim()
    .toLowerCase();
  // Prefer locale labels for known ids even when the catalog stored an
  // English `name`/`label` (e.g. channel efforts saved as "xhigh"/"max").
  if (id === "high" && i18nLabels?.high) return i18nLabels.high;
  if (id === "medium" && i18nLabels?.medium) return i18nLabels.medium;
  if (id === "low" && i18nLabels?.low) return i18nLabels.low;
  if (id === "xhigh" && i18nLabels?.xhigh) return i18nLabels.xhigh;
  // DeepSeek `max` is the top UI slot (极高); prefer xhigh label when max text omitted.
  if (id === "max") {
    if (i18nLabels?.max) return i18nLabels.max;
    if (i18nLabels?.xhigh) return i18nLabels.xhigh;
  }
  if (id === "none" && i18nLabels?.none) return i18nLabels.none;

  if (typeof effort !== "string") {
    const raw = effort.label?.trim();
    // Skip label when it is just the raw id (would re-show English "xhigh").
    if (raw && raw.toLowerCase() !== id && !I18N_EFFORT_IDS.has(raw.toLowerCase())) {
      return stripCommonEffortSuffix(raw);
    }
    if (raw && !I18N_EFFORT_IDS.has(id)) {
      return stripCommonEffortSuffix(raw);
    }
    return effort.id;
  }
  return effort;
}

/**
 * Map provider-channel effort entries into EffortOption for composer menus.
 */
export function effortOptionsFromProvider(
  efforts:
    | Array<{ id: string; name?: string; label?: string; isDefault?: boolean }>
    | null
    | undefined,
): EffortOption[] | null {
  if (!efforts?.length) return null;
  const out: EffortOption[] = [];
  const seen = new Set<string>();
  for (const e of efforts) {
    const id = e.id?.trim() ?? "";
    if (!isSpawnableReasoningEffort(id) || seen.has(id)) continue;
    seen.add(id);
    const label = (e.name ?? e.label)?.trim();
    out.push({
      id,
      label: label || undefined,
      isDefault: !!e.isDefault,
    });
  }
  return out.length ? out : null;
}

export function isValidPolicy(id: string): id is PermissionPolicyId {
  return PERMISSION_POLICIES.some((p) => p.id === id);
}

export function isValidPrefsScope(id: string): id is ComposerPrefsScope {
  return COMPOSER_PREFS_SCOPES.includes(id as ComposerPrefsScope);
}

export function pickDefaultModelId(catalog: ModelOption[]): string {
  return (
    catalog.find((m) => m.isDefault)?.id ??
    catalog[0]?.id ??
    DEFAULT_MODEL_ID
  );
}

/** Find a model in catalog by id. */
export function findModel(
  id: string,
  catalog: ModelOption[] = GROK_BUILD_MODELS,
): ModelOption | undefined {
  return catalog.find((m) => m.id === id);
}

/**
 * Resolve the effective context window (tokens) for the composer context.
 *
 * Precedence:
 * 1. Agent-reported CLI denominator (`auto_compact_started.context_window` /
 *    occupancy usage) when positive — matches `/session-info`.
 * 2. Custom provider route: channel `contextWindow`, else
 *    {@link DEFAULT_CUSTOM_CONTEXT_WINDOW} (1M). **Custom only.**
 * 3. Official route: live model `contextWindow` from `models_cache` /
 *    `initialize` merge. Never invent 200k when live says 500k (or any
 *    other catalog value). `null` when unknown (chip hides the % row).
 */
export function resolveContextWindow(opts: {
  activeCustomProvider?: { contextWindow?: number | null } | null;
  modelId: string;
  models?: ModelOption[];
  /**
   * Agent-reported context window (tokens). When set and positive, wins
   * over catalog so Grok Build 1.0 occupancy (500k) is never replaced by a
   * stale catalog or the custom-channel 1M default.
   */
  agentContextWindow?: number | null;
}): number | null {
  const {
    activeCustomProvider,
    modelId,
    models = GROK_BUILD_MODELS,
    agentContextWindow,
  } = opts;
  if (
    agentContextWindow != null &&
    Number.isFinite(agentContextWindow) &&
    agentContextWindow > 0
  ) {
    return Math.floor(agentContextWindow);
  }
  if (activeCustomProvider) {
    const custom = activeCustomProvider.contextWindow;
    if (custom != null && Number.isFinite(custom) && custom > 0) {
      return Math.floor(custom);
    }
    return DEFAULT_CUSTOM_CONTEXT_WINDOW;
  }
  const m = findModel(modelId, models);
  if (
    m &&
    (m.contextWindows?.includes(GROK_BUILD_APP_DEFAULT_CONTEXT_WINDOW) ||
      m.contextWindow === GROK_BUILD_APP_DEFAULT_CONTEXT_WINDOW)
  ) {
    return GROK_BUILD_APP_DEFAULT_CONTEXT_WINDOW;
  }
  const catalog = m?.contextWindow;
  if (catalog != null && Number.isFinite(catalog) && catalog > 0) {
    return Math.floor(catalog);
  }
  // Official / unknown: never fall back to DEFAULT_CUSTOM_CONTEXT_WINDOW.
  return null;
}
