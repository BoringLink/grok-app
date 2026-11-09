import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { findPmTextMatches } from "./pmFind";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});

function paragraph(text: string) {
  return schema.node("paragraph", null, text ? [schema.text(text)] : []);
}

describe("findPmTextMatches", () => {
  it("returns absolute editor positions for case-insensitive hits", () => {
    const doc = schema.node("doc", null, [
      paragraph("alpha Beta"),
      paragraph("beta gamma"),
    ]);

    const matches = findPmTextMatches(doc, "beta");

    expect(matches).toHaveLength(2);
    expect(doc.textBetween(matches[0]!.from, matches[0]!.to)).toBe("Beta");
    expect(doc.textBetween(matches[1]!.from, matches[1]!.to)).toBe("beta");
  });

  it("returns nothing for an empty query", () => {
    const doc = schema.node("doc", null, [paragraph("text")]);

    expect(findPmTextMatches(doc, "")).toEqual([]);
  });

  it("caps the match list", () => {
    const doc = schema.node("doc", null, [paragraph("x x x x")]);

    expect(findPmTextMatches(doc, "x", 2)).toHaveLength(2);
  });
});
