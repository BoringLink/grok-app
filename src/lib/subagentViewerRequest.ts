export type SubagentViewerRequest = {
  sessionId: string;
  childId: string;
};

const eventName = "grok-app:open-subagent-viewer";
const pending = new Map<string, SubagentViewerRequest>();
const MAX_PENDING_VIEWER_REQUESTS = 32;

/** Open the shared subagent viewer from any existing subagent task surface. */
export function requestSubagentViewer(request: SubagentViewerRequest): void {
  const sessionId = request.sessionId.trim();
  const childId = request.childId.trim();
  if (!sessionId || !childId) return;
  const normalized = { sessionId, childId };
  pending.delete(sessionId);
  pending.set(sessionId, normalized);
  while (pending.size > MAX_PENDING_VIEWER_REQUESTS) {
    const oldestSession = pending.keys().next().value;
    if (oldestSession === undefined) break;
    pending.delete(oldestSession);
  }
  window.dispatchEvent(new CustomEvent<SubagentViewerRequest>(eventName, { detail: normalized }));
}

/** Subscribe to and consume viewer requests for one active parent session. */
export function subscribeSubagentViewerRequests(
  sessionId: string | null,
  listener: (request: SubagentViewerRequest) => void,
): () => void {
  if (!sessionId) return () => undefined;
  const consume = (request: SubagentViewerRequest) => {
    if (request.sessionId !== sessionId) return;
    pending.delete(sessionId);
    listener(request);
  };
  const onRequest = (event: Event) => {
    const request = (event as CustomEvent<SubagentViewerRequest>).detail;
    if (request && typeof request.sessionId === "string" && typeof request.childId === "string") {
      consume(request);
    }
  };
  window.addEventListener(eventName, onRequest);
  const saved = pending.get(sessionId);
  if (saved) consume(saved);
  return () => window.removeEventListener(eventName, onRequest);
}
