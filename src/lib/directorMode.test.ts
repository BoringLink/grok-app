import { describe, expect, it } from "vitest";
import { DIRECTOR_RULE, openAgentSessionId, wrapDirectorSend } from "./directorMode";

describe("wrapDirectorSend", () => {
  it("leaves the text alone when director mode is off", () => {
    expect(wrapDirectorSend("  hello  ", false)).toBe("  hello  ");
  });

  it("prepends the director rule for an open chat", () => {
    const wrapped = wrapDirectorSend("Ship the drawer", true);
    expect(wrapped.startsWith(DIRECTOR_RULE)).toBe(true);
    expect(wrapped).toContain("User request:\nShip the drawer");
  });
});

describe("openAgentSessionId", () => {
  it("is empty for a new chat, so the send is not prefixed", () => {
    expect(
      openAgentSessionId({
        sendTargetId: null,
        viewedSessionId: null,
        viewedAgentSessionId: null,
        rows: [],
      }),
    ).toBe("");
  });

  it("uses the open chat's agent id", () => {
    expect(
      openAgentSessionId({
        sendTargetId: "chat-1",
        viewedSessionId: "chat-1",
        viewedAgentSessionId: null,
        rows: [{ id: "chat-1", agentSessionId: "agent-1" }],
      }),
    ).toBe("agent-1");
  });

  it("uses the live snapshot when the row has not caught up", () => {
    expect(
      openAgentSessionId({
        sendTargetId: "chat-1",
        viewedSessionId: "chat-1",
        viewedAgentSessionId: "agent-live",
        rows: [{ id: "chat-1", agentSessionId: null }],
      }),
    ).toBe("agent-live");
  });

  it("stays empty for another chat that has not started an agent", () => {
    expect(
      openAgentSessionId({
        sendTargetId: "chat-2",
        viewedSessionId: "chat-1",
        viewedAgentSessionId: "agent-live",
        rows: [{ id: "chat-2" }],
      }),
    ).toBe("");
  });
});
