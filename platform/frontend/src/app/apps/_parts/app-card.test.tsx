import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCard } from "./app-card";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/app.query", () => ({
  useOpenAppInChat: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));

// Stub the delete dialog so the card test asserts it opens, not its internals.
vi.mock("./app-delete-dialog", () => ({
  AppDeleteDialog: ({ open, app }: { open: boolean; app: { name: string } }) =>
    open ? <div data-testid="delete-dialog">Delete {app.name}</div> : null,
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
    <div role="menu">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    variant,
  }: {
    children: ReactNode;
    onSelect?: (e: { preventDefault: () => void }) => void;
    variant?: string;
  }) => (
    <div
      role="menuitem"
      data-variant={variant}
      tabIndex={0}
      onClick={(e) => onSelect?.(e)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onSelect?.(e);
        }
      }}
    >
      {children}
    </div>
  ),
}));

const ownedApp: Extract<AppListItem, { source: "owned" }> = {
  source: "owned",
  id: "owned-1",
  name: "My Owned App",
  description: "An owned app",
  scope: "org",
  authorId: "user-1",
  latestVersion: 1,
  executionModel: "viewer-scoped",
  cspOrigin: "platform-pinned",
};

const externalApp: Extract<AppListItem, { source: "external" }> = {
  source: "external",
  catalogId: "cat-1",
  // "<server> / <tool>" as the title, the tool's description as the subtitle.
  name: "Archestra PM / show_board",
  description: "Shows the project board",
  resourceUri: "ui://pm/board.html",
  runnable: true,
  availabilityScopes: ["org"],
  executionModel: "server-scoped",
  cspOrigin: "author-declared",
};

describe("ExternalAppCard", () => {
  it("titles the card '<server> / <tool>' (not a slug) with the tool description", () => {
    render(<AppCard app={externalApp} currentUserId="user-1" />);

    expect(screen.getByText("Archestra PM / show_board")).toBeInTheDocument();
    expect(screen.getByText("Shows the project board")).toBeInTheDocument();
    expect(screen.queryByText(/archestra_pm/)).not.toBeInTheDocument();
    expect(screen.getByText("MCP server")).toBeInTheDocument();
  });

  it("opens the specific ui:// resource and links 'Manage MCP server'", () => {
    render(<AppCard app={externalApp} currentUserId="user-1" />);

    const expectedRun =
      "/apps/catalog/cat-1/run?resource=ui%3A%2F%2Fpm%2Fboard.html";

    expect(
      screen.getByRole("link", { name: "Open Archestra PM / show_board" }),
    ).toHaveAttribute("href", expectedRun);

    const newTab = screen.getByRole("link", { name: /open in new tab/i });
    expect(newTab).toHaveAttribute("href", expectedRun);
    expect(newTab).toHaveAttribute("target", "_blank");

    expect(
      screen.getByRole("link", { name: /manage mcp server/i }),
    ).toHaveAttribute("href", "/mcp/registry/beta/cat-1");
  });

  it("makes a non-runnable app non-clickable with an install CTA", () => {
    render(
      <AppCard app={{ ...externalApp, runnable: false }} currentUserId="u" />,
    );

    // No whole-card open link, and no overflow menu (its lone action would just
    // duplicate the install CTA).
    expect(
      screen.queryByRole("link", { name: /^open /i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /more actions/i }),
    ).not.toBeInTheDocument();
    // A clear footer CTA points at the server page to install.
    expect(
      screen.getByRole("link", { name: /install mcp server to run/i }),
    ).toHaveAttribute("href", "/mcp/registry/beta/cat-1");
  });
});

describe("OwnedAppCard", () => {
  it("exposes a standalone link and a delete action", () => {
    render(<AppCard app={ownedApp} currentUserId="user-1" />);

    expect(screen.getByText("My Owned App")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open in new tab/i }),
    ).toHaveAttribute("href", "/a/owned-1");

    expect(screen.queryByTestId("delete-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(screen.getByTestId("delete-dialog")).toHaveTextContent(
      "Delete My Owned App",
    );
  });
});
