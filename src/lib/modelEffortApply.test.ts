import { describe, expect, it } from "vitest";
import {
  classifyModelEffortError,
  modelEffortErrorMessageKey,
} from "./modelEffortApply";

describe("classifyModelEffortError / modelEffortErrorMessageKey", () => {
  it("classifies soft kinds from free-form host text", () => {
    expect(classifyModelEffortError("session/set_model: timeout")).toBe(
      "set_model_failed",
    );
    expect(classifyModelEffortError("invalid composer reasoning effort")).toBe(
      "invalid_effort",
    );
    expect(classifyModelEffortError("model id empty")).toBe("invalid_model");
    expect(classifyModelEffortError("invalid effort: xyz")).toBe(
      "invalid_effort",
    );
    expect(
      classifyModelEffortError("reasoning effort is not advertised by this model"),
    ).toBe("invalid_effort");
    expect(classifyModelEffortError("weird boom")).toBe("other");
    expect(classifyModelEffortError(null)).toBe("other");
    expect(classifyModelEffortError(new Error("AGENT gone"))).toBe("other");
  });

  it("maps kinds to message keys", () => {
    expect(modelEffortErrorMessageKey("set_model_failed")).toBe(
      "composer.apply.error.setModelFailed",
    );
    expect(modelEffortErrorMessageKey("invalid_model")).toBe(
      "composer.apply.error.invalidModel",
    );
    expect(modelEffortErrorMessageKey("invalid_effort")).toBe(
      "composer.apply.error.invalidEffort",
    );
    expect(modelEffortErrorMessageKey("other")).toBe(
      "composer.apply.error.other",
    );
  });
});
