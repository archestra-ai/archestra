import {
  archestraApiClient,
  PLUGIN_MARKETPLACE_IMPORT_LIMIT,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("filters the popular marketplaces by search", () => {
    vi.useFakeTimers();
    try {
      renderPage();

      fireEvent.change(screen.getByPlaceholderText(/Search marketplaces/), {
        target: { value: "superpowers" },
      });

      // Exercise the real debounce without racing the suite's wall-clock load.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(
        screen.queryByRole("button", {
          name: /anthropics\/claude-plugins-official/,
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /obra\/superpowers-marketplace/ }),
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a repository with nothing to import apart from one it could not read", async () => {
    const user = userEvent.setup();
    renderPage();
    const scan = async () => {
      await user.click(screen.getByRole("button", { name: "Find plugins" }));
    };
    await user.click(screen.getByRole("button", { name: /Git repository/ }));
    await user.click(screen.getByRole("button", { name: /^GitHub/ }));
    expect(
      await screen.findByRole("radio", { name: /Public repository/ }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(
      screen.getByPlaceholderText("github.com/owner/repo"),
      "acme/plugins",
    );

    // Read fine, holds no plugins: its access is not the thing to change.
    discoverMock.mockResolvedValue({
      data: { entries: [], reason: "No plugins found in the repository" },
      errorMessage: null,
      errorCode: null,
    });
    await scan();
    expect(
      await screen.findByText("No plugins found in the repository."),
    ).toBeVisible();
    expect(screen.queryByText(/Private\?/)).not.toBeInTheDocument();

    // Not found: a private repository is the likely reason, and the
    // repository's name is not repeated back.
    discoverMock.mockResolvedValue({
      data: null,
      errorMessage: "Repository acme/plugins was not found.",
      errorCode: "git_repository_not_found",
    });
    await scan();
    expect(
      await screen.findByText("Couldn’t find the repository."),
    ).toBeVisible();
    expect(screen.getByText("Private? Change the access above.")).toBeVisible();
    expect(screen.queryByText(/acme\/plugins was not found/)).toBeNull();

    // The host's request limit: the access is not the thing to change.
    discoverMock.mockResolvedValue({
      data: null,
      errorMessage:
        "Could not read acme/plugins: the host's request limit is used up. Try again later.",
      errorCode: "git_host_rate_limited",
    });
    await scan();
    expect(
      await screen.findByText("Couldn’t read the repository."),
    ).toBeVisible();
    expect(
      screen.getByText("The host’s request limit is used up. Try again later."),
    ).toBeVisible();
    expect(screen.queryByText(/Private\?/)).not.toBeInTheDocument();

    // Any other failure shows what the server said.
    discoverMock.mockResolvedValue({
      data: null,
      errorMessage: "Marketplace manifest is not valid JSON",
      errorCode: null,
    });
    await scan();
    expect(
      await screen.findByText("Marketplace manifest is not valid JSON"),
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
    // The payload's one file is open in the workspace's explorer.
    expect(
      within(screen.getByRole("navigation", { name: "Files" })).getByRole(
        "button",
        { name: "hooks.json" },
      ),
    ).toHaveAttribute("aria-current", "page");
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
    await openBlankTemplate(user, view);
    await user.type(screen.getByLabelText("Display name"), "Shared plugin");
    await user.type(
      screen.getByRole("textbox", { name: "File contents" }),
      "{{}",
    );
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
    await user.click(screen.getByRole("option", { name: "Can edit" }));
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

    await openBlankTemplate(user, view);

    const displayName = screen.getByLabelText("Display name");
    expect(displayName).toBeVisible();
    expect(screen.getByTestId("plugin-platforms")).toHaveTextContent(
      "posix,windows",
    );
    // The starter files of the default client are there to edit from, with
    // the README, which explains them, open.
    const explorer = within(screen.getByRole("navigation", { name: "Files" }));
    expect(explorer.getByRole("button", { name: "README.md" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const name of ["plugin.json", "hooks.json", "SKILL.md"]) {
      expect(explorer.getByRole("button", { name })).toBeVisible();
    }
    expect(
      screen.getByRole("button", { name: "New file or folder" }),
    ).toBeVisible();
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

    // Refused with its reason readable, not natively disabled: a disabled
    // button could not say why.
    const create = () => screen.getByRole("button", { name: /Create plugin/ });
    // An unnamed plugin is not creatable, whatever else is filled in.
    expect(create()).toHaveAttribute("aria-disabled", "true");
    expect(create()).toHaveAccessibleDescription("Enter a display name.");

    // The starter files have content, so a name is all that is missing.
    await user.type(screen.getByLabelText("Display name"), "Session guard");
    expect(create()).toBeEnabled();
    expect(create()).not.toHaveAttribute("aria-disabled");
    // The starter files follow the name for as long as they are untouched.
    expect(
      (
        screen.getByRole("textbox", {
          name: "File contents",
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("# Session guard");
  });

  it("goes back to Source by URL, so a later visit opens General, not the last tab", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank&tab=permissions") as ReturnType<
        typeof useSearchParams
      >,
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Back" }));

    // The bare path drops `tab` with `source`; the tab used to stay behind
    // in the URL and reopen with the next visit to the form.
    expect(vi.mocked(useRouter)().push).toHaveBeenCalledWith("/plugins/new");
  });

  it("says when another plugin for the same client already has the name", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank") as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePlugins).mockReturnValue({
      data: [
        { id: "p1", displayName: "Session Guard", clientType: "claude-code" },
      ],
    } as unknown as ReturnType<typeof usePlugins>);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("Display name"), "session guard");

    expect(screen.getByText("Name already in use")).toBeVisible();
  });

  it("refuses a name one of the author's own plugins for the client already has", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank") as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePlugins).mockReturnValue({
      data: [
        {
          id: "p1",
          displayName: "Session Guard",
          clientType: "claude-code",
          authorId: "user-1",
        },
      ],
    } as unknown as ReturnType<typeof usePlugins>);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("Display name"), "session guard");
    await user.type(
      screen.getByRole("textbox", { name: "File contents" }),
      "{{}",
    );

    // Everything else is filled in; the name alone holds Create back.
    const create = screen.getByRole("button", { name: /Create plugin/ });
    expect(create).toHaveAttribute("aria-disabled", "true");
    expect(create).toHaveAccessibleDescription(
      "Name is already in use. Try another one.",
    );
  });

  it("does not call the name taken by the plugin it has just created", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank") as ReturnType<typeof useSearchParams>,
    );
    const user = userEvent.setup();
    const view = renderPage();
    await user.type(screen.getByLabelText("Display name"), "Session guard");

    // The create has succeeded and the list has been re-read, while the page
    // is still on screen before the navigation to the new plugin.
    vi.mocked(useCreatePlugin).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      data: { id: "created-plugin" },
    } as unknown as ReturnType<typeof useCreatePlugin>);
    vi.mocked(usePlugins).mockReturnValue({
      data: [
        {
          id: "created-plugin",
          displayName: "Session guard",
          clientType: "claude-code",
          authorId: "user-1",
        },
      ],
    } as unknown as ReturnType<typeof usePlugins>);
    view.rerenderPage();

    expect(
      screen.queryByText("Name is already in use. Try another one."),
    ).not.toBeInTheDocument();
  });

  it("explains plugins, with no list to go back to, while there are none", () => {
    // The default here: the plugin list is empty.
    renderPage();

    expect(
      screen.getByRole("heading", { name: "Extend your agent" }),
    ).toBeVisible();
    expect(
      screen.getByText(/A plugin can bundle reusable instructions/),
    ).toHaveTextContent(
      "A plugin can bundle reusable instructions in form of skills, executable scripts, and hooks in any combination to extend functionality of your agent. Add ready plugins from marketplaces or create your own. Then install with a single command.",
    );
    expect(
      screen.queryByRole("link", { name: "Plugins" }),
    ).not.toBeInTheDocument();
  });

  it("drops the explanation and links back to the list once a plugin exists", () => {
    vi.mocked(usePlugins).mockReturnValue({
      data: [
        { id: "p1", displayName: "Session Guard", clientType: "claude-code" },
      ],
    } as unknown as ReturnType<typeof usePlugins>);
    renderPage();

    expect(screen.queryByText("Extend your agent")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plugins" })).toHaveAttribute(
      "href",
      "/plugins",
    );
  });

  it("holds the source step until it knows whether plugins exist, so nothing jumps", () => {
    vi.mocked(usePlugins).mockReturnValue({
      data: undefined,
      isPending: true,
      isFetching: true,
    } as unknown as ReturnType<typeof usePlugins>);
    renderPage();

    expect(
      screen.queryByRole("button", { name: /Blank template/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Extend your agent")).not.toBeInTheDocument();
  });

  it("asks before a link elsewhere drops a started draft", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("source=blank") as ReturnType<typeof useSearchParams>,
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <a href="/skills">Skills</a>
        <NewPluginPage />
      </QueryClientProvider>,
    );

    // An untouched form has nothing to lose.
    await user.click(screen.getByRole("link", { name: "Skills" }));
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Display name"), "Draft");
    await user.click(screen.getByRole("link", { name: "Skills" }));
    expect(screen.getByText("Discard unsaved changes?")).toBeVisible();
    expect(vi.mocked(useRouter)().push).not.toHaveBeenCalledWith("/skills");

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(vi.mocked(useRouter)().push).toHaveBeenCalledWith("/skills");
  });
});

/**
 * The wizard's step lives in the URL: choosing the blank template navigates,
 * and the page shows the form once the URL says so.
 */
async function openBlankTemplate(
  user: ReturnType<typeof userEvent.setup>,
  view: { rerenderPage: () => void },
) {
  await user.click(screen.getByRole("button", { name: /Blank template/ }));
  expect(vi.mocked(useRouter)().push).toHaveBeenCalledWith(
    "/plugins/new?source=blank",
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("source=blank") as ReturnType<typeof useSearchParams>,
  );
  view.rerenderPage();
}

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
