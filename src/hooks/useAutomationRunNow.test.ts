import { describe, expect, it } from "vitest";
import { automationRunErrorMessage } from "./useAutomationRunNow";

describe("automationRunErrorMessage", () => {
  it("localizes a pending-session-settings retry code", () => {
    const translate = (key: string) => key;

    const result = automationRunErrorMessage(
      new Error("PENDING_SESSION_SETTINGS"),
      translate,
    );

    expect(result).toBe("session.pendingSettingsRetry");
  });

  it("preserves other Host error details", () => {
    const translate = (key: string) => key;

    const result = automationRunErrorMessage("connect refused", translate);

    expect(result).toBe("connect refused");
  });
});
