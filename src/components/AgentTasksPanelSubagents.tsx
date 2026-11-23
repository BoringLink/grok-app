/**
 * Live subagent runs in the Tasks panel.
 *
 * Kept out of `AgentTasksPanel.tsx`, which sits at the repository's 1000-line
 * file budget: the rows and their counters are self-contained, so the panel only
 * asks for the runs and renders this section.
 */

import { useState } from "react";
import type { Locale, MessageKey } from "@/i18n";
import {
  formatSubagentCount,
  formatSubagentDuration,
  formatSubagentTokens,
  subagentContextOccupancy,
  subagentDisplayLabel,
  subagentDisplayStatus,
  type SubagentDisplayStatus,
  type SubagentRun,
} from "@/lib/session/subagents";
import { IconChevronDown, IconChevronRight, IconEye } from "@/components/icons";
import { requestSubagentViewer } from "@/lib/subagentViewerRequest";
import { subagentLiveStore } from "@/lib/subagentLiveStore";

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

function subagentStatusLabelKey(status: SubagentDisplayStatus): MessageKey {
  switch (status) {
    case "completed":
      return "tasks.subagentCompleted";
    case "failed":
      return "tasks.subagentFailed";
    case "cancelled":
      return "tasks.subagentCancelled";
    case "finished":
      return "tasks.subagentFinished";
    default:
      return "tasks.subagentRunning";
  }
}

function subagentModelLabel(model: string): string {
  const separatorIndex = model.indexOf("__");
  if (separatorIndex < 0) return model;
  return model.slice(separatorIndex + 2).trim() || model;
}

/**
 * One subagent telemetry row. Identity details and counters are shown only
 * when the CLI reports them; final output remains in the side viewer.
 */
function SubagentRow({
  run,
  t,
  locale,
  sessionId,
}: {
  run: SubagentRun;
  t: TFn;
  locale: Locale;
  sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const status = subagentDisplayStatus(run);
  const label = subagentDisplayLabel(run);
  const modelLabel = run.model ? subagentModelLabel(run.model) : null;
  const hasIdentity = Boolean(
    run.childSessionId ||
      run.description ||
      modelLabel,
  );
  const hasMeta =
    subagentContextOccupancy(run) !== null ||
    run.tokensUsed !== undefined ||
    run.turnCount !== undefined ||
    run.toolCallCount !== undefined ||
    run.durationMs !== undefined;
  const openViewer = () => {
    if (!sessionId) return;
    subagentLiveStore.registerChild(sessionId, run.subagentId);
    subagentLiveStore.select(sessionId, run.subagentId);
    requestSubagentViewer({ sessionId, childId: run.subagentId });
  };

  return (
    <li
      className={
        "agent-tasks__row" + (status === "running" ? " is-running" : "")
      }
      onDoubleClick={openViewer}
    >
      <div className="agent-tasks__row-line">
        <div className="agent-tasks__row-main agent-tasks__row-main--flat">
          <button
            type="button"
            className={"agent-tasks__row-toggle" + (!hasIdentity ? " is-static" : "")}
            onClick={() => hasIdentity && setOpen((value) => !value)}
            aria-disabled={hasIdentity ? undefined : true}
            aria-expanded={hasIdentity ? open : undefined}
            aria-label={hasIdentity ? (open ? t("tasks.collapse") : t("tasks.expand")) : undefined}
          >
            <span
              className={`agent-tasks__dot agent-tasks__dot--${status}`}
              aria-hidden
            />
            <span className="agent-tasks__name" title={label}>
              {label}
            </span>
          </button>
          {run.subagentType ? (
            <span className="agent-tasks__status">{run.subagentType}</span>
          ) : null}
          <span className="agent-tasks__status">
            {t(subagentStatusLabelKey(status))}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm agent-tasks__subagent-view"
            disabled={!sessionId}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openViewer();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <IconEye size={13} />
            <span>{t("tasks.subagentView")}</span>
          </button>
          {hasIdentity ? (
            <span className="agent-tasks__row-chev" aria-hidden>
              {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </span>
          ) : null}
        </div>
      </div>
      {hasMeta ? (
        <p className="agent-tasks__subagent-meta">
          {t("tasks.subagentMeta", {
            turns: formatSubagentCount(run.turnCount),
            tools: formatSubagentCount(run.toolCallCount),
            tokens: formatSubagentTokens(run, locale),
            duration: formatSubagentDuration(run.durationMs),
          })}
        </p>
      ) : null}
      {open && hasIdentity ? (
        <div
          className="agent-tasks__detail agent-tasks__detail--grid"
          onClick={(event) => event.stopPropagation()}
        >
          {run.childSessionId ? (
            <div className="agent-tasks__meta">
              <span className="agent-tasks__meta-k">
                {t("statusModal.sessionId")}
              </span>
              <span className="agent-tasks__meta-v" title={run.childSessionId}>
                {run.childSessionId}
              </span>
            </div>
          ) : null}
          {run.description ? (
            <div className="agent-tasks__meta">
              <span className="agent-tasks__meta-k">{t("tasks.subagentActivityTask")}</span>
              <span className="agent-tasks__meta-v" title={run.description}>{run.description}</span>
            </div>
          ) : null}
          {modelLabel ? (
            <div className="agent-tasks__meta">
              <span className="agent-tasks__meta-k">{t("statusModal.model")}</span>
              <span className="agent-tasks__meta-v" title={modelLabel}>{modelLabel}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The panel's subagent section; renders nothing when there are no runs. */
export function SubagentSection({
  runs,
  t,
  locale,
  sessionId,
}: {
  runs: readonly SubagentRun[];
  t: TFn;
  locale: Locale;
  sessionId: string | null;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="agent-tasks__section">
      <h3 className="agent-tasks__section-title">
        {t("tasks.subagentsTitle")}
      </h3>
      <ul className="agent-tasks__list">
        {runs.map((run) => (
          <SubagentRow key={run.subagentId} run={run} t={t} locale={locale} sessionId={sessionId} />
        ))}
      </ul>
    </div>
  );
}
