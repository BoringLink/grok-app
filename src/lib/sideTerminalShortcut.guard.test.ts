import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("side terminal shortcut route", () => {
  it("opens a side terminal tab once per key press", () => {
    const source = readFileSync(
      resolve(__dirname, "../app/AppWorkbench.tsx"),
      "utf8",
    );
    const route = source.match(
      /case "sideTerminal":([\s\S]*?)case "liveVoice":/,
    );

    expect(route).not.toBeNull();
    expect(route?.[1]).toMatch(/if \(e\.repeat\) return;/);
    expect(route?.[1]).toMatch(/openSidePicker\("terminal"\)/);
  });
});
