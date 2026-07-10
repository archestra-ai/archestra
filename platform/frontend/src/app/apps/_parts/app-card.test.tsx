import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { takePendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { AppCard } from "./app-card";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

const { pushMock, openExternalMutate } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  openExternalMutate: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation");

vi.mock("@/lib/app.query", () => ({
  useOpenAppInChat: () => ({ mutateAsync: vi.fn() }),
  useOpenExternalAppInChat: () => ({ mutateAsync: openExternalMutate }),
  usePinApp: () => ({ mutate: vi.fn() }),
  // The card hosts the shared AppSettingsDialog, which reads the app by id.
  useApp: () => ({ data: undefined }),
}));

vi.mock("@/lib/auth/auth.query");

// Stub the delete dialog so the card test asserts it opens, not its internals.
vi.mock("./app-delete-dialog", () => ({
  AppDeleteDialog: ({ open, app }: { open: boolean; app: { name: string } }) =>
    open ? <div data-testid="delete-dialog">Delete {app.name}</div> : null,
}));

// Stub the catalog icon (its real render pulls appearance settings via react
// query); the card test only asserts which icon value flows into it.
vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: ({ icon }: { icon?: string | null }) => (
    <span data-testid="mcp-catalog-icon">{icon ?? "generic-server-icon"}</span>
  ),
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

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({
    push: pushMock,
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
});

const ownedApp: Extract<AppListItem, { source: "owned" }> = {
  source: "owned",
  id: "owned-1",
  name: "My Owned App",
  description: "An owned app",
  scope: "org",
  authorId: "user-1",
  latestVersion: 1,
  teams: [],
  executionModel: "viewer-scoped",
  cspOrigin: "platform-pinned",
  pinnedAt: null,
};

const externalApp: Extract<AppListItem, { source: "external" }> = {
  source: "external",
  catalogId: "cat-1",
  mcpServerId: "srv-1",
  scope: "org",
  // "<server> / <tool>" as the title, the tool's description as the subtitle.
  name: "Archestra PM / show_board",
  description: "Shows the project board",
  resourceUri: "ui://pm/board.html",
  executionModel: "server-scoped",
  cspOrigin: "author-declared",
  pinnedAt: null,
  icon: null,
  requiresInput: false,
};

describe("ExternalAppCard", () => {
  beforeEach(() => {
    pushMock.mockReset();
    openExternalMutate.mockReset();
  });

  it("titles the card '<server> / <tool>' (not a slug) with the tool description and scope", () => {
    render(<AppCard app={externalApp} />);

    expect(screen.getByText("Archestra PM / show_board")).toBeInTheDocument();
    expect(screen.getByText("Shows the project board")).toBeInTheDocument();
    expect(screen.queryByText(/archestra_pm/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("MCP server app")).toBeInTheDocument();
    // Per-install card carries an icon-only scope pill (label in aria/tooltip)
    // to disambiguate sibling installs.
    expect(screen.getByLabelText("Organization")).toBeInTheDocument();
  });

  it("opens the install in chat and navigates to the seeded conversation", async () => {
    openExternalMutate.mockResolvedValue({
      conversationId: "conv-1",
      mode: "render",
    });
    render(<AppCard app={externalApp} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Archestra PM / show_board in new chat",
      }),
    );

    expect(openExternalMutate).toHaveBeenCalledWith({
      mcpServerId: "srv-1",
      resourceUri: "ui://pm/board.html",
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chat/conv-1"));
    // A seeded render needs no opening prompt.
    expect(takePendingProjectChatHandoff("conv-1")).toBeNull();
  });

  it("stashes the opening prompt for prompt-mode opens (tool needs inputs)", async () => {
    openExternalMutate.mockResolvedValue({
      conversationId: "conv-2",
      mode: "prompt",
      prompt: "Open the Archestra PM / show_board app.",
    });
    render(<AppCard app={externalApp} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Archestra PM / show_board in new chat",
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chat/conv-2"));
    // The prompt rides the pending-chat handoff so /chat/<id> sends it as the
    // conversation's first user message (which triggers the model turn).
    expect(takePendingProjectChatHandoff("conv-2")).toEqual({
      conversationId: "conv-2",
      prompt: "Open the Archestra PM / show_board app.",
    });
  });

  it("links 'Open in new tab' to the install-pinned run page and 'Manage MCP server'", () => {
    render(<AppCard app={externalApp} />);

    const expectedRun =
      "/a/catalog/cat-1?install=srv-1&resource=ui%3A%2F%2Fpm%2Fboard.html";

    const newTab = screen.getByRole("link", { name: /open in new tab/i });
    expect(newTab).toHaveAttribute("href", expectedRun);
    expect(newTab).toHaveAttribute("target", "_blank");

    expect(
      screen.getByRole("link", { name: /manage mcp server/i }),
    ).toHaveAttribute("href", "/mcp/registry/cat-1");
  });

  it("hides 'Open in new tab' when the tool needs inputs (prompt-mode only)", () => {
    render(<AppCard app={{ ...externalApp, requiresInput: true }} />);

    // The standalone run page can't render a tool that needs inputs, so the
    // card offers only the chat flow.
    expect(
      screen.queryByRole("link", { name: /open in new tab/i }),
    ).not.toBeInTheDocument();
    // The rest of the menu is unaffected.
    expect(
      screen.getByRole("link", { name: /manage mcp server/i }),
    ).toBeInTheDocument();
  });

  it("shows the server's registry icon, falling back to the generic glyph without one", () => {
    const { rerender } = render(
      <AppCard app={{ ...externalApp, icon: "🗂️" }} />,
    );
    expect(screen.getByTestId("mcp-catalog-icon")).toHaveTextContent("🗂️");

    rerender(<AppCard app={externalApp} />);
    expect(screen.getByTestId("mcp-catalog-icon")).toHaveTextContent(
      "generic-server-icon",
    );
  });
});

describe("OwnedAppCard", () => {
  it("exposes a standalone link and a delete action", () => {
    render(<AppCard app={ownedApp} />);

    expect(screen.getByText("My Owned App")).toBeInTheDocument();
    expect(screen.getByLabelText("MCP app")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open in new tab/i }),
    ).toHaveAttribute("href", "/a/owned-1");

    expect(screen.queryByTestId("delete-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(screen.getByTestId("delete-dialog")).toHaveTextContent(
      "Delete My Owned App",
    );
  });

  it("folds team names into the scope pill's label", () => {
    render(
      <AppCard
        app={{
          ...ownedApp,
          scope: "team",
          teams: [{ id: "t1", name: "London HQ" }],
        }}
      />,
    );

    expect(screen.getByLabelText("Team: London HQ")).toBeInTheDocument();
  });

  it("hides the scope pill for personal apps", () => {
    render(<AppCard app={{ ...ownedApp, scope: "personal", teams: [] }} />);

    expect(screen.queryByLabelText("Personal")).not.toBeInTheDocument();
  });
});
