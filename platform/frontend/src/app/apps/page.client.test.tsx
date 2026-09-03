import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "@/components/filter-bar";
import { TableCardView } from "@/components/table-card-view";
import { AppSection, matchesKind } from "./page.client";

vi.mock("next/navigation");

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/app.query", () => ({
  useAppLabelKeys: () => ({ data: [] }),
  useAppLabelValues: () => ({ data: [] }),
  useApps: () => ({ data: undefined }),
  useBulkDeleteApps: () => ({ isPending: false, mutate: vi.fn() }),
  useBulkUpdateAppVisibility: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useOpenAppInChat: () => ({ mutateAsync: vi.fn() }),
  useOpenExternalAppInChat: () => ({ mutateAsync: vi.fn() }),
  usePinApp: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));

const { appAccessState } = vi.hoisted(() => ({
  appAccessState: { canEdit: true, canDeleteApp: true },
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

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("./_parts/app-delete-dialog", () => ({
  AppDeleteDialog: () => null,
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => <span />,
}));

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
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

const ownedApp: Extract<AppListItem, { source: "owned" }> = {
  source: "owned",
  createdBy: null,
  id: "owned-1",
  slug: "my-owned-app",
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

describe("AppSection cards", () => {
  it("selects an owned card and shows the shared bulk actions bar", () => {
    renderAppSection();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select My Owned App" }),
    );

    expect(
      screen.getByText("1 app selected", { selector: '[aria-hidden="true"]' }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Edit visibility" }),
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

  it("shift-selects owned card ranges while skipping an external MCP app", () => {
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

  it("keeps Sharing compact while the app name absorbs table width", () => {
    const { container } = renderAppSection([ownedApp], "table");

    expect(container.querySelector('th[data-column-id="sharing"]')).toHaveStyle(
      { width: "160px" },
    );
    expect(
      (container.querySelector('th[data-column-id="name"]') as HTMLElement)
        .style.width,
    ).toBe("");
  });
});

function renderAppSection(
  apps: AppListItem[] = [ownedApp, externalApp],
  defaultMode: "cards" | "table" = "cards",
) {
  return render(
    <TableCardView
      storageKey={`apps-test-view-${defaultMode}`}
      defaultMode={defaultMode}
    >
      <FilterBar>
        <span>Filters</span>
      </FilterBar>
      <AppSection title="Apps" apps={apps} onOpenSettings={vi.fn()} />
    </TableCardView>,
  );
}
