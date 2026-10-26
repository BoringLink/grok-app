import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sidebarCss = readFileSync(
  join(__dirname, "../styles/sidebar.part1.css"),
  "utf8",
);
const tokensCss = readFileSync(join(__dirname, "../styles/tokens.css"), "utf8");

/** WCAG 2.x contrast. Alpha ink is composited over the plate first. */
function contrastRatio(
  alpha: number,
  bg: [number, number, number],
  extraOpacity = 1,
): number {
  const a = alpha * extraOpacity;
  const fg = bg.map((channel) => channel * (1 - a)) as [
    number,
    number,
    number,
  ];
  const lum = (rgb: [number, number, number]) => {
    const lin = (channel: number) => {
      const s = channel / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  };
  const lighter = Math.max(lum(fg), lum(bg));
  const darker = Math.min(lum(fg), lum(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

const SOLID: [number, number, number] = [236, 236, 239];
const SHOT: [number, number, number] = [246, 246, 248];

function lightBlock(): string {
  const start = tokensCss.indexOf('[data-theme="light"]');
  const end = tokensCss.indexOf("@media (prefers-reduced-motion", start);
  return tokensCss.slice(start, end);
}

describe("light sidebar ink", () => {
  it("keeps the default light and dark text tokens unchanged", () => {
    const light = lightBlock();
    expect(light).toContain("--text-primary: rgba(0, 0, 0, 0.88);");
    expect(light).toContain("--text-secondary: rgba(0, 0, 0, 0.55);");
    expect(light).toContain("--text-tertiary: rgba(0, 0, 0, 0.36);");
    expect(tokensCss).toContain("--text-primary: rgba(255, 255, 255, 0.92);");
    expect(tokensCss).toContain("--text-secondary: rgba(255, 255, 255, 0.58);");
    expect(tokensCss).toContain("--text-tertiary: rgba(255, 255, 255, 0.38);");
  });

  it("overrides only the default light rail, above the contrast floor", () => {
    const rule =
      /html\[data-theme="light"\]:not\(\[data-skin\]\):not\(\[data-wallpaper="1"\]\):not\(\[data-text-color="custom"\]\)\s+\.sidebar\s*\{([^}]+)\}/;
    const body = sidebarCss.match(rule)?.[1] ?? "";
    expect(body).toContain("--text-secondary: rgba(0, 0, 0, 0.72);");
    expect(body).toContain("--text-tertiary: rgba(0, 0, 0, 0.5);");

    for (const plate of [SOLID, SHOT]) {
      expect(contrastRatio(0.72, plate)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(0.5, plate)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(0.5, plate, 0.9)).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(0.55, SOLID)).toBeGreaterThan(4.5);
    expect(contrastRatio(0.55, SOLID)).toBeLessThan(5);
    expect(contrastRatio(0.36, SOLID)).toBeLessThan(3);
    expect(contrastRatio(0.36, SOLID, 0.9)).toBeLessThan(3);
  });
});
