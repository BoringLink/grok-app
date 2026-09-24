import { describe, expect, it } from "vitest";
import { rankAtFileHits, scoreAtFileHit } from "./atFileQuery";

describe("rankAtFileHits", () => {
  const hits = [
    { path: "/p/a/package.json", name: "package.json", relativePath: "a/package.json", mtimeMs: 1 },
    { path: "/p/package-lock.json", name: "package-lock.json", relativePath: "package-lock.json", mtimeMs: 2 },
    { path: "/p/README.md", name: "README.md", relativePath: "README.md", mtimeMs: 9 },
  ];

  it("ranks package.json first for packa", () => {
    const ranked = rankAtFileHits(hits, "packa");
    expect(ranked[0]!.name).toBe("package.json");
  });

  it("empty query keeps recent first", () => {
    const ranked = rankAtFileHits(hits, "");
    expect(ranked[0]!.name).toBe("README.md");
  });
});

describe("scoreAtFileHit", () => {
  it("exact name beats prefix", () => {
    const exact = scoreAtFileHit(
      { path: "/x", name: "foo", relativePath: "foo" },
      "foo",
    );
    const prefix = scoreAtFileHit(
      { path: "/x", name: "foobar", relativePath: "foobar" },
      "foo",
    );
    expect(exact).toBeGreaterThan(prefix);
  });
});
