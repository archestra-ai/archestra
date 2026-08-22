import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { McpServerAttentionList } from "./mcp-server-attention-list";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";

const {
  deleteMutateAsync,
  dismissMutateAsync,
  restoreMutate,
  restoreMutateAsync,
} = vi.hoisted(() => ({
  deleteMutateAsync: vi.fn(),
  dismissMutateAsync: vi.fn(),
  restoreMutate: vi.fn(),
  restoreMutateAsync: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-me" } } }),
  useHasPermissions: (permissions: Record<string, unknown>) => ({
    data: "mcpServerInstallation" in permissions,
  }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useDismissMcpServerAlerts: () => ({
    mutateAsync: dismissMutateAsync,
    isPending: false,
  }),
  useRestoreMcpServerAlerts: () => ({
    mutate: restoreMutate,
    mutateAsync: restoreMutateAsync,
    isPending: false,
  }),
  useDeleteMcpServer: () => ({
    mutateAsync: deleteMutateAsync,
    isPending: false,
  }),
}));

const item = (id: string, name: string) =>
  ({ id, name, icon: null }) as CatalogItem;

const server = (id: string, catalogId: string, name: string) =>
  ({
    id,
    catalogId,
    name,
    ownerId: "user-me",
    assignedAgents: [],
    autoModeAgents: [],
  }) as unknown as InstalledServer;

const reauthIssue = ({
  catalogId,
  serverId,
  muted = false,
  audience = "you",
}: {
  catalogId: string;
  serverId: string;
  muted?: boolean;
  audience?: "you" | "others";
}): McpServerIssue => ({
  kind: "needs-reauth",
  audience,
  catalogId,
  serverId,
  detail: null,
  since: null,
  fingerprint: `v1:needs-reauth:${serverId}`,
  muted,
  mutedReason: muted ? "Deferred" : null,
});

const failedIssue = (catalogId: string, serverId: string): McpServerIssue => ({
  kind: "failed-to-start",
  audience: "you",
  catalogId,
  serverId,
  detail: "exit code 1",
  since: null,
  fingerprint: `v1:failed-to-start:${serverId}`,
  muted: false,
  mutedReason: null,
});

const reauthTarget = (catalogId: string, serverId: string, name: string) => ({
  catalogId,
  catalogName: name,
  serverId,
  serverName: name,
  kind: "needs-reauth" as const,
  issueFingerprint: `v1:needs-reauth:${serverId}`,
});

const renderWithQuery = (ui: ReactElement) => {
  const client = new QueryClient();
  const result = render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
  return {
    ...result,
    rerenderWithQuery(next: ReactElement) {
      result.rerender(
        <QueryClientProvider client={client}>{next}</QueryClientProvider>,
      );
    },
  };
};

describe("McpServerAttentionList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dismissMutateAsync.mockResolvedValue({
      succeeded: [reauthTarget("cat-1", "srv-1", "First server")],
      failed: [],
    });
    restoreMutateAsync.mockResolvedValue({
      succeeded: [reauthTarget("cat-1", "srv-1", "First server")],
      failed: [],
    });
    deleteMutateAsync.mockResolvedValue(undefined);
  });

  it("selects dismissible rows and applies one reason in bulk", async () => {
    const user = userEvent.setup();
    const first = item("cat-1", "First server");
    const second = item("cat-2", "Second server");
    const firstServer = server("srv-1", first.id, first.name);
    const secondServer = server("srv-2", second.id, second.name);

    renderWithQuery(
      <McpServerAttentionList
        items={[first, second]}
        issuesByCatalog={
          new Map([
            [
              first.id,
              [reauthIssue({ catalogId: first.id, serverId: "srv-1" })],
            ],
            [second.id, [failedIssue(second.id, "srv-2")]],
          ])
        }
        servers={[firstServer, secondServer]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    for (const name of ["MCP Server", "Issue", "Owner", "Actions"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("columnheader", { name: "Issue types" }),
    ).toBeNull();
    expect(
      screen.queryByRole("columnheader", { name: "Connections" }),
    ).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Since" })).toBeNull();

    const firstRow = screen.getByRole("row", { name: /First server/ });
    const secondRow = screen.getByRole("row", { name: /Second server/ });
    for (const row of [firstRow, secondRow]) {
      expect(
        within(within(row).getByRole("group")).getAllByRole("button"),
      ).toHaveLength(3);
    }
    expect(
      within(firstRow).queryByRole("button", {
        name: "Show issue details for First server",
      }),
    ).toBeNull();

    expect(
      screen.getByRole("checkbox", { name: "Select all alerts" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Second server" }),
    ).toBeEnabled();

    await user.click(
      screen.getByRole("checkbox", { name: "Select First server" }),
    );
    expect(screen.getByText("MCP server selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss selected" }));
    expect(
      screen.getByRole("heading", { name: "Dismiss alert" }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Reason (optional)" }),
      "Owner is away",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(dismissMutateAsync).toHaveBeenCalledWith({
        alerts: [reauthTarget("cat-1", "srv-1", "First server")],
        reason: "Owner is away",
      }),
    );
    expect(
      screen.getByText("Select MCP servers to apply bulk actions"),
    ).toBeInTheDocument();
  });

  it("renders the same server metadata as the All-facet name column", () => {
    const catalog = {
      ...item("cat-1", "Documentation reader"),
      description: "Reads current product documentation",
    } as CatalogItem;
    const connection = server("srv-1", catalog.id, catalog.name);

    renderWithQuery(
      <McpServerAttentionList
        items={[catalog]}
        issuesByCatalog={
          new Map([[catalog.id, [failedIssue(catalog.id, connection.id)]]])
        }
        servers={[connection]}
        facet="you"
        tableContext={{
          getServerInfo: () => ({ installedServer: connection }),
          envLabelByCatalog: new Map([[catalog.id, "Production"]]),
          deploymentFeedState: "disabled",
          deploymentStatuses: {},
          installingItemId: null,
          onInstall: vi.fn(),
        }}
        onReinstall={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Reads current product documentation"),
    ).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
  });

  it("shows the complete owner identity instead of truncating it", () => {
    const catalog = item("cat-1", "Documentation reader");
    const connection = {
      ...server("srv-1", catalog.id, catalog.name),
      ownerEmail: "admin@example.com",
    } as InstalledServer;

    renderWithQuery(
      <McpServerAttentionList
        items={[catalog]}
        issuesByCatalog={
          new Map([[catalog.id, [failedIssue(catalog.id, connection.id)]]])
        }
        servers={[connection]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    const owner = screen.getByText("admin@example.com");
    expect(owner).toHaveClass("break-words");
    expect(owner).not.toHaveClass("truncate");
  });

  it("removes every selected connection after one bulk confirmation", async () => {
    const user = userEvent.setup();
    const first = item("cat-1", "First server");
    const second = item("cat-2", "Second server");
    const firstServer = server("srv-1", first.id, first.name);
    const secondServer = server("srv-2", second.id, second.name);

    renderWithQuery(
      <McpServerAttentionList
        items={[first, second]}
        issuesByCatalog={
          new Map([
            [first.id, [failedIssue(first.id, firstServer.id)]],
            [second.id, [failedIssue(second.id, secondServer.id)]],
          ])
        }
        servers={[firstServer, secondServer]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    const removeSelected = screen.getByRole("button", {
      name: "Remove connections",
    });
    expect(removeSelected).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: "Select all alerts" }),
    );
    expect(removeSelected).toBeEnabled();
    await user.click(removeSelected);

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Uninstall MCP Servers" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("First server")).toBeInTheDocument();
    expect(within(dialog).getByText("Second server")).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Uninstall selected" }),
    );

    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledTimes(2));
    expect(deleteMutateAsync).toHaveBeenNthCalledWith(1, {
      id: firstServer.id,
      name: firstServer.name,
    });
    expect(deleteMutateAsync).toHaveBeenNthCalledWith(2, {
      id: secondServer.id,
      name: secondServer.name,
    });
    expect(
      screen.getByRole("checkbox", { name: "Select all alerts" }),
    ).not.toBeChecked();
  });

  it("disables bulk removal when a selected catalog-scope issue is ambiguous", async () => {
    const user = userEvent.setup();
    const catalog = item("cat-1", "Shared provider");
    const issue = {
      ...failedIssue(catalog.id, "unused"),
      serverId: undefined,
    };

    renderWithQuery(
      <McpServerAttentionList
        items={[catalog]}
        issuesByCatalog={new Map([[catalog.id, [issue]]])}
        servers={[
          server("srv-1", catalog.id, "First connection"),
          server("srv-2", catalog.id, "Second connection"),
        ]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Select Shared provider" }),
    );
    const removeSelected = screen.getByRole("button", {
      name: "Remove connections",
    });
    expect(removeSelected).toBeDisabled();
    expect(removeSelected).toHaveAttribute(
      "title",
      "Every selected row must identify connections you can remove",
    );
  });

  it("dismisses a failed-to-start alert in bulk", async () => {
    const user = userEvent.setup();
    const catalog = item("cat-1", "Documentation reader");
    const connection = server("srv-1", catalog.id, catalog.name);
    const target = {
      catalogId: catalog.id,
      catalogName: catalog.name,
      serverId: connection.id,
      serverName: connection.name,
      kind: "failed-to-start" as const,
      issueFingerprint: `v1:failed-to-start:${connection.id}`,
    };
    dismissMutateAsync.mockResolvedValue({ succeeded: [target], failed: [] });
    renderWithQuery(
      <McpServerAttentionList
        items={[catalog]}
        issuesByCatalog={
          new Map([[catalog.id, [failedIssue(catalog.id, connection.id)]]])
        }
        servers={[connection]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: `Select ${catalog.name}` }),
    );
    await user.click(screen.getByRole("button", { name: "Dismiss selected" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reason (optional)" }),
      "Scheduled for next week",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(dismissMutateAsync).toHaveBeenCalledWith({
        alerts: [target],
        reason: "Scheduled for next week",
      }),
    );
  });

  it("uses an indeterminate select-all state and selects every eligible row", async () => {
    const user = userEvent.setup();
    const first = item("cat-1", "First server");
    const second = item("cat-2", "Second server");

    renderWithQuery(
      <McpServerAttentionList
        items={[first, second]}
        issuesByCatalog={
          new Map([
            [
              first.id,
              [reauthIssue({ catalogId: first.id, serverId: "srv-1" })],
            ],
            [
              second.id,
              [reauthIssue({ catalogId: second.id, serverId: "srv-2" })],
            ],
          ])
        }
        servers={[
          server("srv-1", first.id, first.name),
          server("srv-2", second.id, second.name),
        ]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Select First server" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Select all alerts" }),
      ).toBePartiallyChecked(),
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Select all alerts" }),
    );
    expect(screen.getByText("MCP servers selected")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select First server" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Second server" }),
    ).toBeChecked();
  });

  it("deduplicates repeated issue kinds in the Status cell", () => {
    const catalog = item("cat-1", "Shared provider");
    renderWithQuery(
      <McpServerAttentionList
        items={[catalog]}
        issuesByCatalog={
          new Map([
            [
              catalog.id,
              [
                reauthIssue({ catalogId: catalog.id, serverId: "srv-1" }),
                reauthIssue({ catalogId: catalog.id, serverId: "srv-2" }),
              ],
            ],
          ])
        }
        servers={[
          server("srv-1", catalog.id, "First connection"),
          server("srv-2", catalog.id, "Second connection"),
        ]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    const row = screen.getByRole("row", { name: /Shared provider/ });
    expect(within(row).getAllByText("Needs re-authentication")).toHaveLength(1);
    expect(within(row).queryByText(/more/)).toBeNull();
  });

  it("does not attribute a grouped row to one of several actors", () => {
    const catalog = item("cat-1", "Shared provider");
    const first = {
      ...server("srv-1", catalog.id, "First connection"),
      ownerId: "owner-1",
      ownerEmail: "first@example.com",
    } as InstalledServer;
    const second = {
      ...server("srv-2", catalog.id, "Second connection"),
      ownerId: "owner-2",
      ownerEmail: "second@example.com",
    } as InstalledServer;
    renderWithQuery(
      <McpServerAttentionList
        items={[catalog]}
        issuesByCatalog={
          new Map([
            [
              catalog.id,
              [
                reauthIssue({
                  catalogId: catalog.id,
                  serverId: first.id,
                  audience: "others",
                }),
                reauthIssue({
                  catalogId: catalog.id,
                  serverId: second.id,
                  audience: "others",
                }),
              ],
            ],
          ])
        }
        servers={[first, second]}
        facet="others"
        onReinstall={vi.fn()}
      />,
    );

    const row = screen.getByRole("row", { name: /Shared provider/ });
    expect(within(row).getByText("Multiple actors")).toBeInTheDocument();
    expect(within(row).queryByText("first@example.com")).toBeNull();
  });

  it("shows every distinct issue kind in the Status cell", () => {
    const catalog = item("cat-1", "Multi-issue server");
    const connection = server("srv-1", catalog.id, catalog.name);
    renderWithQuery(
      <McpServerAttentionList
        items={[catalog]}
        issuesByCatalog={
          new Map([
            [
              catalog.id,
              [
                failedIssue(catalog.id, connection.id),
                reauthIssue({
                  catalogId: catalog.id,
                  serverId: connection.id,
                }),
              ],
            ],
          ])
        }
        servers={[connection]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    const row = screen.getByRole("row", { name: /Multi-issue server/ });
    expect(within(row).getByText("Failed to start")).toBeInTheDocument();
    expect(
      within(row).getByText("Needs re-authentication"),
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", {
        name: "Show issue details for Multi-issue server",
      }),
    ).toBeNull();
  });

  it("keeps failed rows selected when a bulk dismissal only partly succeeds", async () => {
    const user = userEvent.setup();
    const first = item("cat-1", "First server");
    const second = item("cat-2", "Second server");
    dismissMutateAsync.mockResolvedValue({
      succeeded: [reauthTarget(first.id, "srv-1", first.name)],
      failed: [reauthTarget(second.id, "srv-2", second.name)],
    });

    const view = renderWithQuery(
      <McpServerAttentionList
        items={[first, second]}
        issuesByCatalog={
          new Map([
            [
              first.id,
              [reauthIssue({ catalogId: first.id, serverId: "srv-1" })],
            ],
            [
              second.id,
              [reauthIssue({ catalogId: second.id, serverId: "srv-2" })],
            ],
          ])
        }
        servers={[
          server("srv-1", first.id, first.name),
          server("srv-2", second.id, second.name),
        ]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Select all alerts" }),
    );
    await user.click(screen.getByRole("button", { name: "Dismiss selected" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reason (optional)" }),
      "Deferred",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(
      await screen.findByRole("heading", { name: "Dismiss alert" }),
    ).toBeInTheDocument();
    // The successful row leaves the facet when the refetch completes. The
    // failed connection remains selected for a retry.
    view.rerenderWithQuery(
      <McpServerAttentionList
        items={[second]}
        issuesByCatalog={
          new Map([
            [
              second.id,
              [reauthIssue({ catalogId: second.id, serverId: "srv-2" })],
            ],
          ])
        }
        servers={[server("srv-2", second.id, second.name)]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("checkbox", { name: "Select First server" }),
    ).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Select Second server" }),
    ).toBeChecked();
    expect(screen.getByText("MCP server selected")).toBeInTheDocument();
  });

  it("does not retarget a selected row to a newly failing connection", async () => {
    const user = userEvent.setup();
    const first = item("cat-1", "First server");
    const firstConnection = server("srv-1", first.id, "First connection");
    const secondConnection = server("srv-2", first.id, "Second connection");
    const view = renderWithQuery(
      <McpServerAttentionList
        items={[first]}
        issuesByCatalog={
          new Map([
            [
              first.id,
              [reauthIssue({ catalogId: first.id, serverId: "srv-1" })],
            ],
          ])
        }
        servers={[firstConnection, secondConnection]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Select First server" }),
    );
    expect(
      screen.getByRole("button", { name: "Dismiss selected" }),
    ).toBeEnabled();

    view.rerenderWithQuery(
      <McpServerAttentionList
        items={[first]}
        issuesByCatalog={
          new Map([
            [
              first.id,
              [reauthIssue({ catalogId: first.id, serverId: "srv-2" })],
            ],
          ])
        }
        servers={[firstConnection, secondConnection]}
        facet="you"
        onReinstall={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: "Select First server" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Dismiss selected" }),
    ).toBeDisabled();
  });

  it("does not revive selection after leaving and returning to a filter", async () => {
    const user = userEvent.setup();
    const first = item("cat-1", "First server");
    const issues = new Map([
      [first.id, [reauthIssue({ catalogId: first.id, serverId: "srv-1" })]],
    ]);
    const renderScope = (scope: string) => (
      <McpServerAttentionList
        key={scope}
        items={[first]}
        issuesByCatalog={issues}
        servers={[server("srv-1", first.id, first.name)]}
        facet="you"
        onReinstall={vi.fn()}
      />
    );
    const view = renderWithQuery(renderScope("status=needs-my-action"));

    await user.click(
      screen.getByRole("checkbox", { name: "Select First server" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select First server" }),
    ).toBeChecked();

    view.rerenderWithQuery(renderScope("status=needs-my-action&search=none"));
    expect(
      screen.getByRole("checkbox", { name: "Select First server" }),
    ).not.toBeChecked();

    view.rerenderWithQuery(renderScope("status=needs-my-action"));
    expect(
      screen.getByRole("checkbox", { name: "Select First server" }),
    ).not.toBeChecked();
  });

  it("restores a selected dismissed alert without opening a menu", async () => {
    const user = userEvent.setup();
    const first = item("cat-1", "First server");

    renderWithQuery(
      <McpServerAttentionList
        items={[first]}
        issuesByCatalog={
          new Map([
            [
              first.id,
              [
                reauthIssue({
                  catalogId: first.id,
                  serverId: "srv-1",
                  muted: true,
                }),
              ],
            ],
          ])
        }
        servers={[server("srv-1", first.id, first.name)]}
        facet="muted"
        onReinstall={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Select First server" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore selected" }));

    await waitFor(() =>
      expect(restoreMutateAsync).toHaveBeenCalledWith({
        alerts: [reauthTarget("cat-1", "srv-1", "First server")],
      }),
    );
  });

  it("shows supplied and empty dismissal reasons in the Dismissed table", () => {
    const first = item("cat-1", "First server");
    const second = item("cat-2", "Second server");
    const withReason = reauthIssue({
      catalogId: first.id,
      serverId: "srv-1",
      muted: true,
    });
    const withoutReason = {
      ...reauthIssue({
        catalogId: second.id,
        serverId: "srv-2",
        muted: true,
      }),
      mutedReason: null,
    };

    renderWithQuery(
      <McpServerAttentionList
        items={[first, second]}
        issuesByCatalog={
          new Map([
            [first.id, [withReason]],
            [second.id, [withoutReason]],
          ])
        }
        servers={[
          server("srv-1", first.id, first.name),
          server("srv-2", second.id, second.name),
        ]}
        facet="muted"
        onReinstall={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("columnheader", { name: "Dismiss reason" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("columnheader")
        .map((header) => header.textContent?.trim()),
    ).toEqual([
      "",
      "MCP Server",
      "Dismiss reason",
      "Issue",
      "Owner",
      "Actions",
    ]);
    expect(
      within(screen.getByRole("row", { name: /First server/ })).getByText(
        "Deferred",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /Second server/ })).getByText("—"),
    ).toBeInTheDocument();
  });
});
