import { describe, expect, it } from "vitest";
import {
  automationReuseSessionId,
  normalizeAutomationSessionMode,
} from "./automations";

describe("automation session target", () => {
  it("defaults to a fresh chat", () => {
    expect(normalizeAutomationSessionMode(undefined, undefined)).toBe("new");
    expect(normalizeAutomationSessionMode("new", "chat-1")).toBe("new");
  });

  it("keeps reuse only when a chat id is present", () => {
    expect(normalizeAutomationSessionMode("reuse", " chat-1 ")).toBe("reuse");
    expect(normalizeAutomationSessionMode("reuse", "   ")).toBe("new");
  });

  it("returns the trimmed reuse chat id", () => {
    expect(
      automationReuseSessionId({
        sessionMode: "reuse",
        sessionId: " chat-1 ",
      }),
    ).toBe("chat-1");
    expect(
      automationReuseSessionId({ sessionMode: "new", sessionId: "chat-1" }),
    ).toBeNull();
  });
});
