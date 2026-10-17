import type { archestraApiTypes } from "@archestra/shared";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "@/components/filter-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { takePendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import AppsPage, { AppSection, matchesKind } from "./page.client";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

const { appAccessState, mocks } = vi.hoisted(() => ({
  appAccessState: { canEdit: true, canDeleteApp: true },
  mocks: {
    apps: [] as unknown[],
    push: vi.fn(),
    pin: vi.fn(),
    openOwned: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock("next/navigation");

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/app.query", () => ({
  APPS_FIRST_PAGE: { page: 1, limit: 100 },
  useAppLabelKeys: () => ({ data: [] }),
  useAppLabelValues: () => ({ data: [] }),
  useApps: () => ({
    data: { data: mocks.apps },
    isPending: false,
    isFetching: false,
    isLoadingError: false,
    refetch: vi.fn(),
  }),
  useBulkDeleteApps: () => ({ isPending: false, mutate: vi.fn() }),
  useOpenAppInChat: () => ({ mutateAsync: mocks.openOwned }),
  useOpenExternalAppInChat: () => ({ mutateAsync: mocks.openExternal }),
  usePinApp: () => ({ mutate: mocks.pin }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/apps/use-app-access", () => {
  const access = {
    isAdmin: true,
    isTeamAdmin: true,
    canUpdate: true,
    canDelete: true,
    currentUserId: "user-1",
    userTeamIds: new Set<string>(),
    isPending: false,
    canModify: true,
  };
  return {
    useAppAccessContext: () => access,
    useAppAccess: () => ({ ...access, ...appAccessState }),
    computeAppAccess: () => ({ ...access, ...appAccessState }),
    appActionDisabledReason: () =>
      appAccessState.canEdit
        ? undefined
        : "Only an admin can change this org-wide app",
  };
});

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => false,
}));

vi.mock("@/lib/teams/team.query", () => ({
  useAssignableTeams: () => ({
    data: [{ id: "leadership", name: "Leadership" }],
  }),
}));

// The page's own chrome and filters: real ones need the app shell.
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));
vi.mock("@/components/resource-list-actions", () => ({
  ResourceListActions: () => null,
}));
vi.mock("@/components/resource-access-filter", () => ({
  ResourceAccessFilter: () => null,
}));
vi.mock("@/components/resource-scope-filter", () => ({
  useScopeFilterParams: () => ({}),
}));
vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search apps" />,
}));
vi.mock("./_parts/app-create-dialog", () => ({
  AppCreateDialog: () => null,
}));
vi.mock("@/components/mcp-app/app-settings-dialog", () => ({
  AppSettingsDialog: () => null,
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    permissions: _permissions,
    permissionScope: _permissionScope,
    tooltip: _tooltip,
    ...props
  }: {
    children: ReactNode;
    permissions?: unknown;
    permissionScope?: unknown;
    tooltip?: unknown;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/mcp-app/app-version-history-dialog", () => ({
  AppVersionHistoryDialog: () => null,
}));

vi.mock("./_parts/app-delete-dialog", () => ({
  AppDeleteDialog: () => null,
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => <span />,
}));

// Render menu items directly (no Radix portal) so their links are queryable.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    asChild: _asChild,
    variant: _variant,
    onSelect: _onSelect,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
    variant?: string;
    onSelect?: unknown;
  }) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

const ownedApp: Extract<AppListItem, { source: "owned" }> = {
  source: "owned",
  createdBy: null,
  id: "owned-1",
  slug: null,
  name: "My Owned App",
  description: "An owned app",
  scope: "org",
  authorId: "user-1",
  authorName: "Ada Lovelace",
  viewerRole: "owner",
  icon: null,
  latestVersion: 1,
  enabled: true,
  locked: false,
  teams: [],
  users: [],
  executionModel: "viewer-scoped",
  cspOrigin: "platform-pinned",
  pinnedAt: null,
  labels: [],
};

const externalApp: Extract<AppListItem, { source: "external" }> = {
  source: "external",
  createdBy: null,
  catalogId: "cat-1",
  mcpServerId: "srv-1",
  scope: "org",
  name: "Archestra PM / show_board",
  description: "Shows the project board",
  resourceUri: "ui://pm/board.html",
  toolName: "show_board",
  executionModel: "server-scoped",
  cspOrigin: "author-declared",
  pinnedAt: null,
  labels: [],
  icon: null,
  requiresInput: false,
};

beforeEach(() => {
  appAccessState.canEdit = true;
  appAccessState.canDeleteApp = true;
  mocks.apps = [];
  mocks.push.mockReset();
  mocks.pin.mockReset();
  mocks.openOwned.mockReset();
  mocks.openExternal.mockReset();
  vi.mocked(useRouter).mockReturnValue({
    push: mocks.push,
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue("/apps");
});

describe("matchesKind", () => {
  it("matches every app when kind is all", () => {
    expect(matchesKind(ownedApp, "all")).toBe(true);
    expect(matchesKind(externalApp, "all")).toBe(true);
  });

  it("matches only platform-authored apps when kind is owned", () => {
    expect(matchesKind(ownedApp, "owned")).toBe(true);
    expect(matchesKind(externalApp, "owned")).toBe(false);
  });

  it("matches only MCP server apps when kind is external", () => {
    expect(matchesKind(ownedApp, "external")).toBe(false);
    expect(matchesKind(externalApp, "external")).toBe(true);
  });

  it("matches every app for an unknown kind param", () => {
    expect(matchesKind(ownedApp, "bogus")).toBe(true);
    expect(matchesKind(externalApp, "bogus")).toBe(true);
  });
});

describe("AppsPage", () => {
  it("shows pinned apps as tiles and the rest in the table", async () => {
    mocks.apps = [
      ownedApp,
      { ...externalApp, pinnedAt: "2026-01-03T00:00:00.000Z" },
    ];
    mocks.openExternal.mockResolvedValue({
      conversationId: "conv-1",
      mode: "render",
    });

    render(<AppsPage />);

    const tiles = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(tiles).getByRole("link", { name: "Archestra PM / show_board" }),
    ).toBeInTheDocument();
    expect(within(tiles).queryByText("My Owned App")).not.toBeInTheDocument();

    expect(screen.getByText("All apps")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("My Owned App")).toBeInTheDocument();
    expect(
      within(table).queryByText("Archestra PM / show_board"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(tiles).getByRole("button", {
        name: "Unpin Archestra PM / show_board",
      }),
    );
    expect(mocks.pin).toHaveBeenCalledWith({
      pinned: false,
      target: {
        source: "external",
        mcpServerId: "srv-1",
        resourceUri: "ui://pm/board.html",
        toolName: "show_board",
      },
    });

    // Open on the tile opens the app in a new chat, as its row would.
    fireEvent.click(
      within(tiles).getByRole("button", {
        name: "Open Archestra PM / show_board in new chat",
      }),
    );
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/chat/conv-1"),
    );
  });

  it("offers a pinned app's row actions, except pinning, in its tile's menu", () => {
    mocks.apps = [
      { ...ownedApp, pinnedAt: "2026-01-03T00:00:00.000Z" },
      { ...externalApp, pinnedAt: "2026-01-02T00:00:00.000Z" },
    ];

    render(<AppsPage />);

    const tiles = screen.getByRole("region", { name: "Pinned" });
    const ownedTile = tileOf(
      within(tiles).getByRole("button", { name: "More actions My Owned App" }),
    );
    for (const label of ["Settings", "Version history", "Delete"]) {
      expect(within(ownedTile).getByText(label)).toBeInTheDocument();
    }
    expect(
      within(ownedTile).getByRole("link", { name: "Open in new tab" }),
    ).toHaveAttribute("href", "/a/owned-1");

    const externalTile = tileOf(
      within(tiles).getByRole("button", {
        name: "More actions Archestra PM / show_board",
      }),
    );
    expect(
      within(externalTile).getByRole("link", { name: "Manage MCP server" }),
    ).toHaveAttribute("href", "/mcp/registry/cat-1");
    expect(
      within(externalTile).queryByText("Settings"),
    ).not.toBeInTheDocument();
    expect(within(tiles).queryByText("Pin")).not.toBeInTheDocument();
  });

  it("opens settings from a pinned owned app's tile menu", () => {
    mocks.apps = [{ ...ownedApp, pinnedAt: "2026-01-03T00:00:00.000Z" }];
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: mocks.push,
      replace,
    } as unknown as ReturnType<typeof useRouter>);

    render(<AppsPage />);

    const tile = tileOf(
      screen.getByRole("button", { name: "More actions My Owned App" }),
    );
    fireEvent.click(within(tile).getByText("Settings"));

    expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("settings=owned-1"),
      expect.anything(),
    );
  });

  it("shows no pinned tiles when nothing is pinned", () => {
    mocks.apps = [ownedApp, externalApp];

    render(<AppsPage />);

    expect(
      screen.queryByRole("region", { name: "Pinned" }),
    ).not.toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("My Owned App")).toBeInTheDocument();
    expect(
      within(table).getByText("Archestra PM / show_board"),
    ).toBeInTheDocument();
  });
});

describe("AppSection table", () => {
  it("selects an owned row and shows the shared bulk actions bar", () => {
    renderAppSection();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select My Owned App" }),
    );

    expect(
      screen.getByText("1 app selected", { selector: '[aria-hidden="true"]' }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  it("keeps an external MCP app disabled and out of the selection", () => {
    renderAppSection();

    const checkbox = screen.getByRole("checkbox", {
      name: "Select Archestra PM / show_board",
    });
    expect(checkbox).toBeDisabled();
    expect(
      screen.getByTitle("Installed apps are managed through their MCP server"),
    ).toContainElement(checkbox);

    fireEvent.click(checkbox);

    expect(screen.queryByText("1 app selected")).not.toBeInTheDocument();
  });

  it("keeps an owned app out of bulk selection when scope rules deny changes", () => {
    appAccessState.canEdit = false;
    appAccessState.canDeleteApp = false;
    renderAppSection([ownedApp]);

    const checkbox = screen.getByRole("checkbox", {
      name: "Select My Owned App",
    });
    expect(checkbox).toBeDisabled();
    expect(
      screen.getByTitle("Only an admin can change this org-wide app"),
    ).toContainElement(checkbox);

    fireEvent.click(checkbox);
    expect(screen.queryByText("1 app selected")).not.toBeInTheDocument();
  });

  it("shift-selects owned row ranges while skipping an external MCP app", () => {
    renderAppSection([
      ownedApp,
      externalApp,
      { ...ownedApp, id: "owned-2", name: "Second Owned App" },
    ]);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select My Owned App" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Second Owned App" }),
      { shiftKey: true },
    );

    expect(
      screen.getByText("2 apps selected", { selector: '[aria-hidden="true"]' }),
    ).toBeVisible();
  });

  it("opens an external app's row in chat and navigates to the seeded conversation", async () => {
    mocks.openExternal.mockResolvedValue({
      conversationId: "conv-1",
      mode: "render",
    });
    renderAppSection([externalApp]);

    fireEvent.click(screen.getByText("Archestra PM / show_board"));

    expect(mocks.openExternal).toHaveBeenCalledWith({
      mcpServerId: "srv-1",
      resourceUri: "ui://pm/board.html",
      encryptedChat: false,
    });
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/chat/conv-1"),
    );
    // A seeded render needs no opening prompt.
    expect(takePendingProjectChatHandoff("conv-1")).toBeNull();
  });

  it("stashes the opening prompt when the app's tool needs inputs", async () => {
    mocks.openExternal.mockResolvedValue({
      conversationId: "conv-2",
      mode: "prompt",
      prompt: "Open the Archestra PM / show_board app.",
    });
    renderAppSection([externalApp]);

    fireEvent.click(screen.getByText("Archestra PM / show_board"));

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/chat/conv-2"),
    );
    expect(takePendingProjectChatHandoff("conv-2")).toEqual({
      conversationId: "conv-2",
      prompt: "Open the Archestra PM / show_board app.",
    });
  });

  it("links each app to its standalone run page", () => {
    renderAppSection([{ ...ownedApp, slug: "sales-dashboard" }, externalApp]);

    expect(
      screen.getByRole("link", { name: "Open in new tab My Owned App" }),
    ).toHaveAttribute("href", "/a/sales-dashboard");
    expect(
      screen.getByRole("link", {
        name: "Open in new tab Archestra PM / show_board",
      }),
    ).toHaveAttribute(
      "href",
      "/a/catalog/cat-1?install=srv-1&resource=ui%3A%2F%2Fpm%2Fboard.html",
    );
    expect(
      screen.getByRole("link", { name: /manage mcp server/i }),
    ).toHaveAttribute("href", "/mcp/registry/cat-1");
  });

  it("offers no standalone page for a tool that needs inputs", () => {
    renderAppSection([{ ...externalApp, requiresInput: true }]);

    expect(
      screen.queryByRole("link", { name: /open in new tab/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /manage mcp server/i }),
    ).toBeInTheDocument();
  });

  it("opens settings for an owned app without opening it in chat", () => {
    const onOpenSettings = vi.fn();
    renderAppSection([ownedApp], onOpenSettings);

    fireEvent.click(
      screen.getByRole("button", { name: "Settings My Owned App" }),
    );

    expect(onOpenSettings).toHaveBeenCalledWith({ id: "owned-1" });
    expect(mocks.openOwned).not.toHaveBeenCalled();
  });
});

function tileOf(element: HTMLElement): HTMLElement {
  const tile = element.closest("li");
  if (!tile) throw new Error("not inside a pinned tile");
  return tile;
}

function renderAppSection(
  apps: AppListItem[] = [ownedApp, externalApp],
  onOpenSettings = vi.fn(),
) {
  return render(
    <BulkActionsScope>
      <FilterBar>
        <span>Filters</span>
      </FilterBar>
      <AppSection
        title="All apps"
        apps={apps}
        onOpenSettings={onOpenSettings}
      />
    </BulkActionsScope>,
  );
}
