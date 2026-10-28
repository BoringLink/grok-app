import { describe, expect, it } from "vitest";
import {
  commitDirectorSetting,
  directorSettingEnabled,
  setDirectorSettingEnabled,
} from "./directorSetting";

describe("commitDirectorSetting", () => {
  it("keeps the checkbox when the save succeeds", async () => {
    setDirectorSettingEnabled(false);
    await commitDirectorSetting(true, async () => {});
    expect(directorSettingEnabled()).toBe(true);
  });

  it("puts the checkbox back when the save fails", async () => {
    setDirectorSettingEnabled(false);
    await commitDirectorSetting(true, async () => {
      throw new Error("disk");
    });
    expect(directorSettingEnabled()).toBe(false);
  });
});
