/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/jsdomStubs";
import { CodeFileEditor } from "./CodeFileEditor";

const findLabels = {
  placeholder: "Find in file…",
  aria: "Find in file",
  prev: "Previous match",
  next: "Next match",
  close: "Close find",
  count: "{current} / {total}",
  noMatches: "No matches",
};

afterEach(cleanup);

describe("CodeFileEditor find", () => {
  it("uses the shared find bar and marks every match", async () => {
    const { container } = render(
      <CodeFileEditor
        value={"alpha\nbeta\nbeta gamma\n"}
        fileName="alpha.ts"
        onChange={() => {}}
        ariaLabel="Edit alpha.ts"
        findLabels={findLabels}
      />,
    );

    const content = container.querySelector(".cm-content");
    await waitFor(() => expect(content).not.toBeNull());
    (content as HTMLElement).focus();

    await userEvent.keyboard("{Meta>}f{/Meta}");

    const input = await screen.findByRole("searchbox", {
      name: "Find in file…",
    });
    // CodeMirror's own bottom panel is bypassed in favor of the shared bar.
    expect(container.querySelector(".cm-search")).toBeNull();

    await userEvent.type(input, "beta");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelectorAll(".cm-find-hit")).toHaveLength(2);
    });
    expect(
      container.querySelectorAll(".cm-find-hit--active"),
    ).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the editor", async () => {
    const { container } = render(
      <CodeFileEditor
        value={"alpha\nbeta\n"}
        fileName="alpha.ts"
        onChange={() => {}}
        ariaLabel="Edit alpha.ts"
        findLabels={findLabels}
      />,
    );

    const content = container.querySelector(".cm-content");
    await waitFor(() => expect(content).not.toBeNull());
    (content as HTMLElement).focus();
    await userEvent.keyboard("{Meta>}f{/Meta}");

    const input = await screen.findByRole("searchbox", {
      name: "Find in file…",
    });
    await userEvent.type(input, "{Escape}");

    expect(screen.queryByTestId("code-find-bar")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector(".cm-content")),
    );
  });
});
