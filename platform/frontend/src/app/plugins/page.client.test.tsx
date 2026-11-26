import { render, screen } from "@testing-library/react";
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
vi.mock("@/components/resource-scope-filter", () => ({
  ActiveFilterBadges: () => null,
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
vi.mock("@/lib/plugins/plugin.query", () => ({
  usePlugins: () => ({
    data: access.plugins ?? [PLUGIN],
    isPending: false,
    isFetching: false,
    isLoadingError: false,
    refetch: vi.fn(),
  }),
  useBulkDeletePlugins: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePlugin: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  enabled: true,
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
  });

  it("offers adding a plugin to a role that may only create plugins", () => {
    access.role = { plugin: ["create"] };
    render(<PluginsPage />);
    expect(
      screen.getByRole("link", { name: /Add new plugin/ }),
    ).toHaveAttribute("href", "/plugins/new");
  });

  it("explains plugins to a creator on an empty page, with create and browse as the next steps", () => {
    access.plugins = [];
    access.role = { plugin: ["create"] };
    render(<PluginsPage />);

    expect(
      screen.getByText("Extend the coding tools your team already uses"),
    ).toBeVisible();
    expect(
      screen.getByText(/A skill teaches an agent how to do a task/),
    ).toHaveTextContent(
      "A plugin bundles files such as skills, commands, and hooks for one coding tool.",
    );
    expect(
      screen.getByRole("link", { name: /Create a plugin/ }),
    ).toHaveAttribute("href", "/plugins/new?source=blank");
    // The wizard's first step is where the popular marketplaces are listed.
    expect(
      screen.getByRole("link", { name: "Browse popular marketplaces" }),
    ).toHaveAttribute("href", "/plugins/new#popular-marketplaces");
    // The header keeps its line and its Add button, so the first plugin
    // doesn't shift the page.
    expect(
      screen.getByText(
        "Plugins install client-native files on developer machines.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Add new plugin/ }),
    ).toHaveAttribute("href", "/plugins/new");
  });

  it("waits for permissions before showing first-use actions or the reader message", () => {
    access.plugins = [];
    access.role = {};
    access.isPending = true;
    render(<PluginsPage />);

    expect(
      screen.getByText("Extend the coding tools your team already uses"),
    ).toBeVisible();
    expect(
      screen.queryByText("Your admins haven't shared a plugin yet."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Create a plugin/ }),
    ).not.toBeInTheDocument();
  });

  it("tells a reader without plugin:create who shares plugins instead of offering a disabled button", () => {
    access.plugins = [];
    access.role = { plugin: ["read"] };
    render(<PluginsPage />);

    expect(
      screen.getByText("Your admins haven't shared a plugin yet."),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Create a plugin/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create a plugin/ }),
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
      "Installed copies stay on developer machines until you uninstall them.",
    );
    expect(dialog).not.toHaveTextContent('Delete "Policy Runtime"?');
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
});
