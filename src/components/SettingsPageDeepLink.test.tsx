/**
 * @vitest-environment jsdom
 */
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mocks = vi.hoisted(() => ({
  providersList: vi.fn(),
  secretsGetMasked: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    isTauri: () => true,
    providersList: mocks.providersList,
    secretsGetMasked: mocks.secretsGetMasked,
    editorsList: vi.fn().mockResolvedValue({ editors: [] }),
    listen: vi.fn().mockResolvedValue(() => {}),
  };
});

import { SettingsPage } from "@/components/SettingsPage";
import type { SettingsPageProps } from "@/components/settings/types";
import type {
  SettingsSectionId,
  SettingsTabId,
} from "@/lib/settingsCatalog";

const provider = {
  id: "relay",
  name: "Relay",
  baseUrl: "https://relay.example/v1",
  model: "m1",
  models: [{ id: "m1", name: "m1" }],
  hasApiKey: true,
  apiBackend: "chat_completions",
  providerMode: "generic",
  isDefault: false,
};

// 用例只覆盖路由相关 props；其余 Workbench props 与本流程无关。
const routedProps = (props: Partial<SettingsPageProps>) =>
  props as unknown as SettingsPageProps;

/** 受控 section/tab，模拟 Workbench 把 SettingsPage 的路由回调写回 props。 */
function Harness({
  section: initialSection,
  tab: initialTab,
}: {
  section: SettingsSectionId;
  tab: SettingsTabId;
}) {
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const [tab, setTab] = useState<string | null>(initialTab);
  return (
    <SettingsPage
      {...routedProps({
        section,
        tab,
        onSection: (id, nextTab) => {
          setSection(id);
          setTab(nextTab ?? null);
        },
        onBack: () => {},
        locale: "en",
      })}
    />
  );
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  Element.prototype.scrollIntoView = scrollIntoView;
  mocks.providersList.mockResolvedValue({
    providers: [provider],
    defaultModel: null,
    configPath: "",
    agentHome: "",
  });
  mocks.secretsGetMasked.mockResolvedValue({ hasOfficialKey: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function clickModelsSearchHit(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("textbox", { name: "Search settings…" });
  await user.clear(input);
  await user.type(input, "available models");
  await user.click(
    await screen.findByRole("option", { name: /Request models/ }),
  );
}

describe("SettingsPage provider form anchor deep link", () => {
  it("opens the provider form so the models anchor can be scrolled and highlighted", async () => {
    const user = userEvent.setup();
    render(<Harness section="general" tab="interface" />);

    await clickModelsSearchHit(user);

    expect(await screen.findByTestId("provider-form")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        document.getElementById("settings-anchor-prov-models")?.className,
      ).toContain("is-search-hit"),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("re-focuses the same anchor when the same hit is clicked again", async () => {
    const user = userEvent.setup();
    render(<Harness section="general" tab="interface" />);

    await clickModelsSearchHit(user);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    await clickModelsSearchHit(user);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
  });
});
