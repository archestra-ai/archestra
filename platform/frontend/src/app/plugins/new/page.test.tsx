import {
  archestraApiClient,
  PLUGIN_MARKETPLACE_IMPORT_LIMIT,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/plugins/plugin.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/components/editor");
vi.mock("../_parts/plugin-platforms", () => ({
  PluginPlatforms: ({ value }: { value: string[] }) => (
    <div data-testid="plugin-platforms">{value.join(",")}</div>
  ),
}));

import { useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
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
  const view = render(
    <QueryClientProvider client={queryClient}>
      <NewPluginPage />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderPage: () =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NewPluginPage />
        </QueryClientProvider>,
      ),
  };
}

const discoverMock = vi.fn();
const importMock = vi.fn();

const permissionServer = setupServer(
  // No saved GitHub Apps or GitLab tokens: public access is the default.
  http.get("http://localhost:9000/api/git-credentials", () =>
    HttpResponse.json([]),
  ),
  http.get(
    "http://localhost:9000/api/resource-permissions/plugin/creation-subjects",
    () =>
      HttpResponse.json([
        { subject: { type: "role", id: "member" }, name: "Member" },
      ]),
  ),
  http.get("http://localhost:9000/api/resource-permissions/plugin/:scope", () =>
    HttpResponse.json({
      resource: "plugin",
      scope: "*",
      name: "Plugins",
      ownerId: null,
      revision: 1,
      grants: [],
      inheritedGrants: [],
      effectiveActions: ["read", "update", "manage-permissions"],
      canShareOrganizationWide: true,
      actorSubjects: [],
    }),
  ),
);
beforeAll(() => {
  permissionServer.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  permissionServer.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

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
  it("offers a Git repository and a blank template on the source step", () => {
    renderPage();

    expect(
      screen.getByRole("button", { name: /Git repository/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Blank template/ }),
    ).toBeVisible();
  });

  it("lists popular plugin marketplaces on the source step", () => {
    renderPage();

    expect(screen.getByText("Popular marketplaces")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /anthropics\/claude-plugins-official/,
      }),
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

  it("reads a public GitHub repository without sending a credential", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /Git repository/ }));
    expect(screen.getByText("Import plugins")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^GitHub/ }));

    // Without saved Apps, public access is picked for you.
    expect(
      await screen.findByRole("radio", { name: /Public repository/ }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(
      screen.getByPlaceholderText("github.com/owner/repo"),
      "acme/plugins",
    );
    await user.click(screen.getByRole("button", { name: "Find plugins" }));

    expect(discoverMock).toHaveBeenCalledWith({
      repoUrl: "https://github.com/acme/plugins",
      provider: "github",
    });
  });

  it("imports the plugin folders of a repository without a marketplace file", async () => {
    discoverMock.mockResolvedValue({
      data: {
        repoUrl: "https://github.com/acme/plugins",
        ref: "main",
        commitSha: "a".repeat(40),
        marketplacePath: null,
        reason: null,
        entries: [
          {
            marketplacePath: null,
            name: "folder-plugin",
            description: "A plugin folder",
            version: null,
            clientType: "claude-code",
            sourceRepoUrl: "https://github.com/acme/plugins",
            sourceRef: "main",
            sourceSubdir: "plugins/folder-plugin",
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

    await user.click(screen.getByRole("button", { name: /Git repository/ }));
    await user.click(screen.getByRole("button", { name: /^GitHub/ }));
    await screen.findByRole("radio", { name: /Public repository/ });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(
      screen.getByPlaceholderText("github.com/owner/repo"),
      "acme/plugins",
    );
    await user.click(screen.getByRole("button", { name: "Find plugins" }));
    expect(
      await screen.findByText(
        "No marketplace file. These are its plugin folders.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Import(?: \(|$)/ }));

    expect(importMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/acme/plugins",
        provider: "github",
        marketplacePath: null,
        selected: [
          expect.objectContaining({
            name: "folder-plugin",
            sourceSubdir: "plugins/folder-plugin",
          }),
        ],
      }),
    );
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
      repoUrl: "https://github.com/anthropics/claude-plugins-official",
      provider: "github",
    });
  });

  it("shows an already imported marketplace entry", async () => {
    vi.mocked(usePlugins).mockReturnValue({
      data: [
        {
          sourceMarketplaceRepo: "anthropics/claude-plugins-official",
          sourceMarketplacePluginName: "policy-runtime",
          clientType: "claude-code",
        },
      ],
    } as unknown as ReturnType<typeof usePlugins>);
    discoverMock.mockResolvedValue({
      data: {
        repoUrl: "anthropics/claude-plugins-official",
        ref: "main",
        commitSha: "a".repeat(40),
        marketplacePath: ".claude-plugin/marketplace.json",
        reason: null,
        entries: [
          {
            marketplacePath: ".claude-plugin/marketplace.json",
            name: "policy-runtime",
            description: "Applies policy hooks",
            version: "1.0.0",
            clientType: "claude-code",
            sourceRepoUrl: "anthropics/claude-plugins-official",
            sourceRef: "main",
            sourceSubdir: "plugins/policy-runtime",
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
      screen.getByRole("button", {
        name: /anthropics\/claude-plugins-official/,
      }),
    );

    expect(await screen.findByText("Imported")).toBeVisible();
    expect(screen.getByText(/0 of 0 selected/)).toBeVisible();
    expect(screen.getByText(/1 imported/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Import(?: \(|$)/ }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("combobox", { name: "Select platforms" }),
    ).not.toBeInTheDocument();
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

    await screen.findByText("hook-plugin");
    await user.click(screen.getByRole("button", { name: "Import settings" }));
    expect(
      await screen.findByRole("combobox", { name: "Select platforms" }),
    ).toBeVisible();
    expect(screen.getByText("All platforms")).toBeVisible();
    const platforms = screen.getByRole("combobox", {
      name: "Select platforms",
    });
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

  it("limits each marketplace import to one bounded batch", async () => {
    discoverMock.mockResolvedValue(boundedMarketplaceFixture());
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
    await user.click(screen.getByRole("button", { name: "Import settings" }));
    expect(
      screen.getByText("Import this batch, then reopen for the next."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Import settings" }));

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
  });

  it("updates bounded marketplace selection totals when filtering clients", async () => {
    discoverMock.mockResolvedValue(boundedMarketplaceFixture());
    const user = userEvent.setup();
    renderPage();
    await user.click(
      screen.getByRole("button", { name: /github\/awesome-copilot/ }),
    );
    await screen.findByText(
      `${PLUGIN_MARKETPLACE_IMPORT_LIMIT} of 101 selected · ${PLUGIN_MARKETPLACE_IMPORT_LIMIT} max per import`,
    );
    const clientFilter = screen.getByRole("combobox", {
      name: "Filter marketplace clients",
    });
    // The marketplace's clients start selected; a Claude Desktop copy of
    // its Claude Code plugins is offered but opt-in.
    expect(clientFilter).toHaveTextContent("Select clients");
    await user.click(clientFilter);
    const claudeClient = screen.getByRole("menuitemcheckbox", {
      name: "Claude Code",
    });
    expect(claudeClient).toBeChecked();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Claude Desktop" }),
    ).not.toBeChecked();
    await user.click(claudeClient);
    expect(screen.queryByText("plugin-0")).not.toBeInTheDocument();
    expect(screen.getByText("plugin-1")).toBeVisible();
    // The totals follow the clients in view.
    expect(screen.getByText(/5 of 50 selected/)).toBeVisible();
  });

  it("submits selected permissions with a new plugin instead of legacy visibility", async () => {
    const create = vi.fn().mockResolvedValue({ id: "created-plugin" });
    vi.mocked(useCreatePlugin).mockReturnValue({
      mutateAsync: create,
      isPending: false,
    } as unknown as ReturnType<typeof useCreatePlugin>);
    const user = userEvent.setup();
    const view = renderPage();
    await user.click(screen.getByRole("button", { name: /Blank template/ }));
    await user.type(screen.getByLabelText("Display name"), "Shared plugin");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank&tab=permissions") as ReturnType<
        typeof useSearchParams
      >,
    );
    view.rerenderPage();
    await user.click(screen.getByRole("combobox", { name: "Add access" }));
    await user.click(
      await screen.findByRole("option", {
        name: "Everyone with the Member role",
      }),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Permission for Member" }),
    );
    await user.click(screen.getByRole("option", { name: "Can update" }));
    expect(create).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Create plugin" }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        initialGrants: [
          {
            subject: { type: "role", id: "member" },
            actions: ["read", "use", "update"],
          },
        ],
      }),
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty("scope");
    expect(create.mock.calls[0][0]).not.toHaveProperty("teamIds");
  });

  it("fills one page — content and access together — from the blank template", async () => {
    const user = userEvent.setup();
    const view = renderPage();

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

    // Access is available on its own tab during creation.
    expect(
      screen.queryByRole("combobox", { name: "Add access" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Permissions" })[0],
    ).toHaveAttribute("href", "/plugins/new?source=blank&tab=permissions");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank&tab=permissions") as ReturnType<
        typeof useSearchParams
      >,
    );
    view.rerenderPage();
    expect(screen.getByRole("combobox", { name: "Add access" })).toBeVisible();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank") as ReturnType<typeof useSearchParams>,
    );
    view.rerenderPage();

    const create = screen.getByRole("button", { name: /Create plugin/ });
    // An unnamed plugin is not creatable, whatever else is filled in.
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText("Display name"), "Session guard");
    expect(create).toBeEnabled();
  });
});

function boundedMarketplaceFixture() {
  return {
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
  };
}
