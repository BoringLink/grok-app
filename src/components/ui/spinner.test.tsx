import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Spinner } from "./spinner";

const tailwindCss = readFileSync(
  join(__dirname, "../../styles/tailwind.css"),
  "utf8",
);

describe("Spinner", () => {
  it("preserves the default SVG spinner", () => {
    const html = renderToString(<Spinner size={12} />);

    expect(html).toContain('<svg class="animate-spin text-[var(--text-tertiary)]"');
    expect(html).toContain('width="12"');
    expect(html).toContain('height="12"');
  });

  it("renders the ring variant at the requested size", () => {
    const html = renderToString(
      <Spinner variant="ring" size={11} className="tree-l3__spinner" />,
    );

    expect(html).toContain(
      '<span class="session-activity-spinner tree-l3__spinner"',
    );
    expect(html).toContain('style="width:11px;height:11px"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("keeps the ring track, accent segment, and centered rotation in CSS", () => {
    const utility = tailwindCss.match(
      /@utility session-activity-spinner\s*\{([^}]+)\}/,
    )?.[1];

    expect(utility).toBeDefined();
    expect(utility).toMatch(/border:\s*1\.6px solid color-mix\(/);
    expect(utility).toMatch(/border-top-color:\s*currentColor;/);
    expect(utility).toMatch(/border-radius:\s*50%;/);
    expect(utility).toMatch(/transform-origin:\s*center;/);
    expect(utility).toMatch(
      /animation:\s*session-activity-spinner-rotation 0\.7s linear infinite;/,
    );
    expect(tailwindCss).toMatch(
      /@keyframes session-activity-spinner-rotation\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\);/,
    );
    expect(tailwindCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.session-activity-spinner\s*\{\s*animation:\s*none;/,
    );
  });
});
