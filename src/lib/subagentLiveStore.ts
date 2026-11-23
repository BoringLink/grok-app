export type SubagentLiveEvent = {
  childId: string;
  kind: "task" | "thought" | "assistant";
  text: string;
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

function eventTotals(events: readonly SubagentLiveActivity[]): { chars: number; bytes: number } {
  return events.reduce(
    (totals, event) => ({
      chars: totals.chars + Array.from(event.text).length,
      bytes: totals.bytes + textBytes(event.text),
    }),
    { chars: 0, bytes: 0 },
  );
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
    const bounded = tailWithinLimits(last.text, SUBAGENT_LIVE_MAX_TOTAL_CHARS, SUBAGENT_LIVE_MAX_TOTAL_BYTES);
    events[events.length - 1] = { ...last, text: bounded };
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
    if (!parentId || !childId || !text) return false;
    const boundedText = tailWithinLimits(text, SUBAGENT_LIVE_MAX_TEXT_CHARS, SUBAGENT_LIVE_MAX_TEXT_BYTES);
    const textWasTrimmed = boundedText.length !== text.length;
    const children = this.childrenFor(parentId);
    this.makeRoomForChild(parentId, children, childId);
    const previous = children.get(childId) ?? { childId, events: [], truncated: false };
    const incoming: SubagentLiveActivity = { ...event, childId, text: boundedText, sequence: ++this.sequence };
    const result = trimEvents([...previous.events, incoming]);
    children.delete(childId);
    children.set(childId, {
      childId,
      events: result.events,
      truncated: previous.truncated || event.truncated === true || textWasTrimmed || result.trimmed,
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
    (kind !== "task" && kind !== "thought" && kind !== "assistant") ||
    typeof text !== "string" ||
    (truncated !== undefined && typeof truncated !== "boolean")
  ) return false;
  return subagentLiveStore.apply(sessionId, { childId, kind, text, truncated });
}
