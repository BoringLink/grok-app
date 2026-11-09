/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  activeFileFindLine,
  FILE_FIND_MAX_MATCHES,
  findFileTextMatches,
} from "./filesFind";

describe("findFileTextMatches", () => {
  it("returns 1-based lines for case-insensitive matches", () => {
    const text = "alpha\nBeta\ngamma beta\n";

    const matches = findFileTextMatches(text, "beta");

    expect(matches.map((m) => m.line)).toEqual([2, 3]);
    expect(matches[0]!.index).toBe(text.toLowerCase().indexOf("beta"));
  });

  it("returns nothing for an empty query or empty text", () => {
    expect(findFileTextMatches("some text", "")).toEqual([]);
    expect(findFileTextMatches("", "text")).toEqual([]);
  });

  it("keeps whitespace in the query significant", () => {
    const text = "foo bar\nfoobar";

    expect(findFileTextMatches(text, " foo")).toHaveLength(0);
    expect(findFileTextMatches(text, "foo ")).toHaveLength(1);
  });

  it("counts newlines inside a multi-line query for the following match", () => {
    const text = "aa\nbb\ncc";

    const matches = findFileTextMatches(text, "aa\nbb");

    expect(matches).toHaveLength(1);
    expect(matches[0]!.line).toBe(1);
  });

  it("caps the match list", () => {
    const matches = findFileTextMatches("x x x x", "x", 2);

    expect(matches).toHaveLength(2);
    expect(FILE_FIND_MAX_MATCHES).toBeGreaterThan(2);
  });
});

describe("activeFileFindLine", () => {
  it("maps the active index to a line", () => {
    const matches = findFileTextMatches("a\nb\nb", "b");

    expect(activeFileFindLine(matches, 1)).toBe(3);
    expect(activeFileFindLine(matches, -1)).toBeNull();
    expect(activeFileFindLine(matches, 5)).toBeNull();
  });
});
