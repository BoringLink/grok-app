/**
 * Settings → Extensions: Hooks list + Plugin marketplace browser + Agents list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import { Select } from "@/components/Select";
import type { ProjectRecord } from "@/lib/api/project";
import {
  IconExternalLink,
  IconFolder,
  IconHooks,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconRobot,
  IconTrash,
} from "@/components/icons";
import { isCliMissingError, shortPathLabel } from "@/lib/extensionsUi";
import {
  canManageAgentWorkspace,
  agentProjectIdForScope,
  agentProjectPathForScope,
  agentProjectScopeOptions,
  isCurrentAgentCatalogRequest,
  mapAgentDefinitions,
  reusablePersonaDefinitions,
  type AgentWorkspaceView,
} from "@/lib/agentsWorkspace";
import {
  agentMetaLine,
  agentScopeTone,
  isValidAgentFileStemName,
  sanitizeAgentFileStemName,
  sortAgentDefs,
  type AgentDefLike,
} from "@/lib/agentsDiscovery";
import {
  formatHookMtime,
  formatHookSize,
  hookMetaLine,
  hookRowKey,
  hookTypeLabel,
  sortHooksByScopeName,
  type HookLike,
} from "@/lib/hooksUi";
import {
  loadMarketplaceCatalog,
  invalidateMarketplaceCatalogCache,
  removeAvailablePluginFromCache,
} from "@/lib/marketplaceCatalogCache";
import {
  availablePluginDetailModel,
  availablePluginMetaLine,
  availablePluginRowKey,
  enrichAvailableFromComponents,
  filterAvailableByMarketplace,
  filterAvailablePlugins,
  filterPluginsByQuery,
  isXaiOfficialMarketplace,
  marketplaceQualifiedInstallSource,
  marketplaceRemoveTarget,
  marketplaceSourceLabel,
  normalizeMarketplaceAddSource,
  sortAvailablePluginsByName,
  sortMarketplaceSourcesByName,
  type AvailablePluginDetailModel,
  type AvailablePluginLike,
  type MarketplaceSourceLike,
  type PluginComponentBadgeKind,
} from "@/lib/pluginMarketplace";
import {
  buildInstalledPluginNameSet,
  isCatalogPluginInstalled,
} from "@/lib/pluginCatalogUi";
import {
  findOpenaiPluginsSource,
  pickDefaultInstallableFilter,
} from "@/lib/pluginRecommended";

const AGENT_JSON_FRONTMATTER_FIELDS = [
  "bash",
  "toolNameOverrides",
  "paramNameOverrides",
  "completionRequirement",
  "toolConfig",
  "mcpServers",
] as const;

function defaultAgentFrontmatter(): Record<string, unknown> {
  return {
    promptMode: "full",
    permissionMode: "default",
    agentsMd: true,
    outputFormat: "default",
    bash: {},
    toolNameOverrides: {},
    paramNameOverrides: {},
    completionRequirement: {},
    toolConfig: {},
    mcpInheritance: "all",
  };
}

function jsonFieldText(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

type McpInheritanceMode = "all" | "none" | "named" | "except";

/** Read the selected MCP inheritance mode from its schema union value. */
function mcpInheritanceMode(value: unknown): McpInheritanceMode {
  if (value === "none" || value === "named" || value === "except") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mode = Object.keys(value)[0];
    if (mode === "named" || mode === "except") return mode;
  }
  return "all";
}

/** Read selected MCP names from a named or except inheritance value. */
function mcpInheritanceNames(value: unknown, mode: "named" | "except"): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return stringArrayField((value as Record<string, unknown>)[mode]);
}

/** Decode the UI value used to select an existing scoped Persona. */
function parsePersonaSource(value: string): { scope: "user" | "project"; name: string } | null {
  const separator = value.indexOf("::");
  if (separator <= 0 || separator === value.length - 2) return null;
  const scope = value.slice(0, separator);
  if (scope !== "user" && scope !== "project") return null;
  return { scope, name: value.slice(separator + 2) };
}

type AgentFrontmatterTextareaProps = {
  label: string;
  value: string;
  disabled: boolean;
  invalid?: boolean;
  onChange: (value: string) => void;
};

/** Render a localized multiline editor for a structured Agent frontmatter field. */
function AgentFrontmatterTextarea({
  label,
  value,
  disabled,
  invalid = false,
  onChange,
}: AgentFrontmatterTextareaProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        className="app-dialog__input ext-agents__instructions"
        value={value}
        rows={4}
        maxLength={65536}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </label>
  );
}
import {
  ensureDefaultMarketplaces,
  filterCatalogToDefaultSources,
  isClaudeMarketplaceSource,
  isDefaultAllowedMarketplaceSource,
} from "@/lib/marketplaceDefaults";
import {
  buildPluginMarketErrorView,
  clearPluginMarketRowError,
  formatPluginMarketRowErrorMessage,
  planPluginMarketEmptyRetry,
  planPluginMarketRetry,
  pluginMarketErrorHintKey,
  pluginMarketErrorTitleKey,
  pluginMarketLoadIsSoftFail,
  resolvePluginCatalogEmptyState,
  setPluginMarketRowError,
  type PluginMarketRowError,
} from "@/lib/pluginMarketPro";

/** Actions the parent tab trail can host (Agents). */
export type ExtAgentsTabActions = {
  refresh: () => void;
  busy: boolean;
  loading: boolean;
};

export type ExtensionsBuildExtrasProps = {
  locale: Locale;
  projectPath?: string | null;
  sessionDataMode?: string;
  cliFound?: boolean;
  /** Which block(s) to render — settings page tabs use market | agents. */
  mode?: "hooks" | "market" | "agents" | "all";
  /**
   * When true (plugins tab installable section), hide page-level market H2
   * and rely on parent section chrome.
   */
  embedded?: boolean;
  /** Sources management only (modal) — hide available catalog list. */
  sourcesOnly?: boolean;
  /** Soft-fail ensure openai/plugins error bubble (optional parent display). */
  onEnsureOpenaiError?: (message: string | null) => void;
  /** After plugin install — parent can refresh plugins list. */
  onPluginsChanged?: () => void;
  /** Navigate to Settings → Runtime when CLI is missing / too old. */
  onOpenRuntime?: () => void;
  /**
   * When true, hide the in-page Agents toolbar (actions live in the tab trail).
   */
  hidePageToolbar?: boolean;
  /** Register / clear Agents actions for the parent tab trail. */
  onTabActionsChange?: (actions: ExtAgentsTabActions | null) => void;
  /**
   * Installed plugin names (and optional marketplace/source/path) so catalog
   * rows can offer Reinstall and match “already installed” state — including
   * CLI hash-suffixed ids (e.g. game-studio-8978c99b ↔ game-studio).
   */
  installedPlugins?: Array<{
    name: string;
    marketplace?: string | null;
    path?: string | null;
    source?: string | null;
    repoKey?: string | null;
  }>;
};

const BADGE_LABEL_KEY: Record<PluginComponentBadgeKind, MessageKey> = {
  skills: "ext.market.badge.skills",
  hooks: "ext.market.badge.hooks",
  agents: "ext.market.badge.agents",
  mcp: "ext.market.badge.mcp",
};

const PAGE_SIZE = 40;

function asSource(raw: Record<string, unknown>): MarketplaceSourceLike | null {
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    kind: String(raw.kind ?? raw.type ?? "git").trim() || "git",
    url: (raw.url as string | null | undefined) ?? null,
    path: (raw.path as string | null | undefined) ?? null,
    branch: (raw.branch as string | null | undefined) ?? null,
  };
}

function asAvailable(raw: Record<string, unknown>): AvailablePluginLike | null {
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const status = String(raw.status ?? "available").trim() || "available";
  const skillCountRaw =
    typeof raw.skillCount === "number"
      ? raw.skillCount
      : typeof raw.skill_count === "number"
        ? raw.skill_count
        : null;
  const enriched = enrichAvailableFromComponents(raw, {
    skillCount: skillCountRaw,
    hasHooks: !!(raw.hasHooks ?? raw.has_hooks),
    hasAgents: !!(raw.hasAgents ?? raw.has_agents),
    hasMcp: !!(raw.hasMcp ?? raw.has_mcp),
  });
  return {
    name,
    status,
    marketplace:
      (raw.marketplace as string | null | undefined) ??
      (raw.market as string | null | undefined) ??
      null,
    description: (raw.description as string | null | undefined) ?? null,
    version: (raw.version as string | null | undefined) ?? null,
    skillCount: enriched.skillCount,
    hasHooks: enriched.hasHooks,
    hasAgents: enriched.hasAgents,
    hasMcp: enriched.hasMcp,
  };
}

export function ExtensionsBuildExtras({
  locale,
  projectPath = null,
  sessionDataMode = "shared",
  cliFound = true,
  mode = "all",
  embedded = false,
  sourcesOnly = false,
  onEnsureOpenaiError,
  onPluginsChanged,
  onOpenRuntime,
  hidePageToolbar = false,
  onTabActionsChange,
  installedPlugins = [],
}: ExtensionsBuildExtrasProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const cliMissing = !cliFound;
  const showHooks = mode === "all" || mode === "hooks";
  const showMarket = mode === "all" || mode === "market";
  const showAgents = mode === "all" || mode === "agents";

  const [hooks, setHooks] = useState<HookLike[]>([]);
  const [hooksError, setHooksError] = useState<string | null>(null);
  const [hooksLoading, setHooksLoading] = useState(true);
  const [hooksBusy, setHooksBusy] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentDefLike[]>([]);
  const [userAgentsDir, setUserAgentsDir] = useState("");
  const [roles, setRoles] = useState<api.AgentDefinitionDto[]>([]);
  const [personas, setPersonas] = useState<api.AgentDefinitionDto[]>([]);
  const [savedProjects, setSavedProjects] = useState<ProjectRecord[]>([]);
  const [agentsScopeSelection, setAgentsScopeSelection] = useState("global");
  const [discoveryWarnings, setDiscoveryWarnings] = useState<
    api.AgentDiscoveryWarningDto[]
  >([]);
  const [agentsView, setAgentsView] = useState<AgentWorkspaceView>("agents");
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsBusy, setAgentsBusy] = useState<string | null>(null);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentDescription, setNewAgentDescription] = useState("");
  const [newAgentInstructions, setNewAgentInstructions] = useState("");
  const [newAgentPersonaSource, setNewAgentPersonaSource] = useState("");
  const [newAgentFrontmatter, setNewAgentFrontmatter] = useState<Record<string, unknown>>(
    defaultAgentFrontmatter,
  );
  const [agentJsonFieldText, setAgentJsonFieldText] = useState<Record<string, string>>(
    () => Object.fromEntries(
      AGENT_JSON_FRONTMATTER_FIELDS.map((field) => [
        field,
        jsonFieldText(defaultAgentFrontmatter()[field]),
      ]),
    ),
  );
  const [agentJsonFieldErrors, setAgentJsonFieldErrors] = useState<Record<string, boolean>>({});
  const [mcpServerNames, setMcpServerNames] = useState<string[]>([]);
  const [editingAgentPath, setEditingAgentPath] = useState<string | null>(null);
  const [editingAgentScope, setEditingAgentScope] = useState<"user" | "project">("user");
  const [editingAgentProjectPath, setEditingAgentProjectPath] = useState<string | null>(null);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<AgentDefLike | null>(null);
  const [deleteAgentError, setDeleteAgentError] = useState<string | null>(null);
  const [newAgentError, setNewAgentError] = useState<string | null>(null);
  const [overwriteTarget, setOverwriteTarget] = useState<{
    name: string;
    scope: "user" | "project";
  } | null>(null);
  const [inlineDraft, setInlineDraft] = useState<
    (api.AgentDefinitionFileInput & { kind: "role" | "persona"; isEditing: boolean; personaSource: string }) | null
  >(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [rolePromptError, setRolePromptError] = useState(false);
  const [personaInstructionsError, setPersonaInstructionsError] = useState(false);
  const [inlineContractError, setInlineContractError] = useState(false);
  const [personaContractText, setPersonaContractText] = useState({ inputs: "", outputs: "" });
  const [inlineDeleteTarget, setInlineDeleteTarget] = useState<{
    kind: "role" | "persona";
    name: string;
    scope: "user" | "project";
    projectPath: string | null;
  } | null>(null);
  const agentsProjectPath = useRef(projectPath);
  const agentsLoadSequence = useRef(0);
  const projectsLoadSequence = useRef(0);
  const selectedScopeProjectId = agentProjectIdForScope(agentsScopeSelection);
  const selectedScopeProjectPath = agentProjectPathForScope(savedProjects, agentsScopeSelection);
  const selectedScope = selectedScopeProjectPath ? "project" : "user";
  agentsProjectPath.current = selectedScopeProjectPath;

  const [sources, setSources] = useState<MarketplaceSourceLike[]>([]);
  const [available, setAvailable] = useState<AvailablePluginLike[]>([]);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketBusy, setMarketBusy] = useState<string | null>(null);
  const [addSource, setAddSource] = useState("");
  const [availQuery, setAvailQuery] = useState("");
  /** Default prefers openai/plugins when present (D8-A); set after load. */
  const [marketFilter, setMarketFilter] = useState<string>("__all__");
  const [ensureOpenaiError, setEnsureOpenaiError] = useState<string | null>(
    null,
  );
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  const [fromCache, setFromCache] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [removeSource, setRemoveSource] = useState<MarketplaceSourceLike | null>(
    null,
  );
  /** Catalog row opened in the detail drawer (rich panel, not install stub). */
  const [detailPlugin, setDetailPlugin] = useState<AvailablePluginLike | null>(
    null,
  );
  /** Confirm step after Install / Reinstall from detail or row. */
  const [installTarget, setInstallTarget] =
    useState<AvailablePluginLike | null>(null);
  /** Per-plugin last install/update error (row + detail Retry). */
  const [installErrors, setInstallErrors] = useState<
    Record<string, PluginMarketRowError>
  >({});

  const installedNameSet = useMemo(
    () => buildInstalledPluginNameSet(installedPlugins),
    [installedPlugins],
  );

  const isPluginInstalled = useCallback(
    (p: AvailablePluginLike) => {
      const detail = availablePluginDetailModel(p);
      if (detail.isInstalled) return true;
      return isCatalogPluginInstalled(p.name, installedNameSet);
    },
    [installedNameSet],
  );

  const badgeLabel = useCallback(
    (kind: PluginComponentBadgeKind, count?: number | null) => {
      const base = tr(BADGE_LABEL_KEY[kind]);
      if (kind === "skills" && typeof count === "number" && count > 0) {
        return tr("ext.market.badge.skillsCount", { n: String(count) });
      }
      return base;
    },
    [tr],
  );

  const detailModel: AvailablePluginDetailModel | null = useMemo(
    () => (detailPlugin ? availablePluginDetailModel(detailPlugin) : null),
    [detailPlugin],
  );

  const loadHooks = useCallback(async () => {
    if (!api.isTauri()) {
      setHooks([]);
      setHooksLoading(false);
      return;
    }
    setHooksLoading(true);
    setHooksError(null);
    try {
      const res = await api.hooksList(projectPath);
      const list = sortHooksByScopeName(
        (res.hooks ?? []).map(
          (h): HookLike => ({
            name: h.name,
            path: h.path,
            scope: h.scope,
            kind: h.kind,
            ext: h.ext,
            size: h.size ?? 0,
            mtimeMs: h.mtimeMs ?? 0,
          }),
        ),
      );
      setHooks(list);
    } catch (e) {
      setHooks([]);
      setHooksError(String(e));
    } finally {
      setHooksLoading(false);
    }
  }, [projectPath]);

  const loadAgents = useCallback(async () => {
    const requestedProjectPath = agentsProjectPath.current;
    const requestSequence = ++agentsLoadSequence.current;
    const isCurrentRequest = () =>
      isCurrentAgentCatalogRequest(
        requestSequence,
        agentsLoadSequence.current,
        requestedProjectPath,
        agentsProjectPath.current,
      );
    if (!api.isTauri()) {
      setAgents([]);
      setUserAgentsDir("");
      setRoles([]);
      setPersonas([]);
      setDiscoveryWarnings([]);
      setAgentsLoading(false);
      return;
    }
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const res = await api.agentsList(requestedProjectPath);
      if (!isCurrentRequest()) return;
      const list = sortAgentDefs(mapAgentDefinitions(res.agents ?? []));
      setAgents(list);
      setUserAgentsDir(res.userAgentsDir);
      setRoles(sortAgentDefs(res.roles ?? []));
      setPersonas(sortAgentDefs(res.personas ?? []));
      setDiscoveryWarnings(res.warnings ?? []);
    } catch (e) {
      if (!isCurrentRequest()) return;
      setAgents([]);
      setUserAgentsDir("");
      setRoles([]);
      setPersonas([]);
      setDiscoveryWarnings([]);
      setAgentsError(String(e));
    } finally {
      if (isCurrentRequest()) setAgentsLoading(false);
    }
  }, []);

  const loadSavedProjects = useCallback(async () => {
    if (!api.isTauri()) {
      setSavedProjects([]);
      return;
    }
    const request = ++projectsLoadSequence.current;
    try {
      const projects = await api.projectsList();
      if (request === projectsLoadSequence.current) setSavedProjects(projects);
    } catch {
      if (request === projectsLoadSequence.current) {
        setAgentsError(tr("ext.agents.error"));
      }
    }
  }, [tr]);

  useEffect(() => {
    if (!showAgents) {
      setSavedProjects([]);
      return;
    }
    void loadSavedProjects();
    return () => {
      projectsLoadSequence.current += 1;
    };
  }, [loadSavedProjects, projectPath, showAgents]);

  useEffect(() => {
    if (
      selectedScopeProjectId &&
      (!savedProjects.some((project) => project.id === selectedScopeProjectId) ||
        !agentProjectPathForScope(savedProjects, agentsScopeSelection))
    ) {
      setAgentsScopeSelection("global");
    }
  }, [agentsScopeSelection, savedProjects, selectedScopeProjectId]);

  useEffect(() => {
    if (!showAgents || !api.isTauri()) {
      setMcpServerNames([]);
      return;
    }
    let isCurrent = true;
    void api.inspectMcp(selectedScopeProjectPath).then((result) => {
      if (isCurrent) {
        if (result.error) setAgentsError(tr("ext.agents.error"));
        setMcpServerNames(
          [...new Set((result.servers ?? []).map((server) => server.name))].sort((a, b) => a.localeCompare(b)),
        );
      }
    }).catch(() => {
      if (isCurrent) {
        setMcpServerNames([]);
        setAgentsError(tr("ext.agents.error"));
      }
    });
    return () => {
      isCurrent = false;
    };
  }, [selectedScopeProjectPath, showAgents, tr]);

  const revealAgentPath = useCallback(
    async (path: string | null | undefined) => {
      const p = (path ?? "").trim();
      if (!p || !api.isTauri()) return;
      try {
        await api.pathReveal(p);
      } catch (e) {
        setAgentsError(String(e));
      }
    },
    [],
  );

  const openUserAgentsDirectory = useCallback(async () => {
    if (!api.isTauri()) return;
    setAgentsError(null);
    try {
      await api.agentsOpenUserDirectory(
        agentsView,
        selectedScope,
        selectedScopeProjectPath,
      );
    } catch {
      setAgentsError(tr("ext.agents.openUserError"));
    }
  }, [agentsView, selectedScope, selectedScopeProjectPath, tr]);

  const refreshAgentWorkspace = useCallback(() => {
    void Promise.all([loadAgents(), loadSavedProjects()]);
  }, [loadAgents, loadSavedProjects]);

  const openAgentFile = useCallback(async (path: string | null | undefined) => {
    const p = (path ?? "").trim();
    if (!p || !api.isTauri()) return;
    try {
      await api.openInEditor({ path: p });
    } catch (e) {
      // Fallback: reveal in folder when no editor is configured.
      try {
        await api.pathReveal(p);
      } catch (e2) {
        setAgentsError(String(e2 || e));
      }
    }
  }, []);

  const updateAgentFrontmatter = useCallback((field: string, value: unknown) => {
    setNewAgentFrontmatter((current) => ({ ...current, [field]: value }));
  }, []);

  const updateAgentJsonField = useCallback((field: string, text: string) => {
    setAgentJsonFieldText((current) => ({ ...current, [field]: text }));
    if (!text.trim()) {
      setNewAgentFrontmatter((current) => ({ ...current, [field]: undefined }));
      setAgentJsonFieldErrors((current) => ({ ...current, [field]: false }));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const isArrayField = field === "mcpServers";
      const isExpected = isArrayField
        ? Array.isArray(parsed)
        : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      if (!isExpected) {
        setAgentJsonFieldErrors((current) => ({ ...current, [field]: true }));
        return;
      }
      setNewAgentFrontmatter((current) => ({ ...current, [field]: parsed }));
      setAgentJsonFieldErrors((current) => ({ ...current, [field]: false }));
    } catch {
      setAgentJsonFieldErrors((current) => ({ ...current, [field]: true }));
    }
  }, []);

  const updatePersonaContract = useCallback((field: "inputs" | "outputs", text: string) => {
    setPersonaContractText((current) => ({ ...current, [field]: text }));
    if (!text.trim()) {
      setInlineDraft((draft) => draft ? { ...draft, [field]: undefined } : draft);
      setInlineContractError(false);
      return;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value)) {
        setInlineContractError(true);
        return;
      }
      setInlineDraft((draft) => draft ? { ...draft, [field]: value } : draft);
      setInlineContractError(false);
    } catch {
      setInlineContractError(true);
    }
  }, []);

  const openAgentDefinitionEditor = useCallback(async (agent: AgentDefLike) => {
    if (!agent.path || !api.isTauri()) return;
    const scope = agent.scope === "project" ? "project" : "user";
    const projectRoot = scope === "project" ? selectedScopeProjectPath : null;
    setAgentsBusy("agent-edit");
    setAgentsError(null);
    try {
      const result = await api.agentsReadMarkdownDefinition(agent.path, scope, projectRoot);
      const frontmatter = result.frontmatter;
      setNewAgentName(String(frontmatter.name ?? agent.name));
      setNewAgentDescription(String(frontmatter.description ?? agent.description ?? ""));
      setNewAgentInstructions(result.instructions);
      const currentPersona = personas.find(
        (persona) => persona.name.toLocaleLowerCase() === agent.name.toLocaleLowerCase(),
      );
      setNewAgentPersonaSource(
        currentPersona
          ? `${currentPersona.scope === "project" ? "project" : "user"}::${currentPersona.name}`
          : "",
      );
      setNewAgentFrontmatter(frontmatter);
      setAgentJsonFieldText(Object.fromEntries(
        AGENT_JSON_FRONTMATTER_FIELDS.map((field) => [
          field,
          jsonFieldText(frontmatter[field]),
        ]),
      ));
      setAgentJsonFieldErrors({});
      setEditingAgentPath(result.path);
      setEditingAgentScope(scope);
      setEditingAgentProjectPath(projectRoot);
      setNewAgentError(null);
      setNewAgentOpen(true);
    } catch {
      setAgentsError(tr("ext.agents.saveError"));
    } finally {
      setAgentsBusy(null);
    }
  }, [personas, selectedScopeProjectPath, tr]);

  const runScaffold = useCallback(
    async (opts: {
      name: string;
      scope: "user" | "project";
      projectPath?: string | null;
      path?: string | null;
      frontmatter?: Record<string, unknown>;
      personaSource?: string;
      personaTargetScope?: "user" | "project";
      personaProjectPath?: string | null;
      description: string;
      instructions: string;
      force?: boolean;
    }) => {
      if (!api.isTauri()) return;
      let stem: string;
      try {
        stem = sanitizeAgentFileStemName(opts.name);
      } catch {
        setNewAgentError(tr("ext.agents.nameInvalid"));
        return;
      }
      const scopeProjectPath = opts.scope === "project"
        ? opts.projectPath ?? selectedScopeProjectPath
        : null;
      if (opts.scope === "project" && !scopeProjectPath?.trim()) {
        setNewAgentError(tr("ext.agents.needProject"));
        return;
      }
      setAgentsBusy("scaffold");
      setNewAgentError(null);
      let definitionSaved = false;
      try {
        const res = await api.agentsCreateDefinition({
          name: stem,
          scope: opts.scope,
          description: opts.description,
          instructions: opts.instructions,
          projectPath: scopeProjectPath,
          force: opts.force ?? false,
          frontmatter: opts.frontmatter ?? newAgentFrontmatter,
          path: opts.path ?? null,
        });
        definitionSaved = true;
        if (!opts.path) {
          setEditingAgentPath(res.path);
          setEditingAgentScope(opts.scope);
          setEditingAgentProjectPath(scopeProjectPath);
        }
        const personaSource = parsePersonaSource(opts.personaSource ?? "");
        if (opts.path || personaSource) {
          const personaTargetScope = opts.personaTargetScope ?? opts.scope;
          const personaProjectPath = opts.personaProjectPath ?? scopeProjectPath;
          await api.agentsApplyPersona({
            targetAgentType: stem,
            targetScope: personaTargetScope,
            targetProjectPath: personaTargetScope === "project" ? personaProjectPath : null,
            personaAgentType: personaSource?.name ?? null,
            personaScope: personaSource?.scope ?? null,
            personaProjectPath: personaSource?.scope === "project" ? personaProjectPath : null,
          });
        }
        setNewAgentOpen(false);
        setOverwriteTarget(null);
        setNewAgentName("");
        setNewAgentDescription("");
        setNewAgentInstructions("");
        setNewAgentPersonaSource("");
        setEditingAgentPath(null);
        setEditingAgentProjectPath(null);
        const defaults = defaultAgentFrontmatter();
        setNewAgentFrontmatter(defaults);
        setAgentJsonFieldText(Object.fromEntries(
          AGENT_JSON_FRONTMATTER_FIELDS.map((field) => [
            field,
            jsonFieldText(defaults[field]),
          ]),
        ));
        setAgentJsonFieldErrors({});
        await loadAgents();
      } catch (e) {
        const msg = String(e || "");
        if (definitionSaved) {
          setNewAgentError(tr("ext.agents.personaLinkError"));
        } else if (/already exists/i.test(msg) && !opts.force) {
          setOverwriteTarget({ name: stem, scope: opts.scope });
          setNewAgentOpen(false);
          setNewAgentError(null);
        } else if (msg === "agent settings are read-only in shared mode") {
          setNewAgentError(tr("ext.agents.sharedReadOnly"));
        } else if (/agent name|invalid agent name|reserved agent|path separators|agent name too long/i.test(msg)) {
          setNewAgentError(tr("ext.agents.nameInvalid"));
        } else {
          setNewAgentError(tr("ext.agents.createError"));
        }
      } finally {
        setAgentsBusy(null);
      }
    },
    [loadAgents, newAgentFrontmatter, selectedScopeProjectPath, tr],
  );

  const submitNewAgent = useCallback(() => {
    void runScaffold({
      name: newAgentName,
      scope: editingAgentPath ? editingAgentScope : selectedScope,
      projectPath: editingAgentPath ? editingAgentProjectPath : selectedScopeProjectPath,
      path: editingAgentPath,
      frontmatter: {
        ...newAgentFrontmatter,
        name: newAgentName,
        description: newAgentDescription,
      },
      personaSource: newAgentPersonaSource,
      personaTargetScope: selectedScope,
      personaProjectPath: selectedScopeProjectPath,
      description: newAgentDescription,
      instructions: newAgentInstructions,
      force: false,
    });
  }, [editingAgentPath, editingAgentProjectPath, editingAgentScope, newAgentDescription, newAgentFrontmatter, newAgentInstructions, newAgentName, newAgentPersonaSource, runScaffold, selectedScope, selectedScopeProjectPath]);

  const openInlineEditor = useCallback(
    (kind: "role" | "persona", entry?: api.AgentDefinitionDto) => {
      setAgentsError(null);
      setInlineError(null);
      setRolePromptError(false);
      setPersonaInstructionsError(false);
      setInlineContractError(false);
      const scope = entry
        ? entry.scope === "project" ? "project" : "user"
        : selectedScope;
      const existingPersona = kind === "role" && entry
        ? personas.find((persona) => persona.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())
        : undefined;
      const inputs = entry?.inputs;
      const outputs = entry?.outputs;
      setPersonaContractText({
        inputs: inputs === undefined ? "" : JSON.stringify(inputs, null, 2),
        outputs: outputs === undefined ? "" : JSON.stringify(outputs, null, 2),
      });
      setInlineDraft({
        kind,
        isEditing: !!entry,
        personaSource: existingPersona
          ? `${existingPersona.scope === "project" ? "project" : "user"}::${existingPersona.name}`
          : "",
        name: entry?.name ?? "",
        scope,
        projectPath: scope === "project" ? selectedScopeProjectPath : null,
        description: entry?.description ?? "",
        instructions: entry?.instructions ?? "",
        instructionsFile: entry?.instructionsFile ?? null,
        inputs,
        outputs,
        defaultCapabilityMode: entry?.defaultCapabilityMode ?? "",
        model: entry?.model ?? "",
        promptFile: entry?.promptFile ?? "",
        prompt: entry?.prompt ?? null,
        reasoningEffort: entry?.reasoningEffort ?? "",
        defaultIsolation: entry?.defaultIsolation ?? "",
      });
    },
    [personas, selectedScope, selectedScopeProjectPath],
  );

  const saveInlineDefinition = useCallback(async () => {
    if (!inlineDraft || !api.isTauri()) return;
    if (
      inlineDraft.kind === "role" &&
      !inlineDraft.prompt?.trim()
    ) {
      setRolePromptError(true);
      return;
    }
    if (
      inlineDraft.kind === "persona" &&
      !inlineDraft.instructions?.trim()
    ) {
      setPersonaInstructionsError(true);
      return;
    }
    if (inlineContractError) return;
    setRolePromptError(false);
    setPersonaInstructionsError(false);
    setAgentsBusy("inline");
    setAgentsError(null);
    setInlineError(null);
    let definitionSaved = false;
    try {
      const { isEditing, personaSource, ...input } = inlineDraft;
      await api.agentsUpsertFileDefinition(input);
      definitionSaved = true;
      if (inlineDraft.kind === "role" && (isEditing || parsePersonaSource(personaSource))) {
        const source = parsePersonaSource(personaSource);
        // 工具栏 scope 决定 Persona 关联写入目标；定义文件仍按草稿原 scope 保存。
        await api.agentsApplyPersona({
          targetAgentType: inlineDraft.name.trim(),
          targetScope: selectedScope,
          targetProjectPath: selectedScopeProjectPath,
          personaAgentType: source?.name ?? null,
          personaScope: source?.scope ?? null,
          personaProjectPath: source?.scope === "project" ? selectedScopeProjectPath : null,
        });
      }
      setInlineDraft(null);
      setRolePromptError(false);
      setPersonaInstructionsError(false);
      setInlineContractError(false);
      await loadAgents();
    } catch (error) {
      setInlineError(tr(definitionSaved ? "ext.agents.personaLinkError" : "ext.agents.saveError"));
    } finally {
      setAgentsBusy(null);
    }
  }, [inlineContractError, inlineDraft, loadAgents, selectedScope, selectedScopeProjectPath, tr]);

  const deleteInlineDefinition = useCallback(async () => {
    if (!inlineDeleteTarget || !api.isTauri()) return;
    setAgentsBusy("inline");
    setAgentsError(null);
    setInlineError(null);
    try {
      await api.agentsDeleteFileDefinition(
        inlineDeleteTarget.kind,
        inlineDeleteTarget.name,
        inlineDeleteTarget.scope,
        inlineDeleteTarget.projectPath,
      );
      setInlineDeleteTarget(null);
      await loadAgents();
    } catch (error) {
      setInlineError(tr("ext.agents.saveError"));
    } finally {
      setAgentsBusy(null);
    }
  }, [inlineDeleteTarget, loadAgents, tr]);

  const deleteAgentDefinition = useCallback(async () => {
    if (!deleteAgentTarget?.path || !api.isTauri()) return;
    const scope = deleteAgentTarget.scope === "project" ? "project" : "user";
    const projectRoot = scope === "project" ? selectedScopeProjectPath : null;
    setAgentsBusy("agent-delete");
    setDeleteAgentError(null);
    try {
      await api.agentsDeleteMarkdownDefinition(deleteAgentTarget.path, scope, projectRoot);
      setDeleteAgentTarget(null);
      await loadAgents();
    } catch {
      setDeleteAgentError(tr("ext.agents.saveError"));
    } finally {
      setAgentsBusy(null);
    }
  }, [deleteAgentTarget, loadAgents, selectedScopeProjectPath, tr]);

  const setDefaultAgent = useCallback(
    async (agent: AgentDefLike) => {
      if (!agent.path || !api.isTauri()) return;
      setAgentsBusy("default");
      setAgentsError(null);
      try {
        await api.agentsSetDefaultDefinition(agent.path, selectedScopeProjectPath);
        await loadAgents();
      } catch (error) {
        setAgentsError(tr("ext.agents.saveError"));
      } finally {
        setAgentsBusy(null);
      }
    },
    [loadAgents, selectedScopeProjectPath, tr],
  );

  const loadMarket = useCallback(async (force = false) => {
    // Soft-fail: no CLI / non-desktop — never hard-crash the marketplace tab.
    if (!api.isTauri() || cliMissing) {
      setSources([]);
      setAvailable([]);
      setMarketLoading(false);
      setMarketError(null);
      setFromCache(false);
      return;
    }
    setMarketLoading(true);
    setMarketError(null);
    try {
      // Default sources: xAI + openai; remove Claude sources (soft-fail).
      const ensure = await ensureDefaultMarketplaces({
        list: async () => {
          const r = await api.marketplaceList();
          return (r.sources ?? [])
            .map((row) => asSource(row as Record<string, unknown>))
            .filter((x): x is MarketplaceSourceLike => !!x)
            .map((s) => ({
              name: s.name,
              url: s.url,
              path: s.path,
              kind: s.kind,
            }));
        },
        add: async (url) => {
          await api.marketplaceAdd(url);
        },
        remove: async (nameOrUrl) => {
          await api.marketplaceRemove(nameOrUrl);
        },
        removeClaude: true,
      });
      const ensureErr =
        ensure.errors.length > 0 ? ensure.errors.join("; ") : null;
      setEnsureOpenaiError(ensureErr);
      onEnsureOpenaiError?.(ensureErr);
      if (ensure.added.length || ensure.removed.length || force) {
        invalidateMarketplaceCatalogCache();
      }

      const result = await loadMarketplaceCatalog(async () => {
        const [srcRes, availRes] = await Promise.all([
          api.marketplaceList(),
          api.marketplaceAvailable(),
        ]);
        const err =
          srcRes.error?.trim() || availRes.error?.trim() || null;
        const src = sortMarketplaceSourcesByName(
          (srcRes.sources ?? [])
            .map((r) => asSource(r as Record<string, unknown>))
            .filter((x): x is MarketplaceSourceLike => !!x)
            // Keep only default-allowed sources in the UI list.
            .filter(
              (s) =>
                isDefaultAllowedMarketplaceSource(s) ||
                !isClaudeMarketplaceSource(s),
            )
            .filter((s) => !isClaudeMarketplaceSource(s)),
        );
        let avail = sortAvailablePluginsByName(
          filterAvailablePlugins(
            (availRes.plugins ?? [])
              .map((r) => asAvailable(r as Record<string, unknown>))
              .filter((x): x is AvailablePluginLike => !!x),
          ),
        );
        avail = filterCatalogToDefaultSources(avail, src);
        return { sources: src, available: avail, error: err };
      }, { force: force || ensure.added.length > 0 || ensure.removed.length > 0 });

      setSources(result.sources.filter((s) => !isClaudeMarketplaceSource(s)));
      setAvailable(
        filterCatalogToDefaultSources(result.available, result.sources),
      );
      setFromCache(result.fromCache);
      // Soft-fail capability gaps are presented via empty-state, not only a banner.
      if (result.error) setMarketError(result.error);

      // Prefer openai/plugins when present; keep user chip if still valid.
      setMarketFilter((prev) => {
        if (prev && prev !== "__all__" && result.sources.some((s) => s.name === prev)) {
          return prev;
        }
        return pickDefaultInstallableFilter(result.sources);
      });
    } catch (e) {
      setSources([]);
      setAvailable([]);
      setMarketError(String(e));
    } finally {
      setMarketLoading(false);
    }
  }, [cliMissing, onEnsureOpenaiError]);

  useEffect(() => {
    if (showHooks) void loadHooks();
  }, [loadHooks, showHooks]);

  useEffect(() => {
    if (showMarket) void loadMarket(false);
  }, [loadMarket, showMarket]);

  useEffect(() => {
    if (showAgents) void loadAgents();
  }, [loadAgents, selectedScopeProjectPath, showAgents]);

  const marketChips = useMemo(() => {
    const chips: { id: string; label: string }[] = [];
    const openai = findOpenaiPluginsSource(sources);
    if (openai?.name) {
      chips.push({
        id: openai.name,
        label: openai.name,
      });
    }
    chips.push({ id: "__all__", label: tr("ext.market.filterAll") });
    const seen = new Set(chips.map((c) => c.id));
    for (const s of sources) {
      if (!s.name || seen.has(s.name)) continue;
      seen.add(s.name);
      chips.push({ id: s.name, label: s.name });
    }
    // Prefer xAI chip label when it is the official catalog
    return chips.map((c) =>
      isXaiOfficialMarketplace(c.id)
        ? { ...c, label: tr("ext.market.filterOfficial") }
        : c,
    );
  }, [sources, tr]);

  const filteredByMarket = useMemo(
    () => filterAvailableByMarketplace(available, marketFilter),
    [available, marketFilter],
  );

  const filteredAvailable = useMemo(() => {
    return filterPluginsByQuery(filteredByMarket, availQuery);
  }, [filteredByMarket, availQuery]);

  const visibleAvailable = useMemo(
    () => filteredAvailable.slice(0, pageLimit),
    [filteredAvailable, pageLimit],
  );

  const hasMore = filteredAvailable.length > visibleAvailable.length;

  /** Honest catalog empty / soft-fail presentation (null when rows visible). */
  const catalogEmpty = useMemo(
    () =>
      resolvePluginCatalogEmptyState({
        loading: marketLoading,
        cliFound,
        error: marketError,
        sourceCount: sources.length,
        availableCount: available.length,
        visibleCount: visibleAvailable.length,
        marketFilter,
        query: availQuery,
      }),
    [
      marketLoading,
      cliFound,
      marketError,
      sources.length,
      available.length,
      visibleAvailable.length,
      marketFilter,
      availQuery,
    ],
  );

  /** Classified load error for optional banner (suppress when empty-state owns it). */
  const marketLoadView = useMemo(() => {
    if (!marketError?.trim()) return null;
    return buildPluginMarketErrorView(marketError, "list");
  }, [marketError]);

  /**
   * Show a top banner only when:
   * - empty-state does not already own the same soft/hard story, or
   * - we have visible rows but a soft residual error (e.g. partial cache).
   */
  const showMarketErrorBanner = useMemo(() => {
    if (!marketLoadView) return false;
    if (catalogEmpty) {
      // Empty-state already explains cli/offline/error — skip duplicate hard banner
      // unless the empty kind is filter/query (load succeeded).
      if (
        catalogEmpty.kind === "empty_filter" ||
        catalogEmpty.kind === "empty_query" ||
        catalogEmpty.kind === "empty_catalog" ||
        catalogEmpty.kind === "no_sources" ||
        catalogEmpty.kind === "loading"
      ) {
        // Residual load error with an otherwise empty-but-ok catalog shape.
        return !catalogEmpty.softFail && !!marketError;
      }
      return false;
    }
    return true;
  }, [marketLoadView, catalogEmpty, marketError]);

  useEffect(() => {
    setPageLimit(PAGE_SIZE);
  }, [marketFilter, availQuery]);

  const openHooksDir = async (
    scope: "user" | "project",
    create: boolean,
  ) => {
    if (scope === "project" && !projectPath?.trim()) return;
    setHooksBusy(scope === "user" ? "open-user" : "open-project");
    try {
      await api.hooksOpenDir({
        scope,
        projectPath,
        create,
      });
      await loadHooks();
    } catch (e) {
      setHooksError(String(e));
    } finally {
      setHooksBusy(null);
    }
  };

  const revealHook = async (path: string) => {
    setHooksBusy(`reveal:${path}`);
    try {
      await api.hooksReveal(path);
    } catch (e) {
      setHooksError(String(e));
    } finally {
      setHooksBusy(null);
    }
  };

  const addMarketplace = async () => {
    let source: string;
    try {
      source = normalizeMarketplaceAddSource(addSource);
    } catch {
      setMarketError(tr("ext.market.addEmpty"));
      return;
    }
    setMarketBusy("add");
    setMarketError(null);
    try {
      const res = await api.marketplaceAdd(source);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        setMarketError(res.error?.trim() || tr("ext.market.error"));
        return;
      }
      setAddSource("");
      invalidateMarketplaceCatalogCache();
      await loadMarket(true);
    } catch (e) {
      setMarketError(String(e));
    } finally {
      setMarketBusy(null);
    }
  };

  const confirmRemoveSource = async () => {
    if (!removeSource) return;
    const target = marketplaceRemoveTarget(removeSource) || removeSource.name;
    setMarketBusy(`rm:${removeSource.name}`);
    setMarketError(null);
    try {
      const res = await api.marketplaceRemove(target);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        setMarketError(res.error?.trim() || tr("ext.market.error"));
        return;
      }
      setRemoveSource(null);
      invalidateMarketplaceCatalogCache();
      await loadMarket(true);
    } catch (e) {
      setMarketError(String(e));
    } finally {
      setMarketBusy(null);
    }
  };

  const refreshSources = async (name?: string | null) => {
    setMarketBusy(name ? `up:${name}` : "up:all");
    setMarketError(null);
    try {
      const res = await api.marketplaceUpdate(name ?? null);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        setMarketError(res.error?.trim() || tr("ext.market.error"));
        return;
      }
      invalidateMarketplaceCatalogCache();
      await loadMarket(true);
    } catch (e) {
      setMarketError(String(e));
    } finally {
      setMarketBusy(null);
    }
  };

  const runInstall = async (
    target: AvailablePluginLike,
    opts?: { closeConfirm?: boolean },
  ) => {
    const rowKey = availablePluginRowKey(target);
    const source = marketplaceQualifiedInstallSource(
      target.name,
      target.marketplace,
    );
    setMarketBusy(`inst:${rowKey}`);
    // Install failures stick to the row — do not escalate soft CLI gaps to a hard global banner.
    setMarketError(null);
    try {
      const res = await api.pluginInstall(source);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        const err =
          (res as { error?: string; message?: string; reason?: string })
            .error?.trim() ||
          (res as { message?: string }).message?.trim() ||
          (res as { reason?: string }).reason?.trim() ||
          tr("ext.market.error");
        setInstallErrors((prev) =>
          setPluginMarketRowError(prev, rowKey, err, "install"),
        );
        if (opts?.closeConfirm !== false) setInstallTarget(null);
        return;
      }
      setInstallErrors((prev) => clearPluginMarketRowError(prev, rowKey));
      removeAvailablePluginFromCache(target.name, target.marketplace);
      setAvailable((prev) =>
        prev.filter(
          (p) =>
            !(
              p.name === target.name &&
              (p.marketplace ?? "") === (target.marketplace ?? "")
            ),
        ),
      );
      setInstallTarget(null);
      setDetailPlugin(null);
      onPluginsChanged?.();
    } catch (e) {
      setInstallErrors((prev) =>
        setPluginMarketRowError(prev, rowKey, e, "install"),
      );
      if (opts?.closeConfirm !== false) setInstallTarget(null);
    } finally {
      setMarketBusy(null);
    }
  };

  const clearCatalogFilters = () => {
    setAvailQuery("");
    setMarketFilter("__all__");
  };

  const runEmptyRetry = (action: ReturnType<typeof planPluginMarketEmptyRetry>["action"]) => {
    if (action === "retry_load" || action === "refresh_catalog") {
      void loadMarket(true);
      return;
    }
    if (action === "clear_filter") {
      clearCatalogFilters();
      return;
    }
    if (action === "open_runtime" || action === "update_cli") {
      onOpenRuntime?.();
    }
  };

  const rowErrorLabel = (row: PluginMarketRowError): string => {
    const title = tr(pluginMarketErrorTitleKey(row.kind) as MessageKey);
    return formatPluginMarketRowErrorMessage(row, {
      title,
      includeDetail: row.kind === "other" || row.kind === "host_error",
    });
  };

  const rowRetryLabel = (row: PluginMarketRowError): string => {
    const plan = planPluginMarketRetry(row.kind, "install");
    if (plan.action === "open_runtime") return tr("ext.error.openRuntime");
    if (plan.action === "update_cli") return tr("ext.market.openRuntimeCli");
    if (plan.action === "retry_install" && row.kind === "already_installed") {
      return tr("ext.market.reinstall");
    }
    return tr("ext.market.retry");
  };

  const runRowRetry = (target: AvailablePluginLike, row: PluginMarketRowError) => {
    const plan = planPluginMarketRetry(row.kind, "install");
    if (plan.action === "open_runtime" || plan.action === "update_cli") {
      onOpenRuntime?.();
      return;
    }
    if (plan.canRetry) {
      void retryInstall(target);
    }
  };

  const confirmInstall = async () => {
    if (!installTarget) return;
    await runInstall(installTarget);
  };

  const retryInstall = async (target: AvailablePluginLike) => {
    await runInstall(target, { closeConfirm: true });
  };

  const openDetail = (p: AvailablePluginLike) => {
    setDetailPlugin(p);
  };

  const requestInstall = (p: AvailablePluginLike) => {
    setInstallTarget(p);
  };

  const scopeLabel = (scope: string) => {
    if (scope === "config") return tr("ext.agents.source.config");
    if (scope === "project") return tr("ext.agents.scope.project");
    if (scope === "bundled" || scope === "builtin") {
      return tr("ext.agents.scope.bundled");
    }
    return tr("ext.agents.scope.user");
  };

  const warningMessage = (code: api.AgentDiscoveryWarningDto["code"]) => {
    switch (code) {
      case "directoryRead":
        return tr("ext.agents.warning.directoryRead");
      case "directoryTruncated":
        return tr("ext.agents.warning.directoryTruncated");
      case "definitionRead":
        return tr("ext.agents.warning.definitionRead");
      case "configRead":
        return tr("ext.agents.warning.configRead");
      case "agentDefinitionInvalid":
        return tr("ext.agents.warning.agentDefinitionInvalid");
    }
  };

  const agentNamePreview = useMemo(() => {
    try {
      return sanitizeAgentFileStemName(newAgentName);
    } catch {
      return "";
    }
  }, [newAgentName]);

  const canSubmitNewAgent =
    canManageAgentWorkspace(sessionDataMode) &&
    isValidAgentFileStemName(newAgentName) &&
    !!newAgentDescription.trim() &&
    !!newAgentInstructions.trim() &&
    (selectedScope !== "project" || !!selectedScopeProjectPath?.trim()) &&
    !Object.values(agentJsonFieldErrors).some(Boolean) &&
    agentsBusy !== "scaffold";
  const canSaveInlineDefinition =
    !!inlineDraft &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(inlineDraft.name.trim()) &&
    !inlineContractError &&
    !agentsBusy;
  const agentScopeOptions = useMemo(
    () => agentProjectScopeOptions(savedProjects, tr("ext.agents.scope.user")),
    [savedProjects, tr],
  );
  const agentTypeOptions = useMemo(() => {
    const definitions = [...agents, ...roles].filter(
      (entry) =>
        (entry.scope === "user" || entry.scope === "project") && !!entry.path,
    );
    return [...new Set(definitions.map((entry) => entry.name))]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ value: name, label: name }));
  }, [agents, roles]);
  const personaOptions = useMemo(
    () => [
      { value: "", label: tr("ext.agents.unset") },
      ...reusablePersonaDefinitions(personas).map((persona) => {
        const scope = persona.scope === "project" ? "project" : "user";
        const scopeLabel = scope === "project"
          ? tr("ext.agents.scope.project")
          : tr("ext.agents.scope.user");
        return {
          value: `${scope}::${persona.name}`,
          label: `${persona.name} · ${scopeLabel}`,
        };
      }),
    ],
    [personas, tr],
  );

  const openNewAgentDialog = useCallback(() => {
    setNewAgentError(null);
    setNewAgentName("");
    setNewAgentDescription("");
    setNewAgentInstructions("");
    setNewAgentPersonaSource("");
    setEditingAgentPath(null);
    setEditingAgentProjectPath(null);
    setEditingAgentScope(selectedScope);
    const defaults = defaultAgentFrontmatter();
    setNewAgentFrontmatter(defaults);
    setAgentJsonFieldText(Object.fromEntries(
      AGENT_JSON_FRONTMATTER_FIELDS.map((field) => [
        field,
        jsonFieldText(defaults[field]),
      ]),
    ));
    setAgentJsonFieldErrors({});
    setNewAgentOpen(true);
  }, [selectedScope]);

  useEffect(() => {
    if (!showAgents || !onTabActionsChange) return;
    onTabActionsChange({
      refresh: () => {
        refreshAgentWorkspace();
      },
      busy: !!agentsBusy,
      loading: agentsLoading,
    });
    return () => onTabActionsChange(null);
  }, [
    showAgents,
    onTabActionsChange,
    refreshAgentWorkspace,
    agentsBusy,
    agentsLoading,
  ]);

  const agentsByScope = useMemo(() => {
    const groups: {
      key: "config" | "project" | "user" | "bundled";
      label: string;
      items: AgentDefLike[];
    }[] = [
      {
        key: "config",
        label: tr("ext.agents.source.config"),
        items: [],
      },
      {
        key: "project",
        label: tr("ext.agents.scope.project"),
        items: [],
      },
      {
        key: "user",
        label: tr("ext.agents.scope.user"),
        items: [],
      },
      {
        key: "bundled",
        label: tr("ext.agents.group.bundled"),
        items: [],
      },
    ];
    for (const a of agents) {
      const g = groups.find((group) => group.key === a.scope) ?? groups[2];
      g.items.push(a);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [agents, tr]);

  const currentViewWarnings = discoveryWarnings;

  const renderAgentRow = (a: AgentDefLike) => {
    const tone = agentScopeTone(a.scope);
    const editable = a.path && a.scope !== "bundled";
    const manageable = canManageAgentWorkspace(sessionDataMode) &&
      (a.scope === "user" || a.scope === "project") && !!a.path;
    return (
      <li
        key={`${a.scope}:${a.name}:${a.path}`}
        className="ext-ref-row ext-ref-row--dense"
      >
        <div className="ext-ref-row__main">
          <div className="ext-ref-row__icon" aria-hidden>
            <IconRobot size={14} />
          </div>
          <div className="ext-ref-row__body">
            <div className="ext-ref-row__title">{a.name}</div>
            <div className="ext-ref-row__desc">
              {a.description?.trim() ||
                agentMetaLine({ scope: a.scope, description: null }) ||
                "—"}
            </div>
            <div className="ext-ref-row__meta">
              <span className={`ext-ref-badge ext-badge--${tone}`}>
                {scopeLabel(a.scope)}
              </span>
            {a.isDefault ? (
                <span className="ext-ref-badge ext-badge--muted">
                  {tr("ext.agents.defaultDefinition")}
                </span>
              ) : null}
              {a.path ? (
                <span className="ext-ref-block__meta" title={a.path}>
                  {shortPathLabel(a.path, 36)}
                </span>
              ) : null}
            </div>
          </div>
          <div className="ext-ref-row__end">
            {canManageAgentWorkspace(sessionDataMode) &&
            (a.scope === "user" || a.scope === "project") &&
            a.path &&
            !a.isDefault ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!agentsBusy}
                onClick={() => void setDefaultAgent(a)}
              >
                {tr("ext.agents.setDefault")}
              </button>
            ) : null}
            {manageable ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!!agentsBusy}
                  onClick={() => void openAgentDefinitionEditor(a)}
                >
                  {tr("ext.agents.edit")}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!!agentsBusy}
                  aria-label={tr("ext.agents.delete", { name: a.name })}
                  onClick={() => {
                    setDeleteAgentError(null);
                    setDeleteAgentTarget(a);
                  }}
                >
                  <IconTrash size={13} />
                </button>
              </>
            ) : null}
            {editable ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!agentsBusy}
                onClick={() => void openAgentFile(a.path)}
              >
                <IconExternalLink size={13} />
                <span>{tr("ext.agents.open")}</span>
              </button>
            ) : null}
            {a.path && a.scope !== "config" ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!agentsBusy}
                title={a.path}
                onClick={() => void revealAgentPath(a.path)}
              >
                <IconFolder size={13} />
                <span>{tr("ext.agents.reveal")}</span>
              </button>
            ) : null}
          </div>
        </div>
      </li>
    );
  };

  return (
    <>
      {/* ── Agents ── */}
      {showAgents ? (
        <>
          <div
            className="ext-ref-stack"
            id="settings-anchor-ext-agents"
            data-testid="ext-agents-panel"
          >
            {!hidePageToolbar ? (
          <div className="ext-ref-block__head ext-ref-toolbar">
            <span className="ext-ref-block__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!!agentsBusy}
                    onClick={refreshAgentWorkspace}
                  >
                    <IconRefresh size={14} />
                    <span>
                      {agentsBusy === "scaffold"
                        ? tr("ext.agents.creating")
                        : tr("ext.refresh")}
                    </span>
                  </button>
                </span>
              </div>
            ) : null}

            <div className="ext-agents__header">
              <div
                className="ext-ref-tabs"
                role="tablist"
                aria-label={tr("ext.agents.workspace")}
              >
                <div className="ext-ref-tabs__list">
                  {(["agents", "roles", "personas"] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      role="tab"
                      aria-selected={agentsView === view}
                      className={`ext-ref-tabs__tab${agentsView === view ? " is-on" : ""}`}
                      onClick={() => setAgentsView(view)}
                    >
                      {tr(`ext.agents.view.${view}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ext-ref-tabs__trail ext-agents__tabs-trail">
                <div className="ext-ref-tabs__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!!agentsBusy}
                    title={agentsView === "agents" ? userAgentsDir || undefined : undefined}
                    onClick={() => void openUserAgentsDirectory()}
                  >
                    <IconFolder size={13} />
                    <span>{tr(selectedScope === "project" ? "ext.agents.openProject" : "ext.agents.openUser")}</span>
                  </button>
                  <Select
                    value={agentsScopeSelection}
                    options={agentScopeOptions}
                    onChange={setAgentsScopeSelection}
                    aria-label={tr("ext.agents.scope")}
                    disabled={!!agentsBusy || agentScopeOptions.length <= 1}
                  />
                  {canManageAgentWorkspace(sessionDataMode) && agentsView === "agents" ? (
                    <button
                      type="button"
                      className="btn btn--solid btn--sm"
                      disabled={!!agentsBusy}
                      onClick={openNewAgentDialog}
                    >
                      <IconPlus size={13} />
                      <span>{tr("ext.agents.new")}</span>
                    </button>
                  ) : null}
                  {canManageAgentWorkspace(sessionDataMode) && agentsView !== "agents" ? (
                    <button
                      type="button"
                      className="btn btn--solid btn--sm"
                      disabled={!!agentsBusy || (agentsView === "personas" && agentTypeOptions.length === 0)}
                      onClick={() => openInlineEditor(agentsView === "roles" ? "role" : "persona")}
                    >
                      <IconPlus size={13} />
                      <span>{tr("ext.agents.newDefinition", { kind: tr(`ext.agents.view.${agentsView}`) })}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            {sessionDataMode === "shared" ? (
              <p className="ext-ref-block__lead">
                {tr("ext.agents.sharedReadOnly")}
              </p>
            ) : null}

            {agentsError ? (
              <div className="ext-alert ext-alert--error" role="alert">
                <div className="ext-alert__title">{tr("ext.agents.error")}</div>
                <p className="ext-alert__body">{agentsError}</p>
              </div>
            ) : null}
            {agentsLoading ? (
              <p className="ext-ref-empty">{tr("ext.agents.loading")}</p>
            ) : agentsView === "agents" && agents.length === 0 ? (
              <p className="ext-ref-empty">{tr("ext.agents.empty")}</p>
            ) : agentsView === "agents" ? (
              agentsByScope.map((group) => (
                <section key={group.key} className="ext-ref-block">
                  <div className="ext-ref-section-label">
                    {group.label}
                    <span className="ext-ref-cat-group__count">
                      {group.items.length}
                    </span>
                  </div>
                  <ul className="ext-ref-list">
                    {group.items.map(renderAgentRow)}
                  </ul>
                </section>
              ))
            ) : (() => {
              const entries = agentsView === "roles" ? roles : personas;
              if (!entries.length) {
                return (
                  <p className="ext-ref-empty">
                    {tr("ext.agents.emptyView", {
                      view: tr(`ext.agents.view.${agentsView}`),
                    })}
                  </p>
                );
              }
              return (
                <ul className="ext-ref-list">
                  {entries.map((entry) => (
                    <li
                      key={`${entry.scope}:${entry.name}:${entry.path}`}
                      className="ext-ref-row ext-ref-row--dense"
                    >
                      <div className="ext-ref-row__main">
                        <div className="ext-ref-row__icon" aria-hidden>
                          <IconRobot size={14} />
                        </div>
                        <div className="ext-ref-row__body">
                          <div className="ext-ref-row__title">{entry.name}</div>
                          {entry.description ? (
                            <div className="ext-ref-row__desc">
                              {entry.description}
                            </div>
                          ) : null}
                          <div className="ext-ref-row__meta">
                            <span
                              className={`ext-ref-badge ext-badge--${agentScopeTone(entry.scope)}`}
                            >
                              {scopeLabel(entry.scope)}
                            </span>
                            <span
                              className="ext-ref-block__meta"
                              title={entry.path}
                            >
                              {shortPathLabel(entry.path, 48)}
                            </span>
                          </div>
                        </div>
                        <div className="ext-ref-row__end">
                          {canManageAgentWorkspace(sessionDataMode) && (entry.scope === "user" || entry.scope === "project") ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                disabled={!!agentsBusy}
                                onClick={() => openInlineEditor(agentsView === "roles" ? "role" : "persona", entry)}
                              >
                                {tr("ext.agents.edit")}
                              </button>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                disabled={!!agentsBusy}
                                aria-label={tr("ext.agents.delete", { name: entry.name })}
                                onClick={() => setInlineDeleteTarget({
                                  kind: agentsView === "roles" ? "role" : "persona",
                                  name: entry.name,
                                  scope: entry.scope === "project" ? "project" : "user",
                                  projectPath: entry.scope === "project" ? selectedScopeProjectPath : null,
                                })}
                              >
                                <IconTrash size={13} />
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={!!agentsBusy}
                            onClick={() => void openAgentFile(entry.path)}
                          >
                            <IconExternalLink size={13} />
                            <span>{tr("ext.agents.open")}</span>
                          </button>
                          {entry.scope !== "config" ? (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={!!agentsBusy}
                              title={entry.path}
                              onClick={() => void revealAgentPath(entry.path)}
                            >
                              <IconFolder size={13} />
                              <span>{tr("ext.agents.reveal")}</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              );
            })()}
            {currentViewWarnings.length ? (
              <section
                className="ext-ref-block"
                aria-label={tr("ext.agents.warnings")}
              >
                <div className="ext-ref-section-label">
                  {tr("ext.agents.warnings")}
                </div>
                <ul className="ext-ref-list">
                  {currentViewWarnings.map((warning, index) => (
                    <li
                      key={`${warning.source}:${warning.path}:${index}`}
                      className="ext-ref-row ext-ref-row--dense"
                    >
                      <div className="ext-ref-row__main">
                        <div className="ext-ref-row__body">
                          <div className="ext-ref-row__title">
                            {scopeLabel(warning.source)}
                          </div>
                          <div className="ext-ref-row__desc">
                            {warningMessage(warning.code)}
                          </div>
                          <div className="ext-ref-row__meta">
                            <span
                              className="ext-ref-block__meta"
                              title={warning.path}
                            >
                              {shortPathLabel(warning.path, 48)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <GlassModal
            open={newAgentOpen}
            onClose={() => {
              if (!agentsBusy) setNewAgentOpen(false);
            }}
            title={tr(editingAgentPath ? "ext.agents.editTitle" : "ext.agents.newTitle", {
              kind: tr("ext.agents.view.agents"),
            })}
            size="md"
            closeLabel={tr("common.close")}
            wrapBody
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!!agentsBusy}
                  onClick={() => {
                    setNewAgentOpen(false);
                    setEditingAgentPath(null);
                  }}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--solid"
                  disabled={!canSubmitNewAgent}
                  onClick={() => submitNewAgent()}
                >
                  {agentsBusy === "scaffold"
                    ? tr("ext.agents.creating")
                    : tr(editingAgentPath ? "common.save" : "ext.agents.create")}
                </button>
              </>
            }
          >
            <form
              className="app-dialog__form"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSubmitNewAgent) submitNewAgent();
              }}
            >
              <p className="ext-field-hint">{tr("ext.agents.newHint")}</p>
              <label className="field">
                <span>{tr("ext.agents.name")}</span>
                <input
                  className="app-dialog__input"
                  value={newAgentName}
                  onChange={(e) => {
                    setNewAgentName(e.target.value);
                    setNewAgentFrontmatter((frontmatter) => ({ ...frontmatter, name: e.target.value }));
                    setNewAgentError(null);
                  }}
                  placeholder={tr("ext.agents.namePlaceholder")}
                  autoComplete="off"
                  maxLength={64}
                  spellCheck={false}
                  disabled={!!agentsBusy || !!editingAgentPath}
                  autoFocus
                />
                {agentNamePreview && agentNamePreview !== newAgentName.trim() ? (
                  <span className="ext-field-hint">
                    {tr("ext.agents.namePreview", { name: agentNamePreview })}
                  </span>
                ) : newAgentName.length > 0 && !isValidAgentFileStemName(newAgentName) ? (
                  <span className="ext-field-hint">{tr("ext.agents.nameInvalid")}</span>
                ) : null}
              </label>
              <label className="field">
                <span>{tr("ext.agents.description")}</span>
                <input
                  className="app-dialog__input"
                  value={newAgentDescription}
                  maxLength={4096}
                  onChange={(event) => {
                    setNewAgentDescription(event.target.value);
                    setNewAgentFrontmatter((frontmatter) => ({ ...frontmatter, description: event.target.value }));
                    setNewAgentError(null);
                  }}
                  autoComplete="off"
                  disabled={!!agentsBusy}
                />
              </label>
              <label className="field">
                <span>{tr("ext.agents.view.personas")}</span>
                <Select
                  value={newAgentPersonaSource}
                  options={personaOptions}
                  aria-label={tr("ext.agents.view.personas")}
                  disabled={!!agentsBusy}
                  onChange={setNewAgentPersonaSource}
                />
              </label>
              <label className="field">
                <span>{tr("ext.agents.instructions")}</span>
                <textarea
                  className="app-dialog__input ext-agents__instructions"
                  value={newAgentInstructions}
                  maxLength={65536}
                  onChange={(event) => {
                    setNewAgentInstructions(event.target.value);
                    setNewAgentError(null);
                  }}
                  rows={7}
                  disabled={!!agentsBusy}
                />
              </label>
              <label className="field">
                <span>{tr("ext.agents.frontmatterField", { field: "promptMode" })}</span>
                <Select
                  value={typeof newAgentFrontmatter.promptMode === "string" ? newAgentFrontmatter.promptMode : "full"}
                  aria-label={tr("ext.agents.frontmatterField", { field: "promptMode" })}
                  disabled={!!agentsBusy}
                  onChange={(value) => updateAgentFrontmatter("promptMode", value)}
                  options={["extend", "full"].map((value) => ({ value, label: value }))}
                />
              </label>
              <AgentFrontmatterTextarea
                label={tr("settings.allowedTools")}
                value={stringArrayField(newAgentFrontmatter.tools).join("\n")}
                disabled={!!agentsBusy}
                onChange={(value) => {
                  const tools = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
                  updateAgentFrontmatter("tools", tools.length ? tools : undefined);
                }}
              />
              <label className="field">
                <input
                  type="checkbox"
                  checked={Array.isArray(newAgentFrontmatter.tools) && newAgentFrontmatter.tools.length === 0}
                  disabled={!!agentsBusy}
                  onChange={(event) => updateAgentFrontmatter("tools", event.target.checked ? [] : undefined)}
                />
                <span>{tr("ext.agents.noTools")}</span>
              </label>
              <AgentFrontmatterTextarea
                label={tr("settings.disallowedTools")}
                value={stringArrayField(newAgentFrontmatter.disallowedTools).join("\n")}
                disabled={!!agentsBusy}
                onChange={(value) => {
                  const tools = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
                  updateAgentFrontmatter("disallowedTools", tools.length ? tools : undefined);
                }}
              />
              <label className="field">
                <span>{tr("ext.agents.frontmatterField", { field: "permissionMode" })}</span>
                <Select
                  value={typeof newAgentFrontmatter.permissionMode === "string" ? newAgentFrontmatter.permissionMode : "default"}
                  aria-label={tr("ext.agents.frontmatterField", { field: "permissionMode" })}
                  disabled={!!agentsBusy}
                  onChange={(value) => updateAgentFrontmatter("permissionMode", value)}
                  options={["default", "acceptEdits", "dontAsk", "plan"].map((value) => ({ value, label: value }))}
                />
              </label>
              <AgentFrontmatterTextarea
                label={tr("ext.agents.frontmatterField", { field: "skills" })}
                value={stringArrayField(newAgentFrontmatter.skills).join("\n")}
                disabled={!!agentsBusy}
                onChange={(value) => {
                  const skills = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
                  updateAgentFrontmatter("skills", skills.length ? skills : undefined);
                }}
              />
              <label className="field">
                <span>{tr("ext.agents.frontmatterField", { field: "agentsMd" })}</span>
                <input
                  type="checkbox"
                  checked={newAgentFrontmatter.agentsMd === true}
                  disabled={!!agentsBusy}
                  onChange={(event) => updateAgentFrontmatter("agentsMd", event.target.checked)}
                />
              </label>
              <label className="field">
                <span>{tr("ext.agents.frontmatterField", { field: "outputFormat" })}</span>
                <Select
                  value={typeof newAgentFrontmatter.outputFormat === "string" ? newAgentFrontmatter.outputFormat : "default"}
                  aria-label={tr("ext.agents.frontmatterField", { field: "outputFormat" })}
                  disabled={!!agentsBusy}
                  onChange={(value) => updateAgentFrontmatter("outputFormat", value)}
                  options={["default", "concise"].map((value) => ({ value, label: value }))}
                />
              </label>
              {AGENT_JSON_FRONTMATTER_FIELDS.map((field) => (
                <div key={field}>
                  <AgentFrontmatterTextarea
                    label={tr("ext.agents.frontmatterField", { field })}
                    value={agentJsonFieldText[field] ?? ""}
                    invalid={agentJsonFieldErrors[field] === true}
                    disabled={!!agentsBusy}
                    onChange={(value) => updateAgentJsonField(field, value)}
                  />
                  {agentJsonFieldErrors[field] ? (
                    <span className="ext-field-hint ext-field-hint--error" role="alert">
                      {tr("ext.agents.frontmatterJsonInvalid")}
                    </span>
                  ) : null}
                </div>
              ))}
              <label className="field">
                <span>{tr("ext.agents.frontmatterField", { field: "mcpInheritance" })}</span>
                <Select
                  value={mcpInheritanceMode(newAgentFrontmatter.mcpInheritance)}
                  aria-label={tr("ext.agents.frontmatterField", { field: "mcpInheritance" })}
                  disabled={!!agentsBusy}
                  onChange={(mode) => updateAgentFrontmatter(
                    "mcpInheritance",
                    mode === "all" || mode === "none" ? mode : { [mode]: [] },
                  )}
                  options={[
                    { value: "all", label: tr("ext.agents.mcpInheritance.all") },
                    { value: "none", label: tr("ext.agents.mcpInheritance.none") },
                    { value: "named", label: tr("ext.agents.mcpInheritance.named") },
                    { value: "except", label: tr("ext.agents.mcpInheritance.except") },
                  ]}
                />
              </label>
              {(["named", "except"] as const).includes(mcpInheritanceMode(newAgentFrontmatter.mcpInheritance) as "named" | "except") ? (
                <div className="field">
                  <span>{tr("ext.agents.frontmatterField", { field: `mcpInheritance.${mcpInheritanceMode(newAgentFrontmatter.mcpInheritance)}` })}</span>
                  {mcpServerNames.map((serverName) => {
                    const mode = mcpInheritanceMode(newAgentFrontmatter.mcpInheritance) as "named" | "except";
                    const selected = mcpInheritanceNames(newAgentFrontmatter.mcpInheritance, mode).includes(serverName);
                    return (
                      <label className="field" key={serverName}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!!agentsBusy}
                          onChange={(event) => {
                            const values = new Set(mcpInheritanceNames(newAgentFrontmatter.mcpInheritance, mode));
                            if (event.target.checked) values.add(serverName);
                            else values.delete(serverName);
                            updateAgentFrontmatter("mcpInheritance", { [mode]: [...values] });
                          }}
                        />
                        <span>{serverName}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {newAgentError ? (
                <div className="ext-alert ext-alert--error" role="alert">
                  <p className="ext-alert__body">{newAgentError}</p>
                </div>
              ) : null}
            </form>
          </GlassModal>

          <GlassModal
            open={!!deleteAgentTarget}
            onClose={() => {
              if (!agentsBusy) {
                setDeleteAgentTarget(null);
                setDeleteAgentError(null);
              }
            }}
            title={tr("ext.agents.deleteTitle")}
            size="sm"
            closeLabel={tr("common.close")}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!!agentsBusy}
                  onClick={() => {
                    setDeleteAgentTarget(null);
                    setDeleteAgentError(null);
                  }}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--solid btn--danger"
                  disabled={!!agentsBusy}
                  onClick={() => void deleteAgentDefinition()}
                >
                  {agentsBusy === "agent-delete" ? tr("ext.agents.saving") : tr("ext.agents.deleteConfirm")}
                </button>
              </>
            }
          >
            <p className="app-dialog__msg">
              {tr("ext.agents.deleteBody", { name: deleteAgentTarget?.name ?? "" })}
            </p>
            {deleteAgentTarget?.isDefault ? (
              <p className="ext-field-hint">{tr("ext.agents.deleteDefaultHint")}</p>
            ) : null}
            {deleteAgentError ? (
              <div className="ext-alert ext-alert--error" role="alert">
                <p className="ext-alert__body">{deleteAgentError}</p>
              </div>
            ) : null}
          </GlassModal>

          <GlassModal
            open={!!inlineDraft}
            onClose={() => {
              if (!agentsBusy) {
                setInlineDraft(null);
                setInlineError(null);
                setRolePromptError(false);
                setPersonaInstructionsError(false);
              }
            }}
            title={tr(inlineDraft?.name ? "ext.agents.editTitle" : "ext.agents.newDefinitionTitle", {
              kind: tr(`ext.agents.view.${inlineDraft?.kind === "persona" ? "personas" : "roles"}`),
            })}
            size="md"
            closeLabel={tr("common.close")}
            wrapBody
            footer={
              <>
                <button type="button" className="btn btn--ghost" disabled={!!agentsBusy} onClick={() => { setInlineDraft(null); setInlineError(null); setRolePromptError(false); setPersonaInstructionsError(false); }}>
                  {tr("common.cancel")}
                </button>
                <button type="button" className="btn btn--solid" disabled={!canSaveInlineDefinition} onClick={() => void saveInlineDefinition()}>
                  {agentsBusy === "inline" ? tr("ext.agents.saving") : tr("common.save")}
                </button>
              </>
            }
          >
            {inlineDraft ? (
              <form className="app-dialog__form" onSubmit={(event) => { event.preventDefault(); if (canSaveInlineDefinition) void saveInlineDefinition(); }}>
                {inlineError ? <div className="ext-alert ext-alert--error" role="alert"><p className="ext-alert__body">{inlineError}</p></div> : null}
                <label className="field">
                  <span>{tr(inlineDraft.kind === "persona" ? "ext.agents.agentType" : "ext.agents.name")}</span>
                  {inlineDraft.kind === "persona" ? (
                    <Select
                      value={inlineDraft.name}
                      options={agentTypeOptions}
                      onChange={(name) => setInlineDraft((draft) => draft ? { ...draft, name } : draft)}
                      aria-label={tr("ext.agents.agentType")}
                      disabled={!!agentsBusy || inlineDraft.isEditing}
                    />
                  ) : (
                    <input className="app-dialog__input" value={inlineDraft.name} maxLength={64} disabled={!!agentsBusy || inlineDraft.isEditing} onChange={(event) => setInlineDraft((draft) => draft ? { ...draft, name: event.target.value } : draft)} autoComplete="off" />
                  )}
                  <span className="ext-field-hint">{tr("ext.agents.nameInvalid")}</span>
                </label>
                <label className="field">
                  <span>{tr("ext.agents.description")}</span>
                  <input className="app-dialog__input" value={inlineDraft.description ?? ""} maxLength={65536} disabled={!!agentsBusy} onChange={(event) => setInlineDraft((draft) => draft ? { ...draft, description: event.target.value } : draft)} />
                </label>
                {inlineDraft.kind === "role" ? (
                  <>
                    <label className="field">
                      <span>{tr("ext.agents.capability")}</span>
                      <Select value={inlineDraft.defaultCapabilityMode ?? ""} aria-label={tr("ext.agents.capability")} disabled={!!agentsBusy} onChange={(value) => setInlineDraft((draft) => draft ? { ...draft, defaultCapabilityMode: value } : draft)} options={[
                        { value: "", label: tr("ext.agents.unset") },
                        { value: "read-only", label: tr("ext.agents.capability.readOnly") },
                        { value: "read-write", label: tr("ext.agents.capability.readWrite") },
                        { value: "execute", label: tr("ext.agents.capability.execute") },
                        { value: "all", label: tr("ext.agents.capability.all") },
                      ]} />
                    </label>
                    <label className="field"><span>{tr("ext.agents.model")}</span><input className="app-dialog__input" value={inlineDraft.model ?? ""} maxLength={65536} disabled={!!agentsBusy} onChange={(event) => setInlineDraft((draft) => draft ? { ...draft, model: event.target.value } : draft)} /></label>
                    <label className="field">
                      <span>{tr("ext.agents.view.personas")}</span>
                      <Select
                        value={inlineDraft.personaSource}
                        options={personaOptions}
                        aria-label={tr("ext.agents.view.personas")}
                        disabled={!!agentsBusy}
                        onChange={(personaSource) => setInlineDraft((draft) => draft ? { ...draft, personaSource } : draft)}
                      />
                    </label>
                    <label className="field">
                      <span>{tr("ext.agents.prompt")}</span>
                      <textarea
                        className="app-dialog__input ext-agents__instructions"
                        rows={6}
                        value={inlineDraft.prompt ?? ""}
                        maxLength={65536}
                        disabled={!!agentsBusy}
                        aria-invalid={rolePromptError}
                        aria-describedby={rolePromptError ? "role-prompt-validation" : undefined}
                        onChange={(event) => {
                          const prompt = event.target.value;
                          setInlineDraft((draft) => draft ? {
                            ...draft,
                            prompt,
                            ...(prompt.length === 0 ? { promptFile: "" } : {}),
                          } : draft);
                          if (prompt.trim()) setRolePromptError(false);
                        }}
                      />
                      {rolePromptError ? (
                        <span id="role-prompt-validation" className="ext-field-hint ext-field-hint--error" role="alert">
                          {tr("ext.agents.rolePromptValidation")}
                        </span>
                      ) : null}
                    </label>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>{tr("ext.agents.instructions")}</span>
                      <textarea
                        className="app-dialog__input ext-agents__instructions"
                        value={inlineDraft.instructions ?? ""}
                        maxLength={65536}
                        rows={6}
                        aria-invalid={personaInstructionsError}
                        aria-describedby={personaInstructionsError ? "persona-instructions-validation" : undefined}
                        disabled={!!agentsBusy}
                        onChange={(event) => {
                          const instructions = event.target.value;
                          setInlineDraft((draft) => draft ? { ...draft, instructions } : draft);
                          if (instructions.trim()) setPersonaInstructionsError(false);
                        }}
                      />
                      {personaInstructionsError ? (
                        <span id="persona-instructions-validation" className="ext-field-hint ext-field-hint--error" role="alert">
                          {tr("ext.agents.personaInstructionsValidation")}
                        </span>
                      ) : null}
                    </label>
                    <AgentFrontmatterTextarea
                      label={tr("ext.agents.frontmatterField", { field: "inputs" })}
                      value={personaContractText.inputs}
                      invalid={inlineContractError}
                      disabled={!!agentsBusy}
                      onChange={(value) => updatePersonaContract("inputs", value)}
                    />
                    <AgentFrontmatterTextarea
                      label={tr("ext.agents.frontmatterField", { field: "outputs" })}
                      value={personaContractText.outputs}
                      invalid={inlineContractError}
                      disabled={!!agentsBusy}
                      onChange={(value) => updatePersonaContract("outputs", value)}
                    />
                    {inlineContractError ? (
                      <span className="ext-field-hint ext-field-hint--error" role="alert">
                        {tr("ext.agents.frontmatterJsonInvalid")}
                      </span>
                    ) : null}
                    <label className="field"><span>{tr("ext.agents.model")}</span><input className="app-dialog__input" value={inlineDraft.model ?? ""} maxLength={65536} disabled={!!agentsBusy} onChange={(event) => setInlineDraft((draft) => draft ? { ...draft, model: event.target.value } : draft)} /></label>
                    <label className="field">
                      <span>{tr("ext.agents.reasoningEffort")}</span>
                      <Select value={inlineDraft.reasoningEffort ?? ""} aria-label={tr("ext.agents.reasoningEffort")} disabled={!!agentsBusy} onChange={(value) => setInlineDraft((draft) => draft ? { ...draft, reasoningEffort: value } : draft)} options={[
                        { value: "", label: tr("ext.agents.unset") },
                        ...["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
                      ]} />
                    </label>
                    <label className="field">
                      <span>{tr("ext.agents.defaultIsolation")}</span>
                      <Select value={inlineDraft.defaultIsolation ?? ""} aria-label={tr("ext.agents.defaultIsolation")} disabled={!!agentsBusy} onChange={(value) => setInlineDraft((draft) => draft ? { ...draft, defaultIsolation: value } : draft)} options={[
                        { value: "", label: tr("ext.agents.unset") },
                        { value: "none", label: tr("ext.agents.isolation.none") },
                        { value: "worktree", label: tr("ext.agents.isolation.worktree") },
                      ]} />
                    </label>
                  </>
                )}
              </form>
            ) : null}
          </GlassModal>

          <GlassModal
            open={!!inlineDeleteTarget}
            onClose={() => { if (!agentsBusy) { setInlineDeleteTarget(null); setInlineError(null); } }}
            title={tr("ext.agents.deleteTitle")}
            size="sm"
            closeLabel={tr("common.close")}
            footer={
              <>
                <button type="button" className="btn btn--ghost" disabled={!!agentsBusy} onClick={() => { setInlineDeleteTarget(null); setInlineError(null); }}>{tr("common.cancel")}</button>
                <button type="button" className="btn btn--solid btn--danger" disabled={!!agentsBusy} onClick={() => void deleteInlineDefinition()}>{agentsBusy === "inline" ? tr("ext.agents.saving") : tr("ext.agents.deleteConfirm")}</button>
              </>
            }
          >
            <p className="app-dialog__msg">{tr("ext.agents.deleteBody", { name: inlineDeleteTarget?.name ?? "" })}</p>
            {inlineError ? <div className="ext-alert ext-alert--error" role="alert"><p className="ext-alert__body">{inlineError}</p></div> : null}
          </GlassModal>

          <GlassModal
            open={!!overwriteTarget}
            onClose={() => {
              if (agentsBusy !== "scaffold") {
                setOverwriteTarget(null);
                setNewAgentOpen(true);
              }
            }}
            title={tr("ext.agents.overwriteTitle")}
            size="sm"
            closeLabel={tr("common.close")}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={agentsBusy === "scaffold"}
                  onClick={() => {
                    setOverwriteTarget(null);
                    setNewAgentOpen(true);
                  }}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--solid btn--danger"
                  disabled={agentsBusy === "scaffold"}
                  onClick={() => {
                    if (!overwriteTarget) return;
                    void runScaffold({
                      name: overwriteTarget.name,
                      scope: overwriteTarget.scope,
                      personaSource: newAgentPersonaSource,
                      personaTargetScope: selectedScope,
                      personaProjectPath: selectedScopeProjectPath,
                      description: newAgentDescription,
                      instructions: newAgentInstructions,
                      force: true,
                    });
                  }}
                >
                  {agentsBusy === "scaffold"
                    ? tr("ext.agents.creating")
                    : tr("ext.agents.overwrite")}
                </button>
              </>
            }
          >
            <p className="app-dialog__msg">
              {tr("ext.agents.overwriteBody", {
                name: overwriteTarget?.name ?? "",
              })}
            </p>
          </GlassModal>
        </>
      ) : null}

      {/* ── Hooks ── */}
      {showHooks ? (
        <>
          <h2 className="settings-page__h2" id="settings-anchor-ext-hooks">
            <IconHooks size={15} />
            {tr("ext.hooks.title")}
            {!hooksLoading ? (
              <span className="ext-count">{hooks.length}</span>
            ) : null}
          </h2>
          <div className={embedded ? "ext-card" : "settings-card ext-card"}>
            <p className="ext-section-note ext-section-note--top">
              {tr("ext.hooks.desc")}
            </p>
            <div className="ext-folder-actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!hooksBusy || cliMissing}
                onClick={() => void openHooksDir("user", false)}
              >
                <IconFolder size={13} />
                <span>
                  {hooksBusy === "open-user"
                    ? tr("ext.plugins.working")
                    : tr("ext.hooks.openUser")}
                </span>
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!hooksBusy || cliMissing}
                onClick={() => void openHooksDir("user", true)}
              >
                <IconPlus size={13} />
                <span>{tr("ext.hooks.createUser")}</span>
              </button>
              {projectPath?.trim() ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!!hooksBusy || cliMissing}
                    onClick={() => void openHooksDir("project", false)}
                  >
                    <IconFolder size={13} />
                    <span>
                      {hooksBusy === "open-project"
                        ? tr("ext.plugins.working")
                        : tr("ext.hooks.openProject")}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!!hooksBusy || cliMissing}
                    onClick={() => void openHooksDir("project", true)}
                  >
                    <IconPlus size={13} />
                    <span>{tr("ext.hooks.createProject")}</span>
                  </button>
                </>
              ) : (
                <span className="ext-field-hint">{tr("ext.hooks.emptyProject")}</span>
              )}
            </div>
            {hooksError ? (
              <div className="ext-alert ext-alert--error" role="alert">
                <div className="ext-alert__title">{tr("ext.hooks.error")}</div>
                <p className="ext-alert__body">
                  {isCliMissingError(hooksError)
                    ? tr("ext.error.cliBody")
                    : hooksError}
                </p>
              </div>
            ) : null}
            {hooksLoading ? (
              <p className="ext-empty">{tr("ext.hooks.loading")}</p>
            ) : hooks.length === 0 ? (
              <p className="ext-empty">{tr("ext.hooks.empty")}</p>
            ) : (
              <ul className="ext-list">
                {hooks.map((h) => (
                  <li key={hookRowKey(h)} className="ext-item">
                    <div className="ext-item__head">
                      <strong className="ext-item__name">{h.name}</strong>
                      <span className="ext-badge ext-badge--muted">
                        {scopeLabel(h.scope)}
                      </span>
                      <span className="ext-badge ext-badge--muted">
                        {hookTypeLabel(h)}
                      </span>
                    </div>
                    <div className="ext-item__meta">
                      <span>{hookMetaLine(h)}</span>
                      <span>
                        {formatHookSize(h.size)} · {formatHookMtime(h.mtimeMs)}
                      </span>
                      {h.path ? (
                        <button
                          type="button"
                          className="ext-path-btn"
                          title={h.path}
                          onClick={() => void revealHook(h.path)}
                        >
                          <IconExternalLink size={13} />
                          <span>{tr("ext.hooks.reveal")}</span>
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}

      {/* ── Marketplace / installable catalog ── */}
      {showMarket ? (
        <div
          className={
            "ext-ref-catalog" + (embedded ? " ext-ref-catalog--embedded" : "")
          }
          id={
            embedded
              ? "settings-anchor-ext-plugins-catalog"
              : "settings-anchor-ext-market"
          }
        >
          {!embedded ? (
            <h2 className="settings-page__h2" id="settings-anchor-ext-market">
              <IconPuzzle size={15} />
              {tr("ext.market.title")}
              {!marketLoading ? (
                <span className="ext-count">{filteredByMarket.length}</span>
              ) : null}
              <button
                type="button"
                className="btn btn--ghost ext-bulk-btn"
                disabled={marketLoading || !!marketBusy || cliMissing}
                onClick={() => void loadMarket(true)}
                title={fromCache ? tr("ext.market.cachedHint") : undefined}
              >
                <IconRefresh size={14} />
                <span>
                  {marketBusy === "up:all" || marketLoading
                    ? tr("ext.market.updating")
                    : tr("ext.market.refreshCatalog")}
                </span>
              </button>
            </h2>
          ) : null}
          <div className="settings-card ext-card">
            {embedded ? (
              <div className="ext-ref-block__actions" style={{ justifyContent: "flex-end", marginBottom: 4 }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={marketLoading || !!marketBusy || cliMissing}
                  onClick={() => void loadMarket(true)}
                  title={fromCache ? tr("ext.market.cachedHint") : undefined}
                >
                  <IconRefresh size={13} />
                  <span>
                    {marketBusy === "up:all" || marketLoading
                      ? tr("ext.market.updating")
                      : tr("ext.market.refreshCatalog")}
                  </span>
                </button>
              </div>
            ) : null}
            {ensureOpenaiError ? (
              <div className="ext-alert ext-alert--warn" role="status">
                <div className="ext-alert__title">
                  {tr("ext.plugins.ensureOpenaiFailed")}
                </div>
                <p className="ext-alert__body">
                  {tr("ext.plugins.ensureOpenaiFailedHint")}
                </p>
                <p className="ext-alert__detail">{ensureOpenaiError}</p>
              </div>
            ) : null}
            {showMarketErrorBanner && marketLoadView ? (
              <div
                className={
                  "ext-alert" +
                  (marketLoadView.softFail ||
                  pluginMarketLoadIsSoftFail(marketError)
                    ? " ext-alert--warn"
                    : " ext-alert--error")
                }
                role={marketLoadView.softFail ? "status" : "alert"}
              >
                <div className="ext-alert__title">
                  {tr(pluginMarketErrorTitleKey(marketLoadView.kind) as MessageKey)}
                </div>
                <p className="ext-alert__body">
                  {tr(pluginMarketErrorHintKey(marketLoadView.kind) as MessageKey)}
                </p>
                {marketLoadView.detail ? (
                  <p className="ext-alert__detail">{marketLoadView.detail}</p>
                ) : null}
                {marketLoadView.softFail && onOpenRuntime ? (
                  <button
                    type="button"
                    className="btn btn--solid ext-alert__cta"
                    onClick={onOpenRuntime}
                  >
                    {tr("ext.error.openRuntime")}
                  </button>
                ) : !marketLoadView.softFail ? (
                  <button
                    type="button"
                    className="btn btn--ghost ext-alert__cta"
                    disabled={marketLoading || !!marketBusy}
                    onClick={() => void loadMarket(true)}
                  >
                    {tr("ext.market.retry")}
                  </button>
                ) : null}
              </div>
            ) : null}

            {!sourcesOnly ? (
            <>
            <div className="ext-market-browse">
              <div
                className="ext-plugin-filters"
                role="tablist"
                aria-label={tr("ext.market.filterLabel")}
              >
                {marketChips.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    role="tab"
                    aria-selected={marketFilter === chip.id}
                    className={
                      "ext-plugin-filter" +
                      (marketFilter === chip.id ? " is-active" : "")
                    }
                    onClick={() => setMarketFilter(chip.id)}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
              <input
                type="search"
                className="settings-input ext-market-browse__search"
                value={availQuery}
                placeholder={tr("ext.market.searchPlaceholder")}
                disabled={marketLoading || cliMissing}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setAvailQuery(e.target.value)}
              />
            </div>

            {catalogEmpty ? (
              <div className="ext-empty-cta">
                <p className="ext-empty-cta__text">
                  {tr(catalogEmpty.titleKey as MessageKey)}
                </p>
                {catalogEmpty.hintKey ? (
                  <p className="ext-field-hint">
                    {tr(catalogEmpty.hintKey as MessageKey)}
                  </p>
                ) : null}
                {(() => {
                  const plan = planPluginMarketEmptyRetry(catalogEmpty);
                  if (plan.action === "none") return null;
                  const label =
                    plan.action === "open_runtime" || plan.action === "update_cli"
                      ? tr("ext.error.openRuntime")
                      : plan.action === "clear_filter"
                        ? tr("ext.market.clearFilters")
                        : plan.action === "refresh_catalog"
                          ? tr("ext.market.refreshCatalog")
                          : tr("ext.market.retry");
                  const disabled =
                    plan.action === "open_runtime" || plan.action === "update_cli"
                      ? !onOpenRuntime
                      : marketLoading || !!marketBusy;
                  return (
                    <button
                      type="button"
                      className="btn btn--solid btn--sm"
                      disabled={disabled}
                      onClick={() => runEmptyRetry(plan.action)}
                    >
                      {label}
                    </button>
                  );
                })()}
              </div>
            ) : (
              <ul className="ext-list ext-market-browse__list">
                {visibleAvailable.map((p) => {
                  const rowKey = availablePluginRowKey(p);
                  const busy =
                    marketBusy === `inst:${rowKey}` ||
                    marketBusy === `inst:${p.name}`;
                  const rowError = installErrors[rowKey] ?? null;
                  const installed = isPluginInstalled(p);
                  const badges = availablePluginDetailModel(p).badges;
                  return (
                    <li
                      key={rowKey}
                      className={
                        "ext-item ext-item--clickable" +
                        (detailPlugin &&
                        availablePluginRowKey(detailPlugin) === rowKey
                          ? " is-selected"
                          : "")
                      }
                    >
                      <button
                        type="button"
                        className="ext-item__hit"
                        onClick={() => openDetail(p)}
                        aria-label={tr("ext.market.viewDetailsAria", {
                          name: p.name,
                        })}
                      >
                        <div className="ext-item__head">
                          <span className="ext-item__name">{p.name}</span>
                          {p.marketplace ? (
                            <span className="ext-badge ext-badge--plugin">
                              {p.marketplace}
                            </span>
                          ) : null}
                          {installed ? (
                            <span className="ext-badge ext-badge--muted">
                              {tr("ext.market.installedBadge")}
                            </span>
                          ) : null}
                        </div>
                        {p.description ? (
                          <div className="ext-item__desc">{p.description}</div>
                        ) : null}
                        <div className="ext-item__meta">
                          {availablePluginMetaLine(p)}
                        </div>
                        {badges.length > 0 ? (
                          <div
                            className="ext-component-badges"
                            aria-hidden="true"
                          >
                            {badges.map((b) => (
                              <span
                                key={b.kind}
                                className={
                                  "ext-badge ext-badge--component ext-badge--component-" +
                                  b.kind
                                }
                              >
                                {badgeLabel(b.kind, b.count)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </button>
                      {rowError ? (
                        <div
                          className={
                            "ext-item__row-error" +
                            (rowError.softFail ? " ext-item__row-error--soft" : "")
                          }
                          role={rowError.softFail ? "status" : "alert"}
                        >
                          <span
                            className={
                              "ext-badge " +
                              (rowError.softFail
                                ? "ext-badge--muted"
                                : "ext-badge--fail")
                            }
                          >
                            {tr(
                              pluginMarketErrorTitleKey(
                                rowError.kind,
                              ) as MessageKey,
                            )}
                          </span>
                          <p className="ext-item__row-error-text">
                            {rowErrorLabel(rowError)}
                          </p>
                          <p className="ext-field-hint">
                            {tr(
                              pluginMarketErrorHintKey(
                                rowError.kind,
                              ) as MessageKey,
                            )}
                          </p>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={
                              !!marketBusy ||
                              (cliMissing &&
                                planPluginMarketRetry(rowError.kind, "install")
                                  .action === "retry_install")
                            }
                            onClick={() => runRowRetry(p, rowError)}
                          >
                            {busy
                              ? tr("ext.market.installing")
                              : rowRetryLabel(rowError)}
                          </button>
                        </div>
                      ) : null}
                      <div className="ext-item__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={!!marketBusy}
                          onClick={() => openDetail(p)}
                        >
                          {tr("ext.market.viewDetails")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--solid btn--sm"
                          disabled={!!marketBusy || cliMissing}
                          onClick={() => requestInstall(p)}
                        >
                          {busy
                            ? tr("ext.market.installing")
                            : installed
                              ? tr("ext.market.reinstall")
                              : tr("ext.market.install")}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {hasMore ? (
              <div className="ext-folder-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setPageLimit((n) => n + PAGE_SIZE)}
                >
                  {tr("ext.market.showMore", {
                    n: filteredAvailable.length - visibleAvailable.length,
                  })}
                </button>
              </div>
            ) : null}
            </>
            ) : null}

            {/* Sources + add URL: non-embedded page, or sources-only modal. */}
            {!embedded || sourcesOnly ? (
            <details
              className="ext-market-sources"
              open={sourcesOnly ? true : sourcesOpen}
              onToggle={(e) =>
                setSourcesOpen((e.target as HTMLDetailsElement).open)
              }
            >
              <summary className="ext-market-sources__summary">
                {tr("ext.market.sourcesTitle")}
                {!marketLoading ? (
                  <span className="ext-count">{sources.length}</span>
                ) : null}
              </summary>
              <div className="ext-plugin-install">
                <label
                  className="ext-plugin-install__label"
                  htmlFor="ext-market-source"
                >
                  {tr("ext.market.addLabel")}
                </label>
                <div className="ext-plugin-install__row">
                  <input
                    id="ext-market-source"
                    type="text"
                    className="settings-input ext-plugin-install__input"
                    value={addSource}
                    placeholder={tr("ext.market.addPlaceholder")}
                    disabled={!!marketBusy || cliMissing}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setAddSource(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addMarketplace();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--solid"
                    disabled={!!marketBusy || cliMissing || !addSource.trim()}
                    onClick={() => void addMarketplace()}
                  >
                    {marketBusy === "add"
                      ? tr("ext.market.adding")
                      : tr("ext.market.add")}
                  </button>
                </div>
              </div>
              <div className="ext-folder-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={marketLoading || !!marketBusy || cliMissing}
                  onClick={() => void refreshSources(null)}
                >
                  <IconRefresh size={13} />
                  <span>
                    {marketBusy === "up:all"
                      ? tr("ext.market.updating")
                      : tr("ext.market.updateAll")}
                  </span>
                </button>
              </div>
              {marketLoading ? (
                <p className="ext-field-hint">{tr("ext.market.loading")}</p>
              ) : sources.length === 0 ? (
                <p className="ext-field-hint">{tr("ext.market.empty")}</p>
              ) : (
                <ul className="ext-list">
                  {sources.map((s) => (
                    <li key={s.name} className="ext-item">
                      <div className="ext-item__head">
                        <span className="ext-item__name">{s.name}</span>
                        <span className="ext-badge ext-badge--muted">
                          {s.kind}
                        </span>
                      </div>
                      <div className="ext-item__meta">
                        {marketplaceSourceLabel(s)}
                      </div>
                      <div className="ext-item__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={!!marketBusy || cliMissing}
                          onClick={() => void refreshSources(s.name)}
                        >
                          <IconRefresh size={13} />
                          <span>
                            {marketBusy === `up:${s.name}`
                              ? tr("ext.market.updating")
                              : tr("ext.market.update")}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm ext-item__danger"
                          disabled={!!marketBusy || cliMissing}
                          onClick={() => setRemoveSource(s)}
                        >
                          <IconTrash size={13} />
                          <span>{tr("ext.market.remove")}</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </details>
            ) : null}
          </div>

          <GlassModal
            open={!!removeSource}
            onClose={() => {
              if (!marketBusy) setRemoveSource(null);
            }}
            title={tr("ext.market.removeTitle")}
            size="sm"
            closeLabel={tr("common.close")}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!!marketBusy}
                  onClick={() => setRemoveSource(null)}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={!!marketBusy}
                  onClick={() => void confirmRemoveSource()}
                >
                  {tr("ext.market.remove")}
                </button>
              </>
            }
          >
            <p className="app-dialog__msg">
              {tr("ext.market.removeConfirm", {
                name: removeSource?.name ?? "",
              })}
            </p>
          </GlassModal>

          <GlassModal
            open={!!detailPlugin && !!detailModel}
            onClose={() => {
              if (!marketBusy?.startsWith("inst:")) setDetailPlugin(null);
            }}
            title={detailModel?.name ?? tr("ext.market.detailTitle")}
            size="md"
            closeLabel={tr("common.close")}
            wrapBody
            footer={
              detailPlugin && detailModel ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={!!marketBusy?.startsWith("inst:")}
                    onClick={() => setDetailPlugin(null)}
                  >
                    {tr("common.close")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--solid"
                    disabled={!!marketBusy || cliMissing}
                    onClick={() => requestInstall(detailPlugin)}
                  >
                    {marketBusy ===
                      `inst:${availablePluginRowKey(detailPlugin)}` ||
                    marketBusy === `inst:${detailPlugin.name}`
                      ? tr("ext.market.installing")
                      : isPluginInstalled(detailPlugin)
                        ? tr("ext.market.reinstall")
                        : tr("ext.market.install")}
                  </button>
                </>
              ) : null
            }
          >
            {detailModel ? (
              <div className="ext-market-detail">
                {detailModel.description ? (
                  <p className="ext-market-detail__desc">
                    {detailModel.description}
                  </p>
                ) : (
                  <p className="ext-market-detail__desc ext-market-detail__desc--muted">
                    {tr("ext.market.noDescription")}
                  </p>
                )}
                <dl className="ext-market-detail__meta">
                  <div className="ext-market-detail__row">
                    <dt>{tr("ext.market.field.marketplace")}</dt>
                    <dd>
                      {detailModel.marketplace?.trim() ||
                        tr("ext.market.field.unknown")}
                    </dd>
                  </div>
                  <div className="ext-market-detail__row">
                    <dt>{tr("ext.market.field.version")}</dt>
                    <dd>
                      {detailModel.versionLabel
                        ? `v${detailModel.versionLabel}`
                        : tr("ext.market.field.unknown")}
                    </dd>
                  </div>
                  <div className="ext-market-detail__row">
                    <dt>{tr("ext.market.field.source")}</dt>
                    <dd>
                      <code className="ext-market-detail__code">
                        {detailModel.installSource}
                      </code>
                    </dd>
                  </div>
                </dl>
                {detailModel.badges.length > 0 ? (
                  <div
                    className="ext-component-badges ext-component-badges--detail"
                    aria-label={tr("ext.market.componentsLabel")}
                  >
                    {detailModel.badges.map((b) => (
                      <span
                        key={b.kind}
                        className={
                          "ext-badge ext-badge--component ext-badge--component-" +
                          b.kind
                        }
                      >
                        {badgeLabel(b.kind, b.count)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="ext-field-hint">
                    {tr("ext.market.noComponents")}
                  </p>
                )}
                {detailPlugin &&
                installErrors[availablePluginRowKey(detailPlugin)] ? (
                  <div
                    className={
                      "ext-item__row-error ext-item__row-error--detail" +
                      (installErrors[availablePluginRowKey(detailPlugin)]
                        .softFail
                        ? " ext-item__row-error--soft"
                        : "")
                    }
                    role={
                      installErrors[availablePluginRowKey(detailPlugin)]
                        .softFail
                        ? "status"
                        : "alert"
                    }
                  >
                    <span
                      className={
                        "ext-badge " +
                        (installErrors[availablePluginRowKey(detailPlugin)]
                          .softFail
                          ? "ext-badge--muted"
                          : "ext-badge--fail")
                      }
                    >
                      {tr(
                        pluginMarketErrorTitleKey(
                          installErrors[availablePluginRowKey(detailPlugin)]
                            .kind,
                        ) as MessageKey,
                      )}
                    </span>
                    <p className="ext-item__row-error-text">
                      {rowErrorLabel(
                        installErrors[availablePluginRowKey(detailPlugin)],
                      )}
                    </p>
                    <p className="ext-field-hint">
                      {tr(
                        pluginMarketErrorHintKey(
                          installErrors[availablePluginRowKey(detailPlugin)]
                            .kind,
                        ) as MessageKey,
                      )}
                    </p>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={!!marketBusy}
                      onClick={() =>
                        runRowRetry(
                          detailPlugin,
                          installErrors[availablePluginRowKey(detailPlugin)],
                        )
                      }
                    >
                      {marketBusy ===
                        `inst:${availablePluginRowKey(detailPlugin)}` ||
                      marketBusy === `inst:${detailPlugin.name}`
                        ? tr("ext.market.installing")
                        : rowRetryLabel(
                            installErrors[availablePluginRowKey(detailPlugin)],
                          )}
                    </button>
                  </div>
                ) : null}
                <p className="ext-market-detail__trust">
                  {tr("ext.market.installTrustNote")}
                </p>
              </div>
            ) : null}
          </GlassModal>

          <GlassModal
            open={!!installTarget}
            onClose={() => {
              if (!marketBusy) setInstallTarget(null);
            }}
            title={
              installTarget && isPluginInstalled(installTarget)
                ? tr("ext.market.reinstallTitle")
                : tr("ext.market.installTitle")
            }
            size="sm"
            closeLabel={tr("common.close")}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!!marketBusy}
                  onClick={() => setInstallTarget(null)}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--solid"
                  disabled={!!marketBusy}
                  onClick={() => void confirmInstall()}
                >
                  {marketBusy?.startsWith("inst:")
                    ? tr("ext.market.installing")
                    : installTarget && isPluginInstalled(installTarget)
                      ? tr("ext.market.reinstall")
                      : tr("ext.market.install")}
                </button>
              </>
            }
          >
            <p className="app-dialog__msg">
              {installTarget && isPluginInstalled(installTarget)
                ? tr("ext.market.reinstallConfirm", {
                    name: installTarget?.name ?? "",
                  })
                : tr("ext.market.installConfirm", {
                    name: installTarget?.name ?? "",
                  })}
            </p>
          </GlassModal>
        </div>
      ) : null}
    </>
  );
}
