/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/jsdomStubs";
import type { FileTab } from "@/components/resource-viewer/types";
import { FilesWorkspace } from "./FilesWorkspace";

const apiMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  projectFileIndexSearch: vi.fn(),
}));

const tabMocks = vi.hoisted(() => ({
  activeTab: null as FileTab | null,
  openFile: vi.fn(),
  previewFindFocusLine: null as number | null | undefined,
  previewFindQuery: undefined as string | undefined,
  previewFindRequest: 0,
}));

vi.mock("@/lib/api", () => ({
  isTauri: () => true,
  fsListDir: apiMocks.fsListDir,
  projectFileIndexSearch: apiMocks.projectFileIndexSearch,
  sshListDir: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
}));

vi.mock("@/components/OpenLocationButton", () => ({
  OpenLocationButton: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/resource-viewer/ResourcePreviewBody", () => ({
  ResourcePreviewBody: (props: {
    findFocusLine?: number | null;
    findMode?: boolean;
    findQuery?: string;
    findRequest?: number;
  }) => {
    tabMocks.previewFindFocusLine = props.findFocusLine;
    tabMocks.previewFindQuery = props.findMode ? props.findQuery : "";
    tabMocks.previewFindRequest = props.findRequest ?? 0;
    return <div data-testid="preview-body" />;
  },
}));

vi.mock("@/components/resource-viewer/useResourceFileTabs", () => ({
  useResourceFileTabs: () => ({
    activeTab: tabMocks.activeTab,
    activeTabEditable: false,
    openFile: tabMocks.openFile,
    openAbsoluteFile: vi.fn(),
    updateActiveDraft: vi.fn(),
    saveActiveFile: vi.fn(),
    revertActiveDraft: vi.fn(),
    toggleActiveEditMode: vi.fn(),
    filesTabsEmpty: null,
    dirtyPaths: [],
    closeByPath: vi.fn(() => true),
    discardTabId: null,
    setDiscardTabId: vi.fn(),
    closeTabForced: vi.fn(),
    conflictTabId: null,
    setConflictTabId: vi.fn(),
    reloadActiveFile: vi.fn(),
  }),
}));

function codeTab(text: string): FileTab {
  return {
    id: "tab-1",
    relativePath: "src/alpha.ts",
    name: "alpha.ts",
    absolutePath: "/repo/src/alpha.ts",
    preview: {
      kind: "code",
      text,
      name: "alpha.ts",
      relativePath: "src/alpha.ts",
      absolutePath: "/repo/src/alpha.ts",
      truncated: false,
      error: null,
    } as FileTab["preview"],
    mediaSrc: null,
    error: null,
    loading: false,
    tabKind: "file",
    draftText: text,
    baselineText: text,
    editMode: false,
    saving: false,
  };
}

const baseProps = {
  locale: "en",
  projectPath: "/repo",
  projectName: "repo",
  treeVisible: true,
  onTreeVisibleChange: vi.fn(),
  activePath: "src/alpha.ts",
  paneActive: true,
  sessionChanges: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  tabMocks.activeTab = null;
  tabMocks.previewFindFocusLine = undefined;
  tabMocks.previewFindQuery = undefined;
  tabMocks.previewFindRequest = 0;
  tabMocks.openFile.mockReset();
  apiMocks.fsListDir.mockReset();
  apiMocks.projectFileIndexSearch.mockReset();
});

describe("FilesWorkspace project file search", () => {
  it("lists host-wide name matches, not only loaded tree nodes", async () => {
    tabMocks.activeTab = null;
    apiMocks.fsListDir.mockResolvedValue([]);
    apiMocks.projectFileIndexSearch.mockResolvedValue({
      hits: [
        {
          path: "/repo/src/deep/needle.ts",
          name: "needle.ts",
          relativePath: "src/deep/needle.ts",
          size: 1,
          mtimeMs: 1,
        },
      ],
      projectPath: "/repo",
      query: "needle",
      limit: 100,
      truncated: false,
      indexTruncated: true,
    });

    render(<FilesWorkspace {...baseProps} activePath={null} />);

    await waitFor(() => expect(apiMocks.fsListDir).toHaveBeenCalled());
    await userEvent.type(screen.getByRole("textbox", { name: "Search files…" }), "needle");

    await waitFor(() =>
      expect(screen.getByText("needle.ts")).toBeInTheDocument(),
    );
    expect(apiMocks.projectFileIndexSearch).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/repo", query: "needle" }),
    );
    expect(
      screen.getByText("Large project — some files are not in the index"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByText("needle.ts"));
    expect(tabMocks.openFile).toHaveBeenCalledWith("src/deep/needle.ts");
  });
});

describe("FilesWorkspace in-file find", () => {
  it("opens on Cmd+F, counts matches, and focuses the active match line", async () => {
    tabMocks.activeTab = codeTab("alpha\nbeta\nbeta\n");
    apiMocks.fsListDir.mockResolvedValue([]);

    const { container } = render(<FilesWorkspace {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId("preview-body")).toBeInTheDocument(),
    );

    const pane = screen.getByTestId("files-workspace");
    expect(container.contains(pane)).toBe(true);
    screen.getByRole("textbox", { name: "Search files…" }).focus();
    await userEvent.keyboard("{Meta>}f{/Meta}");

    const findInput = await screen.findByRole("searchbox", {
      name: "Find in file…",
    });
    await userEvent.type(findInput, "beta");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    await waitFor(() => expect(tabMocks.previewFindFocusLine).toBe(2));

    const next = screen.getByRole("button", { name: "Next match" });
    await userEvent.click(next);
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    await waitFor(() => expect(tabMocks.previewFindFocusLine).toBe(3));
  });

  it("opens from a read-only preview when focus sits on the page body", async () => {
    tabMocks.activeTab = codeTab("alpha\nbeta\n");
    apiMocks.fsListDir.mockResolvedValue([]);

    render(<FilesWorkspace {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId("preview-body")).toBeInTheDocument(),
    );

    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("{Meta>}f{/Meta}");

    const findInput = await screen.findByRole("searchbox", {
      name: "Find in file…",
    });
    const bar = screen.getByTestId("files-find-bar");
    expect(bar.parentElement).toHaveClass("rp-find-overlay");
    expect(bar.closest(".rp-split__preview")).not.toBeNull();
    await userEvent.type(findInput, "beta");
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    await waitFor(() => expect(tabMocks.previewFindQuery).toBe("beta"));
  });

  it("routes edit-mode find to the mounted editor bar", async () => {
    const tab = codeTab("alpha\nbeta\n");
    tab.editMode = true;
    tabMocks.activeTab = tab;
    apiMocks.fsListDir.mockResolvedValue([]);

    render(<FilesWorkspace {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId("preview-body")).toBeInTheDocument(),
    );

    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("{Meta>}f{/Meta}");

    await waitFor(() => expect(tabMocks.previewFindRequest).toBe(1));
    expect(screen.queryByTestId("files-find-bar")).not.toBeInTheDocument();
  });

  it("leaves the chord to an input outside the pane", async () => {
    tabMocks.activeTab = codeTab("alpha\nbeta\n");
    apiMocks.fsListDir.mockResolvedValue([]);

    render(
      <>
        <FilesWorkspace {...baseProps} />
        <textarea aria-label="Composer" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("preview-body")).toBeInTheDocument(),
    );

    screen.getByRole("textbox", { name: "Composer" }).focus();
    await userEvent.keyboard("{Meta>}f{/Meta}");

    expect(screen.queryByTestId("files-find-bar")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the pane", async () => {
    tabMocks.activeTab = codeTab("alpha\nbeta\n");
    apiMocks.fsListDir.mockResolvedValue([]);

    render(<FilesWorkspace {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId("preview-body")).toBeInTheDocument(),
    );

    const filterInput = screen.getByRole("textbox", {
      name: "Search files…",
    });
    filterInput.focus();
    await userEvent.keyboard("{Meta>}f{/Meta}");
    const findInput = await screen.findByRole("searchbox", {
      name: "Find in file…",
    });

    await userEvent.type(findInput, "{Escape}");

    expect(screen.queryByTestId("files-find-bar")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(filterInput);
  });
});

describe("FilesWorkspace search failure", () => {
  it("reports a failed host search instead of an empty result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    tabMocks.activeTab = null;
    apiMocks.fsListDir.mockResolvedValue([]);
    apiMocks.projectFileIndexSearch.mockRejectedValue(new Error("boom"));

    render(<FilesWorkspace {...baseProps} activePath={null} />);
    await waitFor(() => expect(apiMocks.fsListDir).toHaveBeenCalled());
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search files…" }),
      "needle",
    );

    expect(await screen.findByText("File search failed")).toBeInTheDocument();
  });
});
