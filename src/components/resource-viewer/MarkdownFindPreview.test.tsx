/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import "@/test/jsdomStubs";
import { MarkdownFindPreview } from "./MarkdownFindPreview";

afterEach(cleanup);

describe("MarkdownFindPreview", () => {
  it("marks rendered hits without leaving the preview", async () => {
    const { container } = render(
      <MarkdownFindPreview
        text={"alpha beta\n\nbeta gamma"}
        locale="en"
        findQuery="beta"
        findActive={1}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("mark.rp-find-hit")).toHaveLength(2),
    );
    expect(
      container.querySelectorAll("mark.rp-find-hit.is-active"),
    ).toHaveLength(1);
  });

  it("removes marks when the query is cleared", async () => {
    const { container, rerender } = render(
      <MarkdownFindPreview
        text={"alpha beta"}
        locale="en"
        findQuery="beta"
        findActive={0}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll("mark.rp-find-hit")).toHaveLength(1),
    );

    rerender(
      <MarkdownFindPreview
        text={"alpha beta"}
        locale="en"
        findQuery=""
        findActive={-1}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("mark.rp-find-hit")).toHaveLength(0),
    );
    expect(container.textContent).toContain("alpha beta");
  });
});
