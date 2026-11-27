import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query", () => ({ useFeature: () => false }));
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Northstar",
}));
// Role actions and plugin grants, as the auth hooks resolve them: a scoped
// check reads the grants, any other the role.
const access = vi.hoisted(() => ({
  role: { plugin: ["read", "create"] } as Record<string, string[]>,
  grants: [] as { resource: string; action: string; scope: string }[],
  plugins: null as unknown[] | null,
  isPending: false,
  isGlobalAdmin: false,
  /** The filters the list was last asked with. */
  listFilters: undefined as { status?: string } | undefined,
  /** What the filtered list returns, when it differs from every plugin. */
  listPlugins: null as unknown[] | null,
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
  useHasPermissions: (
    permissions: Record<string, string[]>,
    scope?: string,
  ) => ({
    isPending: access.isPending,
    data: Object.entries(permissions).every(([resource, actions]) =>
      actions.every((action) =>
        scope === undefined
          ? (access.role[resource] ?? []).includes(action)
          : access.grants.some(
              (grant) =>
                grant.resource === resource &&
                grant.action === action &&
                (grant.scope === "*" || grant.scope === scope),
            ),
      ),
    ),
  }),
  useScopedCapabilities: () => ({ data: access.grants }),
  // The Agents-section tab bar at the top of the page asks which of its pages
  // this reader may open.
  usePermissionMap: () => ({
    "/agents": true,
    "/skills": true,
    "/plugins": true,
  }),
}));
vi.mock("@/lib/organization.query", () => ({
  useIsGlobalAdmin: () => ({
    isGlobalAdmin: access.isGlobalAdmin,
    isLoading: false,
  }),
}));
vi.mock("@/components/resource-scope-filter", () => ({
  ActiveFilterBadges: () => null,
  ResourceDeletedStatusFilter: () => null,
  ResourceScopeFilter: () => <button type="button">Visibility filter</button>,
  useScopeFilterParams: () => ({
    scope: undefined,
    teamIds: undefined,
    authorIds: undefined,
    excludeAuthorIds: undefined,
    excludeOtherPersonal: false,
    hasActiveScopeFilters: false,
  }),
}));
vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search plugins" />,
}));
vi.mock("./_parts/plugin-install-dialog", () => ({
  PluginInstallDialog: () => null,
}));
const deleteMutateAsync = vi.hoisted(() => vi.fn());
const restoreMutate = vi.hoisted(() => vi.fn());
const restoreMutateAsync = vi.hoisted(() => vi.fn());
const purgeMutateAsync = vi.hoisted(() => vi.fn());
vi.mock("@/lib/plugins/plugin.query", () => ({
  usePlugins: (_enabled?: boolean, filters?: { status?: string }) => {
    // The first call on the page is the list itself.
    if (filters) access.listFilters = filters;
    return {
      // The list with its filters, and the same question asked without them.
      data:
        filters && access.listPlugins
          ? access.listPlugins
          : (access.plugins ?? [PLUGIN]),
      isPending: false,
      isFetching: false,
      isLoadingError: false,
      refetch: vi.fn(),
    };
  },
  useRestorePlugins: () => ({
    mutate: restoreMutate,
    mutateAsync: restoreMutateAsync,
    isPending: false,
  }),
  usePermanentlyDeletePlugins: () => ({
    mutateAsync: purgeMutateAsync,
    isPending: false,
  }),
  useDeletePlugins: () => ({
    mutateAsync: deleteMutateAsync,
    isPending: false,
  }),
}));
vi.mock("@/lib/entity-labels.query");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PluginsPage from "./page.client";

const PLUGIN = vi.hoisted(() => ({
  id: "plugin-1",
  organizationId: "org-1",
  authorId: "user-1",
  scope: "org",
  clientType: "claude-code",
  supportedPlatforms: ["posix", "windows"],
  pluginSlug: "policy-runtime",
  displayName: "Policy Runtime",
  description: "Applies approved policy hooks.",
  contentHash: "hash-1",
  sourceKind: "github",
  sourceRepo: "acme/policy-plugins",
  sourceRef: "main",
  sourceSha: "abc123",
  sourceSubdir: null,
  sourceExclude: [],
  sourceMarketplaceRepo: "acme/policy-plugins",
  sourceMarketplacePath: ".claude-plugin/marketplace.json",
  sourceMarketplacePluginName: "policy-runtime",
  githubSyncInterval: "1h",
  githubSyncRef: "main",
  lastSyncedAt: "2026-08-23T18:00:00.000Z",
  pendingSourceSha: null,
  pendingContentHash: null,
  pendingDetectedAt: null,
  sourceId: "default-policy-runtime",
  approvedContentHash: "hash-1",
  approvedAt: null,
  approvedBy: null,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-23T18:00:00.000Z",
  deletedAt: null,
  teams: [],
  users: [],
  fileCount: 13,
}));

describe("PluginsPage", () => {
  beforeEach(() => {
    localStorage.removeItem("archestra-plugins-view");
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/plugins");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    access.role = { plugin: ["read", "create"] };
    access.grants = [
      { resource: "plugin", action: "read", scope: PLUGIN.id },
      { resource: "plugin", action: "use", scope: PLUGIN.id },
    ];
    access.plugins = null;
    access.isPending = false;
    access.isGlobalAdmin = false;
    access.listFilters = undefined;
    access.listPlugins = null;
    vi.clearAllMocks();
  });

  it("offers adding a plugin to a role that may only create plugins", () => {
    access.role = { plugin: ["create"] };
    render(<PluginsPage />);
    expect(
      screen.getByRole("link", { name: /Add new plugin/ }),
    ).toHaveAttribute("href", "/plugins/new");
  });

  it("opens the page that adds the first plugin when there are none to list", () => {
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    access.plugins = [];
    access.role = { plugin: ["create"] };
    render(<PluginsPage />);

    // Replaced, so Back does not return to a page that sends forward again.
    expect(replace).toHaveBeenCalledWith("/plugins/new");
    // Nothing of a list, and no landing panel, on the way there.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Extend your agent")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Add new plugin/ }),
    ).not.toBeInTheDocument();
  });

  it("stays on the list while plugins exist", () => {
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    access.role = { plugin: ["read", "create"] };
    render(<PluginsPage />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Policy Runtime")).toBeVisible();
  });

  it("waits for permissions before sending anyone on or showing the reader message", () => {
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    access.plugins = [];
    access.role = {};
    access.isPending = true;
    render(<PluginsPage />);

    expect(replace).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Your admins haven't shared a plugin yet."),
    ).not.toBeInTheDocument();
  });

  it("tells a reader without plugin:create who shares plugins, and sends them nowhere", () => {
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    access.plugins = [];
    access.role = { plugin: ["read"] };
    render(<PluginsPage />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("No plugins yet")).toBeVisible();
    expect(
      screen.getByText("Your admins haven't shared a plugin yet."),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Add new plugin/ }),
    ).not.toBeInTheDocument();
  });

  it("opens a listed plugin without edit access, and offers bulk actions only as far as its grants go", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
    const user = userEvent.setup();
    render(<PluginsPage />);

    await user.click(screen.getByText("acme/policy-plugins", { exact: false }));
    expect(push).toHaveBeenCalledWith(`/plugins/${PLUGIN.id}`);

    await user.click(screen.getByRole("checkbox", { name: /Policy Runtime/ }));
    expect(screen.getByRole("button", { name: "Install" })).not.toHaveAttribute(
      "aria-disabled",
    );
    for (const name of ["Add access", "Delete"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
  });

  it("groups related facts into a compact table", async () => {
    render(<PluginsPage />);

    for (const name of ["Plugin", "Details", "Actions"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    for (const removed of [
      "Client",
      "Platforms",
      "Compatibility",
      "Source",
      "Activity",
    ]) {
      expect(
        screen.queryByRole("columnheader", { name: removed }),
      ).not.toBeInTheDocument();
    }
    const pluginRow = screen.getByText("Policy Runtime").closest("tr");
    expect(pluginRow).not.toHaveTextContent("13 files");
    await userEvent.hover(
      screen.getByRole("button", { name: "GitHub source details" }),
    );
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("13 files");
    expect(tooltip).toHaveTextContent(/Last updated: Aug 23, 2026/);
  });

  it("shows source details in cards without navigating when the icon is clicked", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
    render(<PluginsPage />);

    await user.click(screen.getByRole("button", { name: "View as cards" }));
    const source = screen.getByRole("button", {
      name: "GitHub source details",
    });
    await user.hover(source);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Synced every hour from GitHub");
    expect(tooltip).toHaveTextContent("13 files");
    expect(tooltip).toHaveTextContent(/Last updated: Aug 23, 2026/);

    await user.click(source);
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps secondary filters behind More filters until applied", async () => {
    const user = userEvent.setup();
    render(<PluginsPage />);

    expect(
      screen.queryByRole("combobox", { name: "Filter by platform" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More filters" }));

    expect(
      screen.getByRole("combobox", { name: "Filter by platform" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Filter by source" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Filter by repository" }),
    ).toBeVisible();
  });

  it("clears the active label filter", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("labels=region%3Anorth") as ReturnType<
        typeof useSearchParams
      >,
    );

    render(<PluginsPage />);

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(push).toHaveBeenCalledWith("/plugins?", { scroll: false });
  });
  describe("with more plugins than one page holds", () => {
    const names = Array.from(
      { length: 25 },
      (_, index) => `Plugin ${String(index + 1).padStart(2, "0")}`,
    );
    beforeEach(() => {
      access.plugins = names.map((displayName, index) => ({
        ...PLUGIN,
        id: `plugin-${index + 1}`,
        displayName,
        pluginSlug: `plugin-${index + 1}`,
        sourceKind: "manual",
        sourceRepo: null,
        sourceMarketplaceRepo: null,
        // Newest first is the reverse of the names, so an order taken from
        // the update time would show.
        updatedAt: new Date(Date.UTC(2026, 7, 1 + index)).toISOString(),
      }));
    });
    const shownNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("span.font-medium")?.textContent);

    it("opens the page named in the URL, so a reload or a shared link shows the same rows", () => {
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams("page=3") as ReturnType<typeof useSearchParams>,
      );

      render(<PluginsPage />);

      expect(shownNames()).toEqual(names.slice(20));
    });

    it("writes the page to the URL when the pager moves", async () => {
      const push = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
      } as unknown as ReturnType<typeof useRouter>);
      render(<PluginsPage />);

      // The pager is drawn once per breakpoint; either copy moves the page.
      await userEvent.click(
        screen.getAllByRole("button", { name: "Go to next page" })[0],
      );

      expect(push).toHaveBeenCalledWith("/plugins?page=2&pageSize=10", {
        scroll: false,
      });
    });

    it("starts a narrowed list from its first page", async () => {
      const push = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
      } as unknown as ReturnType<typeof useRouter>);
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams("page=3") as ReturnType<typeof useSearchParams>,
      );
      // jsdom has no pointer capture or scrolling, which the select asks for.
      Element.prototype.hasPointerCapture = vi.fn(() => false);
      Element.prototype.releasePointerCapture = vi.fn();
      Element.prototype.scrollIntoView = vi.fn();
      const user = userEvent.setup();
      render(<PluginsPage />);

      await user.click(
        screen.getByRole("combobox", { name: "Filter by client" }),
      );
      await user.click(screen.getByRole("option", { name: "Codex" }));

      expect(push).toHaveBeenCalledWith("/plugins?client=codex", {
        scroll: false,
      });
    });

    it("lists by name in the table, the order the cards use too", () => {
      render(<PluginsPage />);

      expect(shownNames()).toEqual(names.slice(0, 10));
    });
  });

  it("asks once before deleting: the title asks, the text says what stays behind", async () => {
    access.grants.push({
      resource: "plugin",
      action: "delete",
      scope: PLUGIN.id,
    });
    render(<PluginsPage />);

    await userEvent.click(
      screen.getByRole("button", { name: "Delete Policy Runtime" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Delete plugin?" });
    expect(dialog).toHaveTextContent(
      "Installed copies of Policy Runtime stay on developer machines until you uninstall them.",
    );
    // Named in plain text, as the skills delete dialog names a skill.
    expect(
      within(dialog).queryByRole("link", { name: "Policy Runtime" }),
    ).toBeNull();
    // Someone who does not manage every plugin has no Deleted view to open.
    expect(dialog).toHaveTextContent("An admin can restore deleted plugins.");
    expect(within(dialog).queryByRole("link", { name: "Deleted" })).toBeNull();
    expect(dialog).not.toHaveTextContent('Delete "Policy Runtime"?');
  });

  it("tells a reader who manages every plugin where a deleted plugin comes back from", async () => {
    access.grants.push(
      { resource: "plugin", action: "delete", scope: "*" },
      { resource: "plugin", action: "update", scope: "*" },
    );
    render(<PluginsPage />);

    await userEvent.click(
      screen.getByRole("button", { name: "Delete Policy Runtime" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Delete plugin?" });
    expect(dialog).toHaveTextContent(
      "You can restore deleted plugins from the Deleted filter on this page.",
    );
    // The plain deleted view: the list's filters are left behind.
    expect(
      within(dialog).getByRole("link", { name: "Deleted" }),
    ).toHaveAttribute("href", "/plugins?page=1&status=deleted");
  });

  it("says when plugins exist that only admin access shows, and offers them, instead of calling the list empty", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    // Nothing is the viewer's own or shared with them; one plugin is
    // readable through admin access alone.
    access.listPlugins = [];
    render(<PluginsPage />);

    expect(
      screen.getByText("No plugins are yours or shared with you."),
    ).toBeVisible();
    expect(
      screen.getByText("1 plugin is visible to you with Admin access."),
    ).toBeVisible();
    expect(screen.queryByText("No plugins yet.")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Show with Admin access" }),
    );
    expect(push).toHaveBeenCalledWith(
      "/plugins?access=mine%2Cshared%2Corg%2Cothers",
      { scroll: false },
    );
  });

  it("opens the same confirmation from the bulk bar as from a row", async () => {
    access.grants.push({ resource: "plugin", action: "delete", scope: "*" });
    access.plugins = [
      PLUGIN,
      { ...PLUGIN, id: "plugin-2", displayName: "Second plugin" },
    ];
    deleteMutateAsync.mockResolvedValue({
      succeeded: [{ id: PLUGIN.id, name: PLUGIN.displayName }],
      failed: [],
    });
    const user = userEvent.setup();
    render(<PluginsPage />);
    const bulkDelete = () =>
      screen.getByRole("button", { name: "Delete", exact: true } as never);

    // One ticked plugin: word for word the dialog a row's button opens.
    await user.click(
      within(
        screen.getByText("Policy Runtime").closest("tr") as HTMLElement,
      ).getByRole("checkbox"),
    );
    await user.click(bulkDelete());
    const one = screen.getByRole("dialog", { name: "Delete plugin?" });
    expect(one).toHaveTextContent(
      "Installed copies of Policy Runtime stay on developer machines until you uninstall them.",
    );
    expect(one).not.toHaveTextContent("Delete 1 plugin");
    expect(within(one).getByRole("button", { name: "Delete" })).toBeVisible();
    expect(
      within(one).queryByRole("button", { name: "Delete plugins" }),
    ).not.toBeInTheDocument();

    await user.click(within(one).getByRole("button", { name: "Delete" }));
    expect(deleteMutateAsync).toHaveBeenCalledWith([
      { id: PLUGIN.id, name: PLUGIN.displayName },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    // Several: the same dialog, with the count in the title.
    await user.click(
      within(
        screen.getByText("Policy Runtime").closest("tr") as HTMLElement,
      ).getByRole("checkbox"),
    );
    await user.click(
      within(
        screen.getByText("Second plugin").closest("tr") as HTMLElement,
      ).getByRole("checkbox"),
    );
    await user.click(bulkDelete());
    const two = screen.getByRole("dialog", { name: "Delete 2 plugins?" });
    expect(two).toHaveTextContent(
      "Installed copies of Policy Runtime and Second plugin stay on developer machines until you uninstall them.",
    );
    expect(within(two).getByRole("button", { name: "Delete" })).toBeVisible();
  });

  it("puts every row action on the row, with no one-item menu", () => {
    access.grants.push({
      resource: "plugin",
      action: "delete",
      scope: PLUGIN.id,
    });
    render(<PluginsPage />);

    expect(
      screen.getByRole("button", { name: "Delete Policy Runtime" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /More actions/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a repository filter that came from the URL, even when no plugin is from it", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("sourceRepo=nobody/nothing") as ReturnType<
        typeof useSearchParams
      >,
    );

    render(<PluginsPage />);

    // Applied, so it sits on the bar and names the repository it filters by.
    expect(
      screen.getByRole("combobox", { name: "Filter by repository" }),
    ).toHaveTextContent("nobody/nothing");
    expect(
      screen.getByText("No plugins match the current filters."),
    ).toBeVisible();
  });
  it("names an imported plugin's repository in both views, and shows no source line for one written in the app", () => {
    access.plugins = [
      PLUGIN,
      {
        ...PLUGIN,
        id: "plugin-2",
        displayName: "Handwritten",
        sourceKind: "manual",
        sourceRepo: null,
        sourceMarketplaceRepo: null,
      },
    ];
    const { unmount } = render(<PluginsPage />);

    const imported = screen.getByText("Policy Runtime").closest("tr");
    const handwritten = screen.getByText("Handwritten").closest("tr");
    expect(imported).toHaveTextContent("acme/policy-plugins");
    expect(handwritten).not.toHaveTextContent("Manual");
    expect(
      screen.queryByRole("button", { name: "Manual source details" }),
    ).not.toBeInTheDocument();

    // The cards say the repository in words too, not only as a mark.
    unmount();
    localStorage.setItem("archestra-plugins-view", "cards");
    render(<PluginsPage />);
    expect(screen.getByText("acme/policy-plugins")).toBeVisible();
    expect(screen.queryByText("Manual")).not.toBeInTheDocument();
    // And the platforms, which the cards used to leave out.
    expect(
      screen.getAllByRole("img", {
        name: "Supported platforms: macOS and Linux, Windows",
      }),
    ).toHaveLength(2);
  });
  describe("the deleted view", () => {
    const openDeleted = () =>
      vi
        .mocked(useSearchParams)
        .mockReturnValue(
          new URLSearchParams("status=deleted") as ReturnType<
            typeof useSearchParams
          >,
        );
    const manageEveryPlugin = () =>
      access.grants.push(
        { resource: "plugin", action: "update", scope: "*" },
        { resource: "plugin", action: "delete", scope: "*" },
      );
    const row = () =>
      screen.getByText("Policy Runtime").closest("tr") as HTMLElement;

    it("lists the trash for a reader who manages every plugin, with a way back and a way out on each row", async () => {
      openDeleted();
      manageEveryPlugin();
      access.isGlobalAdmin = true;
      const push = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
        replace: vi.fn(),
      } as unknown as ReturnType<typeof useRouter>);
      const user = userEvent.setup();
      render(<PluginsPage />);

      expect(access.listFilters).toMatchObject({ status: "deleted" });
      // A deleted plugin has nothing to install or edit, and no page to open.
      expect(
        within(row()).queryByRole("button", { name: /^Install/ }),
      ).toBeNull();
      expect(within(row()).queryByRole("link", { name: /^Edit/ })).toBeNull();
      await user.click(screen.getByText("Policy Runtime"));
      expect(push).not.toHaveBeenCalled();

      await user.click(
        within(row()).getByRole("button", { name: "Restore Policy Runtime" }),
      );
      expect(restoreMutate).toHaveBeenCalledExactlyOnceWith([
        { id: PLUGIN.id, name: PLUGIN.displayName },
      ]);

      // Permanent delete asks first, and names the plugin.
      purgeMutateAsync.mockResolvedValue({
        succeeded: [{ id: PLUGIN.id, name: PLUGIN.displayName }],
        failed: [],
      });
      await user.click(
        within(row()).getByRole("button", {
          name: "Delete permanently Policy Runtime",
        }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Delete plugin permanently",
      });
      expect(dialog).toHaveTextContent("Permanent deletion can not be undone.");
      expect(purgeMutateAsync).not.toHaveBeenCalled();
      await user.click(
        within(dialog).getByRole("button", { name: "Delete permanently" }),
      );
      expect(purgeMutateAsync).toHaveBeenCalledExactlyOnceWith([
        { id: PLUGIN.id, name: PLUGIN.displayName },
      ]);
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    });

    it("restores the ticked plugins from the bulk bar, and offers permanent delete only to an admin", async () => {
      openDeleted();
      manageEveryPlugin();
      restoreMutateAsync.mockResolvedValue({
        succeeded: [{ id: PLUGIN.id, name: PLUGIN.displayName }],
        failed: [],
      });
      const user = userEvent.setup();
      render(<PluginsPage />);

      await user.click(within(row()).getByRole("checkbox"));
      // The live list's actions are not what a deleted plugin is ticked for.
      expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      // Manages every plugin, but holds no built-in admin role.
      expect(
        screen.queryByRole("button", { name: "Delete permanently" }),
      ).toBeNull();

      await user.click(screen.getByRole("button", { name: "Restore" }));
      expect(restoreMutateAsync).toHaveBeenCalledExactlyOnceWith([
        { id: PLUGIN.id, name: PLUGIN.displayName },
      ]);
      await waitFor(() =>
        expect(within(row()).getByRole("checkbox")).not.toBeChecked(),
      );
    });

    it("shows the live list to a reader who does not manage every plugin", () => {
      openDeleted();
      render(<PluginsPage />);

      // The deleted list is never asked for: it would only come back refused.
      expect(access.listFilters?.status).toBeUndefined();
      expect(
        within(row()).queryByRole("button", { name: /^Restore/ }),
      ).toBeNull();
    });
  });
});
