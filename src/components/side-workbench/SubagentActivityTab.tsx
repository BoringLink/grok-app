import { useEffect, useMemo } from "react";
import { ChatItem } from "@/components/lobe-chat/ChatItem";
import { MarkdownChat } from "@/components/lobe-chat/MarkdownChat";
import { Thinking } from "@/components/lobe-chat/Thinking";
import { TimelinePhaseBlock } from "@/components/lobe-chat/TimelinePhaseBlock";
import { TimelineToolRow } from "@/components/lobe-chat/TimelineToolRow";
import { createT, type Locale, type MessageKey } from "@/i18n";
import {
  subagentLiveStore,
  type SubagentLiveActivity,
} from "@/lib/subagentLiveStore";
import type { MessageSegment, MessageToolSegment } from "@/lib/session";
import { buildAssistantTimeline, type TimelineUnit } from "@/lib/timelinePhases";
import { subagentDisplayLabel, subagentDisplayStatus } from "@/lib/session/subagents";
import { useSubagentLive } from "@/hooks/useSubagentLive";
import { useSubagents } from "@/hooks/useSubagents";

type Props = { locale: Locale | string; sessionId: string | null };
const toolRunningStatuses = new Set(["in_progress", "pending", "running"]);
const toolFailedStatuses = new Set(["failed", "error", "rejected", "denied"]);

function toToolSegment(event: SubagentLiveActivity): MessageToolSegment {
  const status = event.status?.trim().toLowerCase() ?? "";
  return {
    kind: "tool",
    toolCallId: event.toolCallId || `subagent-${event.sequence}`,
    title: event.title || event.text || "",
    status: event.status ?? "",
    input: event.input,
    output: event.output,
    streaming: toolRunningStatuses.has(status),
    isError: toolFailedStatuses.has(status),
  };
}

function toMessageSegment(event: SubagentLiveActivity): MessageSegment | null {
  if (event.kind === "thought") return { kind: "thought", text: event.text };
  if (event.kind === "tool") return toToolSegment(event);
  if (event.kind === "assistant" || event.kind === "lifecycle") {
    return { kind: "content", text: event.text };
  }
  return null;
}

function timelineUnitKey(unit: TimelineUnit): string {
  if (unit.kind === "phase") return `phase-${unit.id}`;
  if (unit.kind === "tool") return `tool-${unit.tool.toolCallId || unit.si}`;
  return `${unit.kind}-${unit.si}`;
}

/** Live text and thought stream for one parent session's lifecycle-linked children. */
export function SubagentActivityTab({ locale, sessionId }: Props) {
  const t = useMemo(() => createT(locale as Locale), [locale]);
  const runs = useSubagents(sessionId);
  const { children, selectedChildId } = useSubagentLive(sessionId);
  const selectedRun = runs.find((run) => run.subagentId === selectedChildId);
  const selectedActivity = children.find((child) => child.childId === selectedChildId);
  const events = selectedActivity?.events.filter((event) => event.kind !== "boundary") ?? [];
  const lastEvent = selectedActivity?.events.at(-1);
  const lastActivity = events.at(-1);
  const runIsActive = !!selectedRun && subagentDisplayStatus(selectedRun) === "running";
  const activeTextTail = runIsActive && lastEvent === lastActivity &&
    (lastActivity?.kind === "thought" || lastActivity?.kind === "assistant");
  const activeToolTail = runIsActive && lastActivity?.kind === "tool" &&
    toToolSegment(lastActivity).streaming === true;
  const timelineStreaming = activeTextTail || activeToolTail;
  const timelineSegments = events.flatMap((event) => {
    const segment = toMessageSegment(event);
    return segment ? [segment] : [];
  });
  const timelineUnits = buildAssistantTimeline(timelineSegments, {
    streaming: timelineStreaming,
  });

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
      <div className="subagent-activity__stream">
        <div className="lobe-chat subagent-activity__transcript">
          {!selectedRun ? (
            <div className="subagent-activity__empty">{t("tasks.subagentActivityEmpty")}</div>
          ) : (
            <>
              {selectedActivity?.truncated ? (
                <p className="subagent-activity__trimmed" role="status">{t("tasks.subagentActivityTrimmed")}</p>
              ) : null}
              <div className="subagent-activity__messages">
                {timelineUnits.length > 0 ? (
                  <ChatItem
                    placement="left"
                    showAvatar={false}
                    loading={timelineStreaming}
                    message={
                      <div
                        className="lobe-chat-assistant-timeline"
                        aria-busy={timelineStreaming ? true : undefined}
                        aria-live={timelineStreaming ? "polite" : undefined}
                      >
                        {timelineUnits.map((unit) => {
                          const key = timelineUnitKey(unit);
                          if (unit.kind === "phase") {
                            return (
                              <TimelinePhaseBlock
                                key={key}
                                phase={unit}
                                locale={locale as Locale}
                                messageStreaming={timelineStreaming}
                                autoCollapse
                                historyTimestamps={unit.tools.map((tool) => tool.createdAt)}
                              />
                            );
                          }
                          if (unit.kind === "tool") {
                            return (
                              <div className="lobe-timeline-rail" key={key}>
                                <TimelineToolRow tool={unit.tool} autoCollapse locale={locale as Locale} />
                              </div>
                            );
                          }
                          if (unit.kind === "thought" || unit.kind === "thought-group") {
                            const text = unit.kind === "thought-group"
                              ? unit.texts.map((part) => part.trim()).filter(Boolean).join("\n\n")
                              : unit.text;
                            const live = timelineStreaming && unit.streaming;
                            if (!text && !live) return null;
                            return (
                              <div className="lobe-timeline-rail" key={key}>
                                <Thinking content={text} thinking={live} locale={locale as Locale} />
                              </div>
                            );
                          }
                          return (
                            <MarkdownChat
                              key={key}
                              locale={locale as Locale}
                              streaming={timelineStreaming && unit.streaming}
                            >
                              {unit.text}
                            </MarkdownChat>
                          );
                        })}
                      </div>
                    }
                  />
                ) : null}
              </div>
              {selectedRun.output && !selectedActivity?.events.some((event) => event.kind === "assistant") ? (
                <ChatItem
                  placement="left"
                  showAvatar={false}
                  message={
                    <div className="lobe-chat-assistant-timeline">
                      <MarkdownChat locale={locale as Locale}>
                        {selectedRun.output}
                      </MarkdownChat>
                    </div>
                  }
                />
              ) : null}
              {timelineUnits.length === 0 && !selectedRun.output ? (
                <div className="subagent-activity__empty">{t("tasks.subagentActivityEmpty")}</div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
