import { PLUGIN_MARKETPLACE_IMPORT_LIMIT } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/plugins/plugin.query");
vi.mock("@/lib/github-app-config.query");
vi.mock("@/lib/github-pat.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/components/editor");
vi.mock("../_parts/plugin-scope-selector", () => ({
  PluginScopeSelector: () => <div data-testid="plugin-scope-selector" />,
}));
vi.mock("../_parts/plugin-platforms", () => ({
  PluginPlatforms: ({ value }: { value: string[] }) => (
    <div data-testid="plugin-platforms">{value.join(",")}</div>
  ),
}));

import { useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useCreateGithubPat, useGithubPats } from "@/lib/github-pat.query";
import { useAppearanceSettings } from "@/lib/organization.query";
import {
  useCreatePlugin,
  useDiscoverGithubPluginMarketplace,
  useImportGithubPluginMarketplace,
  usePlugins,
  usePreviewGithubPlugin,
} from "@/lib/plugins/plugin.query";
import NewPluginPage from "./page.client";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewPluginPage />
    </QueryClientProvider>,
  );
}

const discoverMock = vi.fn();
const importMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  discoverMock.mockReset();
  discoverMock.mockResolvedValue({ data: null, errorMessage: null });
  importMock.mockReset();
  importMock.mockResolvedValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useGithubAppConfigs).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useGithubAppConfigs>);
  vi.mocked(useGithubPats).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useGithubPats>);
  vi.mocked(useCreateGithubPat).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateGithubPat>);
  vi.mocked(useCreatePlugin).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useCreatePlugin>);
  vi.mocked(usePlugins).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof usePlugins>);
  vi.mocked(useDiscoverGithubPluginMarketplace).mockReturnValue({
    mutateAsync: discoverMock,
    isPending: false,
  } as unknown as ReturnType<typeof useDiscoverGithubPluginMarketplace>);
  vi.mocked(useImportGithubPluginMarketplace).mockReturnValue({
    mutateAsync: importMock,
    isPending: false,
  } as unknown as ReturnType<typeof useImportGithubPluginMarketplace>);
  vi.mocked(usePreviewGithubPlugin).mockReturnValue({
    mutate: vi.fn(),
    reset: vi.fn(),
    data: {
      repo: "wshobson/agents",
      requestedRef: "a".repeat(40),
      commitSha: "a".repeat(40),
      subdir: "plugins/hook-plugin",
      files: [
        {
          path: "hooks/hooks.json",
          content: "{}",
          encoding: "utf8",
          mode: "100644",
        },
      ],
      skippedFiles: [],
    },
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof usePreviewGithubPlugin>);
});

describe("NewPluginPage", () => {
  it("offers a custom marketplace URL and a blank template on the source step", () => {
    renderPage();

    expect(
      screen.getByRole("button", { name: /Custom GitHub URL/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Blank template/ }),
    ).toBeVisible();
  });

  it("lists popular plugin marketplaces on the source step", () => {
    renderPage();

    expect(screen.getByText("Popular marketplaces")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /archestra-ai\/OpenAPPA/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /anthropics\/claude-plugins-official/,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /obra\/superpowers-marketplace/ }),
    ).toBeVisible();
  });

  it("filters the popular marketplaces by search", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(
      screen.getByPlaceholderText(/Search marketplaces/),
      "superpowers",
    );

    // SearchInput debounces before the list narrows
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /anthropics\/claude-plugins-official/,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /obra\/superpowers-marketplace/ }),
    ).toBeVisible();
  });

  it("opens the import dialog with the skills-style form", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /Custom GitHub URL/ }));

    expect(screen.getByText("Import plugins from GitHub")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository URL")).toBeVisible();
    expect(screen.getByLabelText("Keep in sync")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Authentication & ref/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Discover" })).toBeVisible();
  });

  it("auto-discovers when a popular marketplace is picked", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", {
        name: /anthropics\/claude-plugins-official/,
      }),
    );

    expect(discoverMock).toHaveBeenCalledWith({
      repoUrl: "anthropics/claude-plugins-official",
    });
  });

  it("shows the preinstalled OpenAPPA marketplace entry as imported", async () => {
    vi.mocked(usePlugins).mockReturnValue({
      data: [
        {
          sourceMarketplaceRepo: "archestra-ai/OpenAPPA",
          sourceMarketplacePluginName: "appa-runtime",
        },
      ],
    } as unknown as ReturnType<typeof usePlugins>);
    discoverMock.mockResolvedValue({
      data: {
        repoUrl: "archestra-ai/OpenAPPA",
        ref: "main",
        commitSha: "a".repeat(40),
        marketplacePath: ".claude-plugin/marketplace.json",
        reason: null,
        entries: [
          {
            marketplacePath: ".claude-plugin/marketplace.json",
            name: "appa-runtime",
            description: "Open Agent Policy Protocol",
            version: "1.0.0",
            clientType: "claude-code",
            sourceRepoUrl: "archestra-ai/OpenAPPA",
            sourceRef: "main",
            sourceSubdir: "integrations/claude-code/plugin",
            sourceCommitSha: "a".repeat(40),
            fileCount: 2,
            supported: true,
            reason: null,
          },
        ],
      },
      errorMessage: null,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: /archestra-ai\/OpenAPPA/ }),
    );

    expect(await screen.findByText("Imported")).toBeVisible();
    expect(screen.getByText(/0 of 0 selected/)).toBeVisible();
    expect(screen.getByText(/1 imported/)).toBeVisible();
    expect(screen.getByRole("button", { name: /^Import/ })).toBeDisabled();
    expect(
      screen.queryByRole("combobox", { name: "Select platforms" }),
    ).not.toBeInTheDocument();
  });

  it("only offers macOS and Linux for OpenAPPA", async () => {
    discoverMock.mockResolvedValue({
      data: {
        repoUrl: "archestra-ai/OpenAPPA",
        ref: "main",
        commitSha: "a".repeat(40),
        marketplacePath: ".claude-plugin/marketplace.json",
        reason: null,
        entries: [
          {
            marketplacePath: ".claude-plugin/marketplace.json",
            name: "appa-runtime",
            description: "Open Agent Policy Protocol",
            version: "1.0.0",
            clientType: "claude-code",
            sourceRepoUrl: "archestra-ai/OpenAPPA",
            sourceRef: "main",
            sourceSubdir: "integrations/claude-code/plugin",
            sourceCommitSha: "a".repeat(40),
            fileCount: 12,
            supported: true,
            reason: null,
          },
        ],
      },
      errorMessage: null,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: /archestra-ai\/OpenAPPA/ }),
    );

    const platforms = await screen.findByRole("combobox", {
      name: "Select platforms",
    });
    expect(platforms).toHaveTextContent("macOS / Linux");
    await user.click(platforms);
    expect(
      screen.getByRole("menuitemcheckbox", { name: "macOS / Linux" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Windows" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Import (1)" }));
    expect(importMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selected: [expect.objectContaining({ supportedPlatforms: ["posix"] })],
      }),
    );
  });

  it("uses the connection-page platform selector for imported plugins", async () => {
    discoverMock.mockResolvedValue({
      data: {
        repoUrl: "wshobson/agents",
        ref: "main",
        commitSha: "a".repeat(40),
        marketplacePath: ".claude-plugin/marketplace.json",
        reason: null,
        entries: [
          {
            marketplacePath: ".claude-plugin/marketplace.json",
            name: "hook-plugin",
            description: "A hook plugin",
            version: "1.0.0",
            clientType: "claude-code",
            sourceRepoUrl: "wshobson/agents",
            sourceRef: "main",
            sourceSubdir: "plugins/hook-plugin",
            sourceCommitSha: "a".repeat(40),
            fileCount: 1,
            supported: true,
            reason: null,
          },
        ],
      },
      errorMessage: null,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", {
        name: /wshobson\/agents/,
      }),
    );

    expect(
      await screen.findByRole("combobox", { name: "Select platforms" }),
    ).toBeVisible();
    expect(screen.getByText("All platforms")).toBeVisible();
    const platforms = screen.getByRole("combobox", {
      name: "Select platforms",
    });
    const search = screen.getByPlaceholderText("Search by name or description");
    expect(
      platforms.compareDocumentPosition(search) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("1 file")).toBeVisible();
    expect(screen.queryByText("plugins/hook-plugin")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Supported setup platforms"),
    ).not.toBeInTheDocument();

    await user.click(platforms);
    expect(
      screen.getByRole("menuitemcheckbox", { name: "macOS / Linux" }),
    ).toBeChecked();
    const windows = screen.getByRole("menuitemcheckbox", { name: "Windows" });
    expect(windows).toBeChecked();
    await user.click(windows);
    expect(platforms).toHaveTextContent("macOS / Linux");
    await user.keyboard("{Escape}");

    await user.click(
      screen.getByRole("button", { name: "Preview hook-plugin" }),
    );
    expect(
      screen.getByText("Preview of a plugin that has not been imported yet."),
    ).toBeVisible();
    expect(screen.getByText("hooks/hooks.json")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "File contents" }),
    ).toHaveAttribute("readonly");
    expect(screen.queryByText("Plugin files")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Relative path")).not.toBeInTheDocument();
  });

  it("limits each marketplace import to one beta-sized batch", async () => {
    discoverMock.mockResolvedValue({
      data: {
        repoUrl: "github/awesome-copilot",
        ref: "main",
        commitSha: "a".repeat(40),
        marketplacePath: ".github/plugin/marketplace.json",
        reason: null,
        entries: Array.from({ length: 101 }, (_, index) => ({
          marketplacePath: ".github/plugin/marketplace.json",
          name: `plugin-${index}`,
          description: "A plugin",
          version: "1.0.0",
          clientType: index % 2 === 0 ? "claude-code" : "copilot-cli",
          sourceRepoUrl: "github/awesome-copilot",
          sourceRef: "main",
          sourceSubdir: `plugins/plugin-${index}`,
          sourceCommitSha: "a".repeat(40),
          fileCount: 2,
          supported: true,
          reason: null,
        })),
      },
      errorMessage: null,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: /github\/awesome-copilot/ }),
    );

    expect(
      await screen.findByText(
        `${PLUGIN_MARKETPLACE_IMPORT_LIMIT} of 101 selected · ${PLUGIN_MARKETPLACE_IMPORT_LIMIT} max per import`,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        `For this beta, import up to ${PLUGIN_MARKETPLACE_IMPORT_LIMIT} plugins at a time. Finish this import, reopen the marketplace, and select the next batch. Imported plugins will be marked and excluded from the next batch.`,
      ),
    ).toBeVisible();

    const first = screen.getByRole("checkbox", { name: "Deselect plugin-0" });
    const next = screen.getByRole("checkbox", {
      name: `Selection limit reached for plugin-${PLUGIN_MARKETPLACE_IMPORT_LIMIT}`,
    });
    expect(first).toBeChecked();
    expect(next).toBeDisabled();

    await user.click(first);
    expect(next).toBeEnabled();
    await user.click(next);
    expect(next).toBeChecked();

    const clientFilter = screen.getByRole("combobox", {
      name: "Filter marketplace clients",
    });
    expect(clientFilter).toHaveTextContent("All clients");
    await user.click(clientFilter);
    const claudeClient = screen.getByRole("menuitemcheckbox", {
      name: "Claude Code",
    });
    expect(claudeClient).toBeChecked();
    await user.click(claudeClient);
    expect(screen.queryByText("plugin-0")).not.toBeInTheDocument();
    expect(screen.getByText("plugin-1")).toBeVisible();
    expect(screen.getByText(/5 of 101 selected/)).toBeVisible();
  });

  it("walks the blank template through content to access", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /Blank template/ }));

    const displayName = screen.getByLabelText("Display name");
    expect(displayName).toBeVisible();
    expect(screen.getByTestId("plugin-platforms")).toHaveTextContent(
      "posix,windows",
    );
    expect(screen.getByText("hooks/hooks.json")).toBeVisible();
    expect(screen.getByRole("button", { name: "New file" })).toBeVisible();
    expect(screen.queryByLabelText("Relative path")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /Enabled/ }),
    ).not.toBeInTheDocument();

    const continueButton = screen.getByRole("button", { name: /Continue/ });
    const contentCard = displayName.closest(".rounded-lg.border");
    if (!contentCard) throw new Error("Plugin content card not rendered");
    expect(
      within(contentCard as HTMLElement).queryByRole("button", {
        name: /Continue/,
      }),
    ).not.toBeInTheDocument();
    expect(continueButton).toBeDisabled();

    await user.type(screen.getByLabelText("Display name"), "Session guard");
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);

    expect(screen.getByTestId("plugin-scope-selector")).toBeVisible();
    expect(screen.getByRole("button", { name: /Create plugin/ })).toBeVisible();
  });
});
