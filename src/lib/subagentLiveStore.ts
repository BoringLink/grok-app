export type SubagentLiveEvent = {
  childId: string;
  kind: "task" | "thought" | "assistant" | "tool" | "lifecycle" | "boundary";
  text: string;
  messageId?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  input?: string;
  output?: string;
  truncated?: boolean;
};

export type SubagentLiveActivity = SubagentLiveEvent & { sequence: number };
export type SubagentLiveChild = {
  childId: string;
  events: readonly SubagentLiveActivity[];
  truncated: boolean;
};

type Listener = () => void;
const EMPTY: readonly SubagentLiveChild[] = [];
export const SUBAGENT_LIVE_MAX_EVENTS = 200;
export const SUBAGENT_LIVE_MAX_TEXT_CHARS = 16_000;
export const SUBAGENT_LIVE_MAX_TEXT_BYTES = 32_768;
export const SUBAGENT_LIVE_MAX_TOTAL_CHARS = 128_000;
export const SUBAGENT_LIVE_MAX_TOTAL_BYTES = 262_144;
export const SUBAGENT_LIVE_MAX_SESSION_CHARS = 512_000;
export const SUBAGENT_LIVE_MAX_SESSION_BYTES = 1_048_576;
export const SUBAGENT_LIVE_MAX_SESSIONS = 32;
export const SUBAGENT_LIVE_MAX_CHILDREN_PER_SESSION = 100;

function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function codePointBytes(point: string): number {
  const value = point.codePointAt(0) ?? 0;
  if (value <= 0x7f) return 1;
  if (value <= 0x7ff) return 2;
  if (value <= 0xffff) return 3;
  return 4;
}

function tailWithinLimits(text: string, maxChars: number, maxBytes: number): string {
  let start = Math.max(0, text.length - maxChars * 2);
  if (start > 0) {
    const firstUnit = text.charCodeAt(start);
    const previousUnit = text.charCodeAt(start - 1);
    if (firstUnit >= 0xdc00 && firstUnit <= 0xdfff && previousUnit >= 0xd800 && previousUnit <= 0xdbff) {
      start -= 1;
    }
  }
  const codePoints = Array.from(text.slice(start)).slice(-maxChars);
  let kept = "";
  let bytes = 0;
  for (const point of codePoints.reverse()) {
    const pointBytes = codePointBytes(point);
    if (bytes + pointBytes > maxBytes) break;
    kept = point + kept;
    bytes += pointBytes;
  }
  return kept;
}

function boundToolEvent(event: SubagentLiveEvent): { event: SubagentLiveEvent; trimmed: boolean } {
  const fields = ["text", "title", "status", "input", "output"] as const;
  const values = fields.map((key) => event[key]);
  let remainingChars = SUBAGENT_LIVE_MAX_TEXT_CHARS;
  let remainingBytes = SUBAGENT_LIVE_MAX_TEXT_BYTES;
  let trimmed = false;
  const boundedValues = values.map((value) => {
    if (value === undefined) return undefined;
    const bounded = tailWithinLimits(value, remainingChars, remainingBytes);
    trimmed ||= bounded.length !== value.length;
    remainingChars -= Array.from(bounded).length;
    remainingBytes -= textBytes(bounded);
    return bounded;
  });
  return {
    event: {
      ...event,
      text: boundedValues[0] ?? "",
      title: boundedValues[1],
      status: boundedValues[2],
      input: boundedValues[3],
      output: boundedValues[4],
    },
    trimmed,
  };
}

function eventTotals(events: readonly SubagentLiveActivity[]): { chars: number; bytes: number } {
  return events.reduce((totals, event) => {
    const content = [event.text, event.title, event.status, event.input, event.output].filter(Boolean).join("");
    return {
      chars: totals.chars + Array.from(content).length,
      bytes: totals.bytes + textBytes(content),
    };
  }, { chars: 0, bytes: 0 });
}

function trimEvents(events: SubagentLiveActivity[]): { events: SubagentLiveActivity[]; trimmed: boolean } {
  let trimmed = false;
  while (events.length > SUBAGENT_LIVE_MAX_EVENTS) {
    events.shift();
    trimmed = true;
  }
  let totals = eventTotals(events);
  while (events.length > 1 && (totals.chars > SUBAGENT_LIVE_MAX_TOTAL_CHARS || totals.bytes > SUBAGENT_LIVE_MAX_TOTAL_BYTES)) {
    events.shift();
    trimmed = true;
    totals = eventTotals(events);
  }
  const last = events.at(-1);
  if (last && (totals.chars > SUBAGENT_LIVE_MAX_TOTAL_CHARS || totals.bytes > SUBAGENT_LIVE_MAX_TOTAL_BYTES)) {
    events[events.length - 1] = { ...boundToolEvent(last).event, sequence: last.sequence };
    trimmed = true;
  }
  return { events, trimmed };
}

function sessionTotals(children: Map<string, SubagentLiveChild>): { chars: number; bytes: number } {
  return [...children.values()].reduce((session, child) => {
    const totals = eventTotals(child.events);
    return { chars: session.chars + totals.chars, bytes: session.bytes + totals.bytes };
  }, { chars: 0, bytes: 0 });
}

class SubagentLiveStore {
  private readonly sessions = new Map<string, Map<string, SubagentLiveChild>>();
  private readonly selections = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private revision = 0;
  private sequence = 0;

  private childrenFor(sessionId: string): Map<string, SubagentLiveChild> {
    const children = this.sessions.get(sessionId) ?? new Map<string, SubagentLiveChild>();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, children);
    while (this.sessions.size > SUBAGENT_LIVE_MAX_SESSIONS) {
      const oldestSession = this.sessions.keys().next().value;
      if (oldestSession === undefined) break;
      this.sessions.delete(oldestSession);
      this.selections.delete(oldestSession);
    }
    return children;
  }

  private makeRoomForChild(sessionId: string, children: Map<string, SubagentLiveChild>, childId: string): void {
    if (children.has(childId)) return;
    if (children.size < SUBAGENT_LIVE_MAX_CHILDREN_PER_SESSION) return;
    const oldestChild = children.keys().next().value;
    if (oldestChild !== undefined) {
      children.delete(oldestChild);
      if (this.selections.get(sessionId) === oldestChild) this.selections.delete(sessionId);
    }
  }

  private trimSession(children: Map<string, SubagentLiveChild>): void {
    let totals = sessionTotals(children);
    while (totals.chars > SUBAGENT_LIVE_MAX_SESSION_CHARS || totals.bytes > SUBAGENT_LIVE_MAX_SESSION_BYTES) {
      const oldest = [...children.values()]
        .filter((child) => child.events.length > 0)
        .reduce<SubagentLiveChild | undefined>((candidate, child) => {
          const childSequence = child.events[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
          const candidateSequence = candidate?.events[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
          return childSequence < candidateSequence ? child : candidate;
        }, undefined);
      if (!oldest) return;
      children.set(oldest.childId, { ...oldest, events: oldest.events.slice(1), truncated: true });
      totals = sessionTotals(children);
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.revision;

  list(sessionId: string | null | undefined): readonly SubagentLiveChild[] {
    if (!sessionId) return EMPTY;
    return [...(this.sessions.get(sessionId)?.values() ?? [])];
  }

  selected(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    return this.selections.get(sessionId) ?? null;
  }

  registerChild(sessionId: string, childId: string): boolean {
    const parentId = sessionId.trim();
    const normalizedChildId = childId.trim();
    if (!parentId || !normalizedChildId) return false;
    const children = this.childrenFor(parentId);
    this.makeRoomForChild(parentId, children, normalizedChildId);
    if (children.has(normalizedChildId)) return true;
    children.set(normalizedChildId, { childId: normalizedChildId, events: [], truncated: false });
    this.changed();
    return true;
  }

  select(sessionId: string, childId: string): boolean {
    if (!this.sessions.get(sessionId)?.has(childId)) return false;
    this.selections.set(sessionId, childId);
    this.changed();
    return true;
  }

  apply(sessionId: string, event: SubagentLiveEvent): boolean {
    const parentId = sessionId.trim();
    const childId = event.childId.trim();
    const text = event.text;
    if (!parentId || !childId || (!text && event.kind !== "boundary" && event.kind !== "tool")) return false;
    const boundField = (value: string | undefined): string | undefined => value === undefined
      ? undefined
      : tailWithinLimits(value, SUBAGENT_LIVE_MAX_TEXT_CHARS, SUBAGENT_LIVE_MAX_TEXT_BYTES);
    const boundedText = tailWithinLimits(text, SUBAGENT_LIVE_MAX_TEXT_CHARS, SUBAGENT_LIVE_MAX_TEXT_BYTES);
    const boundedEvent = {
      ...event,
      text: boundedText,
      title: boundField(event.title),
      status: boundField(event.status),
      input: boundField(event.input),
      output: boundField(event.output),
    };
    const boundedResult = boundToolEvent(boundedEvent);
    const finalBoundedEvent = boundedResult.event;
    const textWasTrimmed = boundedResult.trimmed || boundedText.length !== text.length ||
      [event.title, event.status, event.input, event.output].some((value) => value !== undefined && boundField(value)?.length !== value.length);
    const children = this.childrenFor(parentId);
    this.makeRoomForChild(parentId, children, childId);
    const previous = children.get(childId) ?? { childId, events: [], truncated: false };
    const incoming: SubagentLiveActivity = { ...finalBoundedEvent, childId, sequence: ++this.sequence };
    const textKind = event.kind === "thought" || event.kind === "assistant";
    const matchingIndex = textKind
      ? event.messageId
        ? previous.events.findIndex((item) => item.kind === event.kind && item.messageId === event.messageId)
        : previous.events.at(-1)?.kind === event.kind && !previous.events.at(-1)?.messageId
          ? previous.events.length - 1
          : -1
      : event.kind === "tool" && event.toolCallId
        ? previous.events.findIndex((item) => item.kind === "tool" && item.toolCallId === event.toolCallId)
        : -1;
    const nextEvents = [...previous.events];
    let mergedTextWasTrimmed = false;
    if (matchingIndex >= 0) {
      const current = nextEvents[matchingIndex];
      const combinedText = event.kind === "tool" ? finalBoundedEvent.text : current.text + finalBoundedEvent.text;
      const mergedText = tailWithinLimits(combinedText, SUBAGENT_LIVE_MAX_TEXT_CHARS, SUBAGENT_LIVE_MAX_TEXT_BYTES);
      mergedTextWasTrimmed = mergedText.length !== combinedText.length;
      nextEvents[matchingIndex] = {
        ...current,
        ...finalBoundedEvent,
        childId,
        text: mergedText,
        title: finalBoundedEvent.title || current.title,
        status: finalBoundedEvent.status || current.status,
        input: finalBoundedEvent.input || current.input,
        output: finalBoundedEvent.output || current.output,
        sequence: incoming.sequence,
      };
    } else {
      nextEvents.push(incoming);
    }
    const result = trimEvents(nextEvents);
    children.delete(childId);
    children.set(childId, {
      childId,
      events: result.events,
      truncated: previous.truncated || event.truncated === true || textWasTrimmed || mergedTextWasTrimmed || result.trimmed,
    });
    this.trimSession(children);
    this.changed();
    return true;
  }

  resetForTests(): void {
    this.sessions.clear();
    this.selections.clear();
    this.sequence = 0;
    this.changed();
  }

  private changed(): void {
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export const subagentLiveStore = new SubagentLiveStore();

/** Admit an ACP text payload only when its child session matches a lifecycle-owned run. */
export function applySubagentLivePayload(
  payload: unknown,
  associatedChildSessionId: string | null | undefined,
): boolean {
  if (!payload || typeof payload !== "object" || !associatedChildSessionId) return false;
  const value = payload as Record<string, unknown>;
  const { sessionId, childId, childSessionId, kind, text, truncated } = value;
  if (
    typeof sessionId !== "string" ||
    typeof childId !== "string" ||
    typeof childSessionId !== "string" ||
    childSessionId !== associatedChildSessionId ||
    (kind !== "task" && kind !== "thought" && kind !== "assistant" && kind !== "tool" && kind !== "lifecycle" && kind !== "boundary") ||
    typeof text !== "string" ||
    (truncated !== undefined && typeof truncated !== "boolean")
  ) return false;
  const optionalText = (key: string): string | undefined =>
    value[key] === undefined || value[key] === null || value[key] === "" ? undefined : typeof value[key] === "string" ? value[key] : undefined;
  const messageId = optionalText("messageId");
  const toolCallId = optionalText("toolCallId");
  const title = optionalText("title");
  const status = optionalText("status");
  const input = optionalText("input");
  const output = optionalText("output");
  if (["messageId", "toolCallId", "title", "status", "input", "output"].some((key) =>
    value[key] !== undefined && value[key] !== null && typeof value[key] !== "string",
  )) return false;
  if ((messageId?.length ?? 0) > 512 || (toolCallId?.length ?? 0) > 512) return false;
  return subagentLiveStore.apply(sessionId, { childId, kind, text, messageId, toolCallId, title, status, input, output, truncated });
}
