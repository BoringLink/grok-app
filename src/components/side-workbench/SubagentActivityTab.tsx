import { useEffect, useMemo } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { createT, type Locale, type MessageKey } from "@/i18n";
import { subagentLiveStore } from "@/lib/subagentLiveStore";
import { subagentDisplayLabel, subagentDisplayStatus } from "@/lib/session/subagents";
import { useSubagentLive } from "@/hooks/useSubagentLive";
import { useSubagents } from "@/hooks/useSubagents";

type Props = { locale: Locale | string; sessionId: string | null };
const activityLabel: Record<"task" | "thought" | "assistant", MessageKey> = {
  task: "tasks.subagentActivityTask",
  thought: "tasks.subagentActivityThought",
  assistant: "tasks.subagentActivityAssistant",
};

/** Live text and thought stream for one parent session's lifecycle-linked children. */
export function SubagentActivityTab({ locale, sessionId }: Props) {
  const t = useMemo(() => createT(locale as Locale), [locale]);
  const runs = useSubagents(sessionId);
  const { children, selectedChildId } = useSubagentLive(sessionId);
  const selectedRun = runs.find((run) => run.subagentId === selectedChildId);
  const selectedActivity = children.find((child) => child.childId === selectedChildId);

  useEffect(() => {
    if (!sessionId) return;
    runs.forEach((run) => subagentLiveStore.registerChild(sessionId, run.subagentId));
    if (selectedChildId && runs.some((run) => run.subagentId === selectedChildId)) return;
    const fallback = runs.find((run) => subagentDisplayStatus(run) === "running") ?? runs.at(-1);
    const childId = fallback?.subagentId ?? children.at(-1)?.childId;
    if (childId) subagentLiveStore.select(sessionId, childId);
  }, [children, runs, selectedChildId, sessionId]);

  if (runs.length === 0) {
    return <div className="subagent-activity__empty">{t("tasks.subagentEmpty")}</div>;
  }

  return (
    <section className="subagent-activity" aria-label={t("tasks.subagentsTitle")}>
      <ul className="subagent-activity__children" aria-label={t("tasks.subagentsTitle")}>
        {runs.map((run) => (
          <li key={run.subagentId}>
            <button
              type="button"
              className={"subagent-activity__child" + (run.subagentId === selectedChildId ? " is-active" : "")}
              aria-pressed={run.subagentId === selectedChildId}
              onClick={() => sessionId && subagentLiveStore.select(sessionId, run.subagentId)}
            >
              <span className="subagent-activity__child-name">{subagentDisplayLabel(run)}</span>
              <span className="subagent-activity__child-status">
                {t((`tasks.subagent${subagentDisplayStatus(run)[0]?.toUpperCase()}${subagentDisplayStatus(run).slice(1)}`) as MessageKey)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="subagent-activity__stream" aria-live="polite">
        {!selectedRun ? (
          <div className="subagent-activity__empty">{t("tasks.subagentActivityEmpty")}</div>
        ) : (
          <>
            <h3 className="subagent-activity__title">{subagentDisplayLabel(selectedRun)}</h3>
            {selectedActivity?.truncated ? (
              <p className="subagent-activity__trimmed" role="status">{t("tasks.subagentActivityTrimmed")}</p>
            ) : null}
            {selectedRun.description && !selectedActivity?.events.some((event) => event.kind === "task") ? (
              <article className="subagent-activity__entry">
                <h4>{t("tasks.subagentActivityTask")}</h4>
                <MarkdownBody locale={locale as Locale}>{selectedRun.description}</MarkdownBody>
              </article>
            ) : null}
            {selectedActivity?.events.map((event) => (
              <article className="subagent-activity__entry" key={event.sequence}>
                <h4>{t(activityLabel[event.kind])}</h4>
                <MarkdownBody locale={locale as Locale}>{event.text}</MarkdownBody>
              </article>
            ))}
            {!selectedActivity?.events.length && !selectedRun.description ? (
              <div className="subagent-activity__empty">{t("tasks.subagentActivityEmpty")}</div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
