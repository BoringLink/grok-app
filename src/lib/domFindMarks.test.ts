/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRenderedFindMarks,
  markRenderedFindMatches,
} from "./domFindMarks";

function makeHost(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("markRenderedFindMatches", () => {
  it("marks every literal occurrence and flags the active one", () => {
    const host = makeHost("<p>alpha beta</p><p>beta gamma beta</p>");

    const active = markRenderedFindMatches(host, "beta", 2);

    const marks = host.querySelectorAll("mark.rp-find-hit");
    expect(marks).toHaveLength(3);
    expect(host.querySelectorAll("mark.rp-find-hit.is-active")).toHaveLength(1);
    expect(active?.textContent).toBe("beta");
    expect(active?.parentElement?.textContent).toBe("beta gamma beta");
  });

  it("replaces marks instead of nesting them on the next query", () => {
    const host = makeHost("<p>beta gamma</p>");

    markRenderedFindMatches(host, "beta", 0);
    markRenderedFindMatches(host, "gamma", 0);

    expect(host.querySelectorAll("mark.rp-find-hit")).toHaveLength(1);
    expect(host.textContent).toBe("beta gamma");
  });

  it("clears marks and restores the original text", () => {
    const host = makeHost("<p>alpha beta</p>");

    markRenderedFindMatches(host, "beta", 0);
    clearRenderedFindMarks(host);

    expect(host.querySelector("mark")).toBeNull();
    expect(host.textContent).toBe("alpha beta");
  });
});
