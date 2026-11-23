export type SubagentLiveEvent = {
  childId: string;
  kind: "task" | "thought" | "assistant";
  text: string;
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

class SubagentLiveStore {
  private readonly sessions = new Map<string, Map<string, SubagentLiveChild>>();
  private readonly selections = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private revision = 0;
  private sequence = 0;

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
    const children = this.sessions.get(parentId) ?? new Map<string, SubagentLiveChild>();
    const previous = children.get(childId) ?? { childId, events: [], truncated: false };
    const events = [...previous.events, { ...event, childId, sequence: ++this.sequence }];
    const truncated = events.length > SUBAGENT_LIVE_MAX_EVENTS || previous.truncated;
    children.set(childId, {
      childId,
      events: events.slice(-SUBAGENT_LIVE_MAX_EVENTS),
      truncated,
    });
    this.sessions.set(parentId, children);
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
