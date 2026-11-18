import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createT } from "@/i18n";
import { PetTaskBubbles } from "./PetTaskBubbles";

const petCss = readFileSync(join(__dirname, "../../styles/pet.css"), "utf8");

describe("PetTaskBubbles", () => {
  it("uses the shared spinner for active sessions", () => {
    const html = renderToString(
      <PetTaskBubbles
        tasks={[
          {
            sessionId: "session-1",
            title: "Working session",
            snippet: "Working",
            toolTitle: null,
            kind: "working",
            phase: "active",
            progress: 0.4,
            updatedAt: 1,
          },
          {
            sessionId: "session-2",
            title: "Needs your input",
            snippet: "Waiting",
            toolTitle: null,
            kind: "needs_you",
            phase: "active",
            progress: 0.4,
            updatedAt: 2,
          },
        ]}
        t={createT("en")}
        onOpen={() => undefined}
      />,
    );

    expect(html.match(/session-activity-spinner/g)).toHaveLength(2);
    expect(html).toContain("is-wait");
  });

  it("keeps the pet spinner accent color independent of task status color", () => {
    expect(petCss).toMatch(
      /\.pet-bubble__glyph \.session-activity-spinner\s*\{[^}]*color:\s*var\(--accent(?:,\s*#[\da-fA-F]{6})?\);/,
    );
  });
});
