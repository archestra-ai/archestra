import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { McpServerIssueNotice } from "./mcp-server-issue-notice";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: routerPush }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-me" } } }),
  // The fixture may edit the catalog but is not an installations admin, so
  // ownership checks remain meaningful in the "others" tests.
  useHasPermissions: (permissions: Record<string, unknown>) => ({
    data: "mcpRegistry" in permissions,
  }),
}));

const { dismissMutateAsync, restoreMutate } = vi.hoisted(() => ({
  dismissMutateAsync: vi.fn(),
  restoreMutate: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useDismissMcpServerAlerts: () => ({
    mutateAsync: dismissMutateAsync,
    isPending: false,
  }),
  useRestoreMcpServerAlerts: () => ({
    mutate: restoreMutate,
    isPending: false,
  }),
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

type Props = Parameters<typeof McpServerIssueNotice>[0];

// The catalog icon behind the name is query-backed.
const renderWithQuery = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

const item = {
  id: "cat-1",
  name: "crashy-test-server",
  icon: null,
} as Props["item"];

const server = {
  id: "srv-1",
  catalogId: "cat-1",
  name: "crashy-test-server",
  ownerId: "user-me",
  assignedAgents: [],
  autoModeAgents: [],
} as unknown as Props["servers"][number];
const backupServer = {
  ...server,
  id: "srv-2",
  name: "Backup connection",
} as unknown as Props["servers"][number];
const otherOwnerServer = {
  ...server,
  ownerId: "owner-user",
  ownerEmail: "owner@example.com",
} as unknown as Props["servers"][number];

const failedToStart = (
  detail: string,
  overrides: Partial<McpServerIssue> = {},
): McpServerIssue => ({
  kind: "failed-to-start",
  audience: "you",
  catalogId: "cat-1",
  serverId: "srv-1",
  detail,
  since: null,
  fingerprint: "v1:failed-to-start:test",
  muted: false,
  mutedReason: null,
  ...overrides,
});

const needsReauth = (
  overrides: Partial<McpServerIssue> = {},
): McpServerIssue => ({
  kind: "needs-reauth",
  audience: "you",
  catalogId: "cat-1",
  serverId: "srv-1",
  detail: null,
  since: null,
  fingerprint: "v1:needs-reauth:test",
  muted: false,
  mutedReason: null,
  ...overrides,
});

function AttentionIssueSurface(props: Omit<Props, "variant">) {
  return (
    <>
      <McpServerIssueNotice {...props} variant="actions" />
      <McpServerIssueNotice {...props} variant="details" />
    </>
  );
}

/** The table owns the row; this component owns its actions and expanded body. */
describe("McpServerIssueNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dismissMutateAsync.mockImplementation(async ({ alerts }) => ({
      succeeded: alerts,
      failed: [],
    }));
  });
  it("shows every applicable flagged-row action directly", () => {
    renderWithQuery(
      <AttentionIssueSurface
        item={item}
        issues={[
          failedToStart("exit code 1"),
          needsReauth({ detail: "invalid_grant" }),
        ]}
        servers={[server]}
      />,
    );

    expect(screen.getByText("The server could not start.")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "View logs crashy-test-server",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Dismiss alerts crashy-test-server",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Check the logs for the error/)).toBeTruthy();
    expect(screen.getByText("exit code 1")).toBeTruthy();
    expect(
      screen.getByText(
        "The refresh token is invalid, expired, or has been revoked",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Edit configuration crashy-test-server",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Re-authenticate crashy-test-server",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Remove this connection crashy-test-server",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "More actions crashy-test-server",
      }),
    ).toBeNull();
  });

  it("opens the affected connection inline on the credentials tab", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <McpServerIssueNotice
        variant="actions"
        item={item}
        issues={[needsReauth()]}
        servers={[server]}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Re-authenticate crashy-test-server",
      }),
    );

    expect(routerPush).toHaveBeenCalledWith(
      "/mcp/registry/cat-1?tab=credentials&server=srv-1",
    );
  });

  it("keeps the expanded diagnosis informational", () => {
    renderWithQuery(
      <McpServerIssueNotice
        variant="details"
        item={item}
        issues={[failedToStart("exit code 1")]}
        servers={[server]}
      />,
    );

    expect(
      screen.getByText(/Check the logs for the error/),
    ).toBeInTheDocument();
    expect(screen.getByText("exit code 1")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps and disambiguates same-named remediation for different connections", () => {
    const duplicateNameServer = {
      ...backupServer,
      name: "Shared connection",
    } as Props["servers"][number];
    renderWithQuery(
      <McpServerIssueNotice
        variant="actions"
        item={item}
        issues={[
          failedToStart("first failure"),
          failedToStart("second failure", {
            kind: "not-running",
            serverId: duplicateNameServer.id,
            fingerprint: "v1:not-running:backup",
          }),
        ]}
        servers={[server, duplicateNameServer]}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "View logs for Shared connection crashy-test-server",
      }),
    ).toBeInTheDocument();
  });

  it("explains every kind in the viewer's bucket, not only the worst one", () => {
    renderWithQuery(
      <AttentionIssueSurface
        item={item}
        issues={[
          failedToStart("exit code 1"),
          failedToStart("crash loop", {
            kind: "not-running",
            fingerprint: "v1:not-running:test",
          }),
        ]}
        servers={[server]}
      />,
    );

    expect(
      screen.getByText("The server keeps crashing after a successful install."),
    ).toBeTruthy();
  });

  it("names who can act instead of showing a button the viewer cannot press", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <AttentionIssueSurface
        item={item}
        issues={[needsReauth({ audience: "others" })]}
        servers={[otherOwnerServer]}
        facet="others"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /^Re-authenticate/ }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
    const dismiss = screen.getByRole("button", {
      name: "Dismiss alert crashy-test-server",
    });
    expect(dismiss).toHaveAccessibleName("Dismiss alert crashy-test-server");

    await user.click(dismiss);
    expect(
      screen.getByRole("heading", { name: "Dismiss alert" }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Reason (optional)" }),
      "Coordinated with owner",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissMutateAsync).toHaveBeenCalledWith({
      alerts: [
        expect.objectContaining({
          catalogId: "cat-1",
          serverId: "srv-1",
          kind: "needs-reauth",
          issueFingerprint: "v1:needs-reauth:test",
        }),
      ],
      reason: "Coordinated with owner",
    });

    expect(
      screen.queryByRole("button", {
        name: /^More actions/,
      }),
    ).toBeNull();

    expect(
      screen.getByText(
        "owner@example.com owns this connection. An MCP installation admin can also act.",
      ),
    ).toBeTruthy();
  });

  it("allows dismissal without a reason", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <McpServerIssueNotice
        variant="actions"
        item={item}
        issues={[needsReauth()]}
        servers={[server]}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Dismiss alert crashy-test-server",
      }),
    );
    expect(
      screen.queryByText(/Shown back to you on the dismissed alert/),
    ).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Reason (optional)" }),
    ).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(dismissMutateAsync).toHaveBeenCalledWith({
      alerts: [expect.objectContaining({ serverId: "srv-1" })],
    });
  });

  it("keeps a dismissed alert visible, restorable and explained", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <AttentionIssueSurface
        item={item}
        issues={[needsReauth({ muted: true })]}
        servers={[server]}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Restore alert crashy-test-server",
      }),
    ).toHaveAccessibleName("Restore alert crashy-test-server");
    expect(
      screen.getByText(
        "You dismissed this alert, so it is not counted for you.",
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Restore alert crashy-test-server",
      }),
    );
    expect(restoreMutate).toHaveBeenCalledWith(
      {
        alerts: [
          expect.objectContaining({
            catalogId: "cat-1",
            serverId: "srv-1",
            kind: "needs-reauth",
            issueFingerprint: "v1:needs-reauth:test",
          }),
        ],
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("offers only the queue action that belongs to the selected facet", () => {
    const secondServer = {
      ...server,
      id: "srv-2",
      name: "second-connection",
    };
    renderWithQuery(
      <AttentionIssueSurface
        item={item}
        issues={[
          needsReauth({ serverId: "srv-1", muted: false }),
          needsReauth({ serverId: "srv-2", muted: true }),
        ]}
        servers={[server, secondServer]}
        facet="muted"
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Dismiss alert crashy-test-server",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Restore alert crashy-test-server",
      }),
    ).toBeInTheDocument();
  });

  it("shows a raw message only in the expanded details surface", () => {
    renderWithQuery(
      <AttentionIssueSurface
        item={item}
        issues={[failedToStart("Error: boom\n    at main (index.js:1:1)")]}
        servers={[server]}
      />,
    );

    expect(screen.getByText(/at main/)).toBeTruthy();
  });

  it("panel: keeps the pill, the fix prose and both verbs", () => {
    renderWithQuery(
      <McpServerIssueNotice
        item={item}
        issues={[failedToStart("exit code 1")]}
        servers={[server]}
        hideName
      />,
    );

    expect(screen.getByText("Failed to start")).toBeTruthy();
    expect(screen.getByText(/Check the logs for the error/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "View logs" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit configuration" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
  });
});
