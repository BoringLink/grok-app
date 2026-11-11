/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/jsdomStubs";
import { MarkdownTiptapEditor } from "./MarkdownTiptapEditor";

const labels = {
  bold: "Bold",
  italic: "Italic",
  strike: "Strike",
  code: "Code",
  h1: "H1",
  h2: "H2",
  h3: "H3",
  bulletList: "Bullets",
  orderedList: "Numbers",
  blockquote: "Quote",
  link: "Link",
  hr: "Rule",
  linkPlaceholder: "URL",
  linkApply: "Apply",
  placeholder: "Write…",
  editorAria: "Edit notes",
};

const findLabels = {
  placeholder: "Find in file…",
  aria: "Find in file",
  prev: "Previous match",
  next: "Next match",
  close: "Close find",
  count: "{current} / {total}",
  noMatches: "No matches",
};

afterEach(() => {
  cleanup();
});

describe("MarkdownTiptapEditor find", () => {
  it("opens on Cmd+F and steps through document matches", async () => {
    const { container } = render(
      <MarkdownTiptapEditor
        value={"alpha beta\n\nbeta gamma"}
        onChange={() => {}}
        labels={labels}
        findLabels={findLabels}
      />,
    );

    const prose = container.querySelector(".ProseMirror");
    await waitFor(() => expect(prose).not.toBeNull());
    (prose as HTMLElement).focus();

    await userEvent.keyboard("{Meta>}f{/Meta}");

    const input = await screen.findByRole("searchbox", { name: "Find in file…" });
    expect(screen.getByTestId("md-find-bar").parentElement).toHaveClass(
      "rp-find-overlay",
    );
    await userEvent.type(input, "beta");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    // Every match carries a visible decoration; the active one is distinct.
    await waitFor(() => {
      expect(container.querySelectorAll(".rp-find-hit")).toHaveLength(2);
    });
    expect(
      container.querySelectorAll(".rp-find-hit.is-active"),
    ).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    const active = container.querySelectorAll(".rp-find-hit.is-active");
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent("beta");
  });
});
