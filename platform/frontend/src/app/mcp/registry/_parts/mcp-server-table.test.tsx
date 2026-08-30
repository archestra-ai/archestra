import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useReinstallInternalMcpCatalogItem: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("./catalog-edit-access", () => ({
  useCanModifyCatalogItem: () => ({ canModify: false, isLoading: false }),
}));

vi.mock("./use-chat-with-catalog-item", () => ({
  useChatWithCatalogItem: () => ({ startChat: vi.fn(), isCreating: false }),
}));

const {
  dismissMutateAsync,
  restoreMutate,
  restoreMutateAsync,
  useMcpServersMock,
} = vi.hoisted(() => ({
  dismissMutateAsync: vi.fn(),
  restoreMutate: vi.fn(),
  restoreMutateAsync: vi.fn(),
  useMcpServersMock: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useBulkUninstallMcpServers: () => ({ mutate: vi.fn(), isPending: false }),
  useMcpServers: useMcpServersMock,
  useDismissMcpServerAlerts: () => ({
    mutateAsync: dismissMutateAsync,
    isPending: false,
  }),
  useRestoreMcpServerAlerts: () => ({
    mutate: restoreMutate,
    mutateAsync: restoreMutateAsync,
    isPending: false,
  }),
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import type { Permissions } from "@archestra/shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { useAppearanceSettings } from "@/lib/organization.query";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerTable } from "./mcp-server-table";

const CURRENT_USER_ID = "user-me";

const item = {
  id: "cat-1",
  name: "some-remote-server",
  serverType: "remote",
  icon: null,
  description: null,
  toolCount: 0,
  environmentId: null,
  imageApprovalRequired: false,
  multitenant: false,
  catalogReinstallRequired: false,
} as unknown as CatalogItem;

const personalInstall = {
  id: "srv-1",
  catalogId: "cat-1",
  name: "some-remote-server",
  ownerId: CURRENT_USER_ID,
  teamId: null,
  serverType: "remote",
  reinstallRequired: false,
  assignedAgents: [],
  users: [CURRENT_USER_ID],
  createdAt: new Date().toISOString(),
} as unknown as InstalledServer;

const renderTable = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

/** Grant every permission except the ones named. */
const grantAllExcept = (denied: Permissions) => {
  const deniedKeys = Object.entries(denied).flatMap(([resource, actions]) =>
    (actions ?? []).map((action: string) => `${resource}:${action}`),
  );
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions: Permissions) =>
      ({
        data: !Object.entries(permissions ?? {}).some(([resource, actions]) =>
          (actions ?? []).some((action: string) =>
            deniedKeys.includes(`${resource}:${action}`),
          ),
        ),
      }) as unknown as ReturnType<typeof useHasPermissions>,
  );
};

const table = (
  <McpServerTable
    items={[item]}
    getServerInfo={() => ({ installedServer: personalInstall })}
    envLabelByCatalog={new Map()}
    issuesByCatalog={new Map()}
    deploymentFeedState="ready"
    deploymentStatuses={{}}
    installingItemId={null}
    onInstall={vi.fn()}
    onReinstall={vi.fn()}
  />
);

describe("McpServerTable uninstall permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: CURRENT_USER_ID } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useFeature).mockReturnValue(
      false as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
    useMcpServersMock.mockReturnValue({ data: [personalInstall] });
    dismissMutateAsync.mockResolvedValue({ succeeded: [], failed: [] });
    grantAllExcept({});
  });

  it("opens the uninstall dialog for a user who may delete their connection", async () => {
    const user = userEvent.setup();
    renderTable(table);

    await user.click(
      screen.getByRole("button", { name: "Uninstall some-remote-server" }),
    );

    expect(await screen.findByText("Uninstall MCP Server")).toBeInTheDocument();
  });

  it("refuses the uninstall for a user without the delete permission", async () => {
    const user = userEvent.setup();
    grantAllExcept({ mcpServerInstallation: ["delete"] });
    renderTable(table);

    const uninstall = screen.getByRole("button", { name: /Uninstall/ });
    expect(uninstall).toHaveAttribute("aria-disabled", "true");

    await user.click(uninstall);

    expect(screen.queryByText("Uninstall MCP Server")).not.toBeInTheDocument();
  });

  it("moves local runtime state to an icon dot and keeps Status installation-only", async () => {
    const user = userEvent.setup();
    const localItem = {
      ...item,
      id: "cat-local",
      serverType: "local",
    } as CatalogItem;
    const localInstall = {
      ...personalInstall,
      id: "srv-local",
      catalogId: localItem.id,
      serverType: "local",
    } as InstalledServer;

    renderTable(
      <McpServerTable
        items={[localItem]}
        getServerInfo={() => ({ installedServer: localInstall })}
        envLabelByCatalog={new Map()}
        issuesByCatalog={new Map()}
        deploymentFeedState="ready"
        deploymentStatuses={{
          [localInstall.id]: {
            state: "hibernated",
            message: "Hibernated",
            error: null,
          },
        }}
        installingItemId={null}
        onInstall={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.queryByText("Hibernated")).not.toBeInTheDocument();
    const statusDot = screen.getByRole("img", {
      name: "Runtime status: Hibernated",
    });
    await user.hover(statusDot);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Hibernated. Scaled down after being idle",
    );
    expect(
      screen.getAllByRole("link", { name: /Learn more/ }),
    ).not.toHaveLength(0);
  });

  it("keeps queue actions inline without triggering row navigation", async () => {
    const user = userEvent.setup();
    const issue = {
      kind: "needs-reauth",
      audience: "you",
      catalogId: item.id,
      serverId: personalInstall.id,
      detail: null,
      since: null,
      fingerprint: "v1:needs-reauth:test",
      muted: false,
      mutedReason: null,
    } satisfies McpServerIssue;

    renderTable(
      <McpServerTable
        items={[item]}
        getServerInfo={() => ({ installedServer: personalInstall })}
        envLabelByCatalog={new Map()}
        issuesByCatalog={new Map([[item.id, [issue]]])}
        deploymentFeedState="ready"
        deploymentStatuses={{}}
        installingItemId={null}
        onInstall={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    const dismiss = screen.getByRole("button", {
      name: "Dismiss alert some-remote-server",
    });
    expect(screen.getByText("Needs re-authentication")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "The provider rejected the stored token, so this connection's tools fail.",
      ),
    ).toBeNull();
    await user.click(dismiss);
    expect(
      screen.getByRole("heading", { name: "Dismiss alert" }),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Dismiss alert" }),
      ).not.toBeInTheDocument(),
    );
    expect(routerPush).not.toHaveBeenCalled();

    expect(
      screen.getByRole("link", {
        name: "Re-authenticate some-remote-server",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: "Credentials some-remote-server",
      }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "More actions some-remote-server",
      }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Credentials" }),
    ).toBeInTheDocument();
  });
});
