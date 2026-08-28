import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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
});

function renderAppSection(apps: AppListItem[] = [ownedApp, externalApp]) {
  return render(
    <TableCardView storageKey="apps-test-view" defaultMode="cards">
      <FilterBar>
        <span>Filters</span>
      </FilterBar>
      <AppSection title="Apps" apps={apps} onOpenSettings={vi.fn()} />
    </TableCardView>,
  );
}
