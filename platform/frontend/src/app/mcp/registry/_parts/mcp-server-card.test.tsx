import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  usePathname: () => "/mcp/registry",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: () => ({ data: { environments: [] } }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: ({
    initialData,
  }: {
    initialData?: CatalogItem[];
  }) => ({
    data: initialData,
    isPending: false,
    isFetching: false,
  }),
  useMcpCatalogLabelKeys: () => ({ data: [] }),
  useMcpCatalogLabelValues: () => ({ data: [] }),
  useReinstallInternalMcpCatalogItem: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/mcp/use-can-reauthenticate", () => ({
  useCanReauthenticate: () => () => false,
}));

vi.mock("./catalog-edit-access", () => ({
  useCanModifyCatalogItem: () => ({ canModify: false, isLoading: false }),
}));

vi.mock("./use-chat-with-catalog-item", () => ({
  useChatWithCatalogItem: () => ({ startChat: vi.fn(), isCreating: false }),
}));

const { useMcpServersMock } = vi.hoisted(() => ({
  useMcpServersMock: vi.fn(),
}));
const { registryIssuesMock } = vi.hoisted(() => ({
  registryIssuesMock: new Map(),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: useMcpServersMock,
  useAutoModeAgents: () => ({ data: [] }),
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkUninstallMcpServers: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissMcpServerAlerts: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useMcpDeploymentStatuses: () => ({ statuses: {}, state: "ready" }),
  useMcpInstallationStatusCacheSync: vi.fn(),
  useReauthenticateMcpServer: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useReinstallMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRestoreMcpServerAlerts: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/auth/oauth.query", () => ({
  useInitiateOAuth: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/components/resource-scope-filter", () => ({
  ResourceScopeFilter: () => null,
  useScopeFilterParams: () => ({ hasActiveScopeFilters: false }),
}));

vi.mock("@/components/table-card-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/table-card-view")>()),
  TableCardGrid: ({ children }: { children: ReactElement[] }) => (
    <div data-testid="registry-card-grid">{children}</div>
  ),
  TableCardSelectionScope: ({ children }: { children: ReactElement }) =>
    children,
  TableCardView: ({ children }: { children: ReactElement }) => children,
  TableCardViewContent: ({ cards }: { cards: ReactElement }) => cards,
  TableCardViewToggle: () => null,
}));

vi.mock("@/lib/hooks/use-dialog", () => ({
  useDialogs: () => ({
    isDialogOpened: () => false,
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/use-dialog-url-param", () => ({
  useDialogUrlParam: () => ({ entity: null, close: vi.fn() }),
}));

vi.mock("@/lib/mcp/use-mcp-server-issues", () => ({
  useMcpServerIssues: () => ({
    issuesByCatalog: registryIssuesMock,
    facetCounts: { muted: 0 },
  }),
}));

vi.mock("./mcp-registry-visibility", () => ({
  hasMcpRegistryInstallForViewer: () => true,
  matchesMcpRegistryOwnershipFilters: () => true,
  mcpRegistryInstallPriority: () => 0,
}));

vi.mock("./mcp-server-table", () => ({ McpServerTable: () => null }));

vi.mock("./local-server-install-dialog", () => ({
  LocalServerInstallDialog: () => null,
}));

vi.mock("./manage-users-dialog", () => ({ ManageUsersDialog: () => null }));

vi.mock("./reinstall-confirmation-dialog", () => ({
  ReinstallConfirmationDialog: () => null,
}));

vi.mock("./remote-server-install-dialog", () => ({
  RemoteServerInstallDialog: () => null,
}));

vi.mock("@/components/oauth-confirmation-dialog", () => ({
  OAuthConfirmationDialog: () => null,
}));

vi.mock("./use-catalog-install", () => ({
  useCatalogInstall: () => ({
    installingItemId: null,
    installingServerIds: new Set(),
    setInstallingServerIds: vi.fn(),
    setInstallingItemId: vi.fn(),
    installFromSearchParams: vi.fn(),
    installRemote: vi.fn(),
    installLocal: vi.fn(),
    installPlaywright: vi.fn(),
    addPersonalConnection: vi.fn(),
    addSharedConnection: vi.fn(),
    addOrgConnection: vi.fn(),
    cancelInstallation: vi.fn(),
    dialogs: null,
  }),
}));

import type { Permissions } from "@archestra/shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import {
  useAppearanceSettings,
  useDefaultEnvironment,
} from "@/lib/organization.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { InternalMCPCatalog } from "./InternalMCPCatalog";
import {
  type CatalogItem,
  type InstalledServer,
  McpServerCard,
} from "./mcp-server-card";

const CURRENT_USER_ID = "user-me";

const item = {
  id: "cat-1",
  name: "some-remote-server",
  serverType: "remote",
  icon: null,
  toolCount: 0,
  environmentId: null,
  oauthConfig: null,
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

const renderCard = (ui: ReactElement) =>
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

const card = (
  <McpServerCard
    variant="remote"
    item={item}
    installingItemId={null}
    deploymentStatuses={{}}
    deploymentFeedState="ready"
    onInstallRemoteServer={vi.fn()}
    onInstallLocalServer={vi.fn()}
    onReinstall={vi.fn()}
  />
);

function CardSelectionHarness() {
  const items = [
    item,
    { ...item, id: "cat-2", name: "second-remote-server" },
    { ...item, id: "cat-3", name: "third-remote-server" },
  ];
  const [rowSelection, setRowSelection] = useState({});
  const cardSelection = useBulkCardSelection({
    rows: items,
    getRowId: (catalogItem) => catalogItem.id,
    rowSelection,
    setRowSelection,
  });

  return (
    <>
      {items.map((catalogItem) => (
        <McpServerCard
          key={catalogItem.id}
          variant="remote"
          item={catalogItem}
          installingItemId={null}
          deploymentStatuses={{}}
          deploymentFeedState="ready"
          onInstallRemoteServer={vi.fn()}
          onInstallLocalServer={vi.fn()}
          onReinstall={vi.fn()}
          selection={cardSelection(catalogItem)}
        />
      ))}
    </>
  );
}

describe("McpServerCard uninstall permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryIssuesMock.clear();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: CURRENT_USER_ID } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useFeature).mockReturnValue(
      false as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useAssignableTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAssignableTeams>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
    useMcpServersMock.mockReturnValue({ data: [personalInstall] });
    grantAllExcept({});
  });

  it("opens the uninstall dialog for a user who may delete their connection", async () => {
    const user = userEvent.setup();
    renderCard(card);

    await user.click(screen.getByRole("button", { name: "Uninstall" }));

    expect(await screen.findByText("Uninstall MCP Server")).toBeInTheDocument();
  });

  it("refuses the uninstall for a user without the delete permission", async () => {
    // The 403 the delete call answers with is honest, but the control should
    // not have been offered: its Install and Reinstall siblings are gated the
    // same way.
    const user = userEvent.setup();
    grantAllExcept({ mcpServerInstallation: ["delete"] });
    renderCard(card);

    const uninstall = screen.getByRole("button", { name: /Uninstall/ });
    expect(uninstall).toHaveAttribute("aria-disabled", "true");

    await user.click(uninstall);

    expect(screen.queryByText("Uninstall MCP Server")).not.toBeInTheDocument();
  });

  it("keeps image approval in the shared metadata and action layout", async () => {
    const user = userEvent.setup();
    useMcpServersMock.mockReturnValue({ data: [] });
    renderCard(
      <McpServerCard
        variant="local"
        item={{
          ...item,
          serverType: "local",
          imageApprovalRequired: true,
        }}
        installingItemId={null}
        deploymentStatuses={{}}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    expect(screen.getByText("Image needs approval")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review config" }));

    expect(routerPush).toHaveBeenCalledWith("/mcp/registry/cat-1/edit");
  });

  it("hides OAuth failure diagnostics while MCP alerting is disabled", () => {
    useMcpServersMock.mockReturnValue({
      data: [
        {
          ...personalInstall,
          oauthRefreshError: "refresh_failed",
        },
      ],
    });
    renderCard(
      <McpServerCard
        variant="remote"
        item={{ ...item, oauthConfig: {} } as unknown as CatalogItem}
        installingItemId={null}
        deploymentStatuses={{}}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("oauth-reauth-state")).toBeNull();
  });

  it("overlays a local runtime status dot on the icon with its status tooltip", async () => {
    const user = userEvent.setup();
    const localItem = {
      ...item,
      id: "cat-local",
      name: "hibernated-local-server",
      serverType: "local",
    } as CatalogItem;
    const localInstall = {
      ...personalInstall,
      id: "srv-local",
      catalogId: localItem.id,
      name: localItem.name,
      serverType: "local",
    } as InstalledServer;
    useMcpServersMock.mockReturnValue({ data: [localInstall] });

    renderCard(
      <McpServerCard
        variant="local"
        item={localItem}
        installedServer={localInstall}
        installingItemId={null}
        deploymentStatuses={{
          [localInstall.id]: {
            state: "hibernated",
            message: "Hibernated",
            error: null,
          },
        }}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    const cardElement = screen.getByTestId(
      "mcp-server-card-hibernated-local-server",
    );
    const statusDot = within(cardElement).getByRole("img", {
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

  it("includes running pod counts in the runtime tooltip", async () => {
    const user = userEvent.setup();
    const localItem = {
      ...item,
      id: "cat-running",
      name: "running-local-server",
      serverType: "local",
    } as CatalogItem;
    const localInstall = {
      ...personalInstall,
      id: "srv-running",
      catalogId: localItem.id,
      name: localItem.name,
      serverType: "local",
    } as InstalledServer;
    useMcpServersMock.mockReturnValue({ data: [localInstall] });

    renderCard(
      <McpServerCard
        variant="local"
        item={localItem}
        installedServer={localInstall}
        installingItemId={null}
        deploymentStatuses={{
          [localInstall.id]: {
            state: "running",
            message: "Running",
            error: null,
          },
        }}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    await user.hover(
      screen.getByRole("img", { name: "Runtime status: Running" }),
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Running 1/1 pods.",
    );
    expect(screen.queryByRole("link", { name: /Learn more/ })).toBeNull();
  });

  it("shows an issue badge and only its primary action in the card action row", () => {
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
    } as const;
    renderCard(
      <McpServerCard
        variant="remote"
        item={item}
        installedServer={personalInstall}
        installingItemId={null}
        deploymentStatuses={{}}
        deploymentFeedState="ready"
        issues={[issue]}
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Re-authenticate" }),
    ).toHaveTextContent("Auth");
    expect(screen.queryByRole("button", { name: /Dismiss alert/ })).toBeNull();
    expect(
      screen.queryByTestId("mcp-registry-attention-row-some-remote-server"),
    ).toBeNull();
    expect(
      screen.queryByText(/provider rejected the stored token/i),
    ).toBeNull();
  });

  it("opens details from the card surface without shadowing card buttons", async () => {
    const user = userEvent.setup();
    useMcpServersMock.mockReturnValue({ data: [personalInstall] });
    renderCard(
      <McpServerCard
        variant="remote"
        item={item}
        installedServer={personalInstall}
        installingItemId={null}
        deploymentStatuses={{}}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );
    const card = screen.getByTestId(`mcp-server-card-${item.name}`);

    await user.click(card);
    expect(routerPush).toHaveBeenCalledWith(`/mcp/registry/${item.id}`);

    routerPush.mockClear();
    await user.click(within(card).getByRole("button", { name: "Uninstall" }));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("renders one flat card grid in the shared registry sort order", () => {
    const flagged = {
      ...item,
      id: "cat-flagged",
      name: "Flagged server",
    } as CatalogItem;
    const personal = {
      ...item,
      id: "cat-personal",
      name: "Personal server",
    } as CatalogItem;
    const alpha = {
      ...item,
      id: "cat-alpha",
      name: "Alpha server",
    } as CatalogItem;
    const zeta = {
      ...item,
      id: "cat-zeta",
      name: "Zeta server",
    } as CatalogItem;
    const flaggedInstall = {
      ...personalInstall,
      id: "srv-flagged",
      catalogId: flagged.id,
      name: flagged.name,
    } as InstalledServer;
    const personalInstallForGrid = {
      ...personalInstall,
      id: "srv-personal",
      catalogId: personal.id,
      name: personal.name,
    } as InstalledServer;
    registryIssuesMock.set(flagged.id, [
      {
        kind: "needs-reauth",
        audience: "you",
        catalogId: flagged.id,
        serverId: flaggedInstall.id,
        detail: null,
        since: null,
        fingerprint: "v1:needs-reauth:flagged",
        muted: false,
        mutedReason: null,
      },
    ]);
    useMcpServersMock.mockReturnValue({
      data: [flaggedInstall, personalInstallForGrid],
    });

    renderCard(
      <InternalMCPCatalog initialData={[zeta, personal, alpha, flagged]} />,
    );

    expect(
      screen.queryByRole("heading", { name: "Action required" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Other servers" })).toBeNull();
    const grid = screen.getByTestId("registry-card-grid");
    expect(
      within(grid)
        .getAllByRole("heading", { level: 3 })
        .filter((heading) =>
          [flagged.name, personal.name, alpha.name, zeta.name].includes(
            heading.textContent ?? "",
          ),
        )
        .map((heading) => heading.textContent),
    ).toEqual([alpha.name, flagged.name, personal.name, zeta.name]);
  });

  it("explains that an uninstalled card must be installed before selection", async () => {
    const user = userEvent.setup();
    useMcpServersMock.mockReturnValue({ data: [] });
    renderCard(<InternalMCPCatalog initialData={[item]} />);

    const checkbox = screen.getByRole("checkbox", {
      name: "Select some-remote-server",
    });
    expect(checkbox).toBeDisabled();
    await user.hover(checkbox.parentElement ?? checkbox);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Install this server before selecting it",
    );
  });

  it("selects a card range from the shared bulk-selection checkbox", async () => {
    const user = userEvent.setup();
    renderCard(<CardSelectionHarness />);

    await user.click(
      screen.getByRole("checkbox", { name: "Select some-remote-server" }),
    );
    await user.keyboard("{Shift>}");
    await user.click(
      screen.getByRole("checkbox", { name: "Select third-remote-server" }),
    );
    await user.keyboard("{/Shift}");

    expect(
      screen.getByRole("checkbox", { name: "Select second-remote-server" }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("keeps the bulk-selection checkbox disabled while installation is in progress", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();
    renderCard(
      <McpServerCard
        variant="remote"
        item={item}
        installingItemId="cat-1"
        deploymentStatuses={{}}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
        selection={{
          selected: false,
          onSelectedChange,
          onSelectionClick: vi.fn(),
          disabled: true,
          disabledTooltip: "Wait for installation to finish",
        }}
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Select some-remote-server",
    });
    expect(checkbox).toBeDisabled();
    await user.hover(checkbox.parentElement ?? checkbox);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Wait for installation to finish",
    );

    await user.click(checkbox);

    expect(onSelectedChange).not.toHaveBeenCalled();
  });
});
