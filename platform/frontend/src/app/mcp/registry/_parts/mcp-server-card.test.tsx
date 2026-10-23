import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement, type ReactElement, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");

const { routerPush, nav } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  nav: { search: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  usePathname: () => "/mcp/registry",
  useSearchParams: () => nav.search,
}));

const { environmentsMock } = vi.hoisted(() => ({
  environmentsMock: vi.fn(),
}));
vi.mock("@/lib/environment.query", () => ({
  useEnvironments: environmentsMock,
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useMcpCatalogCredentialPreflight: () => ({ data: [] }),
  useMcpCatalogLabelKeys: () => ({ data: [] }),
  useMcpCatalogLabelValues: () => ({ data: [] }),
  useReinstallInternalMcpCatalogItem: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

const { liveRuleInputs } = vi.hoisted(() => ({
  liveRuleInputs: {
    reauthReady: true,
    feedState: "ready" as
      | "loading"
      | "ready"
      | "reconnecting"
      | "disabled"
      | "disconnected",
  },
}));

vi.mock("@/lib/mcp/use-can-reauthenticate", () => ({
  useCanReauthenticate: () => () => false,
  useCanReauthenticateInputsReady: () => liveRuleInputs.reauthReady,
}));

vi.mock("./use-chat-with-catalog-item", () => ({
  useChatWithCatalogItem: () => ({
    startChat: vi.fn(),
    startChatById: vi.fn(),
    isCreating: false,
  }),
}));

const { useMcpServersMock } = vi.hoisted(() => ({
  useMcpServersMock: vi.fn(),
}));
const { registryIssuesMock } = vi.hoisted(() => ({
  registryIssuesMock: new Map(),
}));
const {
  registryPageMock,
  issueIndexMock,
  matchingIdsMock,
  fetchCatalogItemMock,
  remoteDialogMock,
} = vi.hoisted(() => ({
  registryPageMock: vi.fn(),
  issueIndexMock: vi.fn(),
  matchingIdsMock: vi.fn(),
  fetchCatalogItemMock: vi.fn(),
  remoteDialogMock: vi.fn(),
}));

// The page's installs reach the cards through the list's page-scoped request.
vi.mock("./registry-page-servers", () => ({
  RegistryPageServersProvider: ({ children }: { children: ReactElement }) =>
    children,
  useRegistryPageServers: () => useMcpServersMock().data,
}));

vi.mock("@/lib/mcp/mcp-registry.query", () => ({
  useMcpRegistryPage: registryPageMock,
  useMcpRegistryIssueIndex: issueIndexMock,
  useMcpServersForCatalogs: (catalogIds: string[]) =>
    useMcpServersMock({ catalogIds }),
  useMcpRegistryMatchingIds: matchingIdsMock,
  useInternalMcpCatalogItem: () => ({ data: null }),
  fetchInternalMcpCatalogItem: fetchCatalogItemMock,
}));
// What GET /api/mcp_server/:id answers per install: server lists leave the
// agents out.
const { assignedAgentsByServer } = vi.hoisted(() => ({
  assignedAgentsByServer: new Map<string, unknown[]>(),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: useMcpServersMock,
  useMcpServersAssignedAgents: () => ({
    agentsByServerId: assignedAgentsByServer,
    isPending: false,
    isError: false,
  }),
  useAutoModeAgents: () => ({ data: [] }),
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkUninstallMcpServers: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissMcpServerAlerts: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useMcpDeploymentStatuses: () => ({
    statuses: {},
    state: liveRuleInputs.feedState,
  }),
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
  useScopeFilterParams: () => ({
    access: ["mine", "shared", "org"],
    hasActiveScopeFilters: false,
  }),
}));

vi.mock("@/components/resource-access-filter", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/resource-access-filter")
  >()),
  ResourceAccessFilter: () => null,
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

vi.mock("./mcp-registry-visibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-registry-visibility")>()),
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
  RemoteServerInstallDialog: (props: unknown) => {
    remoteDialogMock(props);
    return null;
  },
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
    addPersonalConnection: vi.fn(),
    addSharedConnection: vi.fn(),
    addOrgConnection: vi.fn(),
    cancelInstallation: vi.fn(),
    dialogs: null,
  }),
}));

import { type Permissions, PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import {
  useAppearanceSettings,
  useDefaultEnvironment,
} from "@/lib/organization.query";
import { useAssignableTeams, useMyTeams } from "@/lib/teams/team.query";
import { InternalMCPCatalog } from "./InternalMCPCatalog";
import {
  type InstalledServer,
  McpServerCard,
  type RegistryListItem,
} from "./mcp-server-card";
import { registryPageRequestFromUrl } from "./registry-list-query";

const CURRENT_USER_ID = "user-me";

const itemFields = {
  id: "cat-1",
  name: "some-remote-server",
  serverType: "remote",
  icon: null,
  iconUrl: null,
  toolCount: 0,
  environmentId: null,
  imageApprovalRequired: false,
  multitenant: false,
  catalogReinstallRequired: false,
  bindsCredential: false,
  enterpriseManaged: false,
  labels: [],
  // Editing the item is its own `update` grant, read from the list response.
  effectiveActions: ["read", "update"],
};

/**
 * A registry list row. The server summarizes each row's installs; here the
 * summary follows whatever installs the test hands the page.
 */
function registryRow(fields: Record<string, unknown>): RegistryListItem {
  const row = { ...fields } as unknown as RegistryListItem;
  Object.defineProperty(row, "install", {
    enumerable: true,
    get: () => {
      const servers = ((
        useMcpServersMock.getMockImplementation()?.() ??
        useMcpServersMock.mock.results.at(-1)?.value
      )?.data ?? []) as InstalledServer[];
      const own = servers.filter((server) => server.catalogId === row.id);
      return {
        visibleCount: own.length,
        installedForViewer: own.some((server) => server.canUseCredential),
        primaryServerId: own[0]?.id ?? null,
      };
    },
  });
  return row;
}

const item = registryRow(itemFields);

function pageOf(rows: RegistryListItem[], attentionTiers?: string[][]) {
  return {
    data: {
      data: rows,
      ...(attentionTiers ? { attentionTiers } : {}),
      pagination: {
        currentPage: 1,
        limit: 10,
        total: rows.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
      selectableTotal: rows.filter((row) => row.install.visibleCount > 0)
        .length,
    },
  };
}

const personalInstall = {
  id: "srv-1",
  catalogId: "cat-1",
  name: "some-remote-server",
  ownerId: CURRENT_USER_ID,
  teamId: null,
  scope: "personal",
  canUseCredential: true,
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
    registryRow({ ...itemFields, id: "cat-2", name: "second-remote-server" }),
    registryRow({ ...itemFields, id: "cat-3", name: "third-remote-server" }),
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
    liveRuleInputs.reauthReady = true;
    liveRuleInputs.feedState = "ready";
    vi.clearAllMocks();
    nav.search = new URLSearchParams();
    environmentsMock.mockReturnValue({ data: { environments: [] } });
    issueIndexMock.mockReturnValue({
      data: { catalogItems: [], servers: [] },
    });
    matchingIdsMock.mockReturnValue({ data: undefined });
    registryIssuesMock.clear();
    assignedAgentsByServer.clear();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: CURRENT_USER_ID } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useFeature).mockReturnValue(
      false as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useAssignableTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAssignableTeams>);
    vi.mocked(useMyTeams).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useMyTeams>);
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

  it("offers no Uninstall for an organization connection the user installed", () => {
    // An org install records its installer as owner; Uninstall on the card
    // would have targeted the connection every org agent resolves to.
    useMcpServersMock.mockReturnValue({
      data: [{ ...personalInstall, scope: "org" }],
    });
    renderCard(card);

    expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull();
  });

  it("warns only about agents pinned to the personal connection being removed", async () => {
    const user = userEvent.setup();
    const agent = {
      agentType: "agent",
      ownerId: null,
      ownerEmail: null,
    };
    useMcpServersMock.mockReturnValue({
      data: [{ ...personalInstall, scope: "personal" }],
    });
    assignedAgentsByServer.set(personalInstall.id, [
      {
        ...agent,
        id: "a-org",
        name: "Org Assistant",
        scope: "org",
        pinned: false,
      },
      {
        ...agent,
        id: "a-mine",
        name: "My Gateway",
        scope: "personal",
        pinned: true,
      },
    ]);
    renderCard(card);

    await user.click(screen.getByRole("button", { name: "Uninstall" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Only this personal connection is removed",
    );
    expect(dialog).toHaveTextContent("Used by 1 agent");
    expect(dialog).toHaveTextContent("My Gateway");
    expect(dialog).not.toHaveTextContent("Org Assistant");
  });

  it("loads installs only for the catalog items on the page", async () => {
    const user = userEvent.setup();
    useMcpServersMock.mockReturnValue({ data: [personalInstall] });
    registryPageMock.mockReturnValue(pageOf([item]));
    renderCard(<InternalMCPCatalog />);
    await user.click(screen.getByRole("button", { name: "Uninstall" }));
    await screen.findByRole("dialog");

    // The page asks for its own rows' installs, never the organization's.
    expect(useMcpServersMock).toHaveBeenCalledWith({ catalogIds: [item.id] });
  });

  it("opens server settings once from the keyboard without activating the card", async () => {
    const user = userEvent.setup();
    renderCard(card);

    const settings = screen.getByRole("button", {
      name: `Server settings for ${item.name}`,
    });
    settings.focus();
    await user.keyboard("{Enter}");

    expect(routerPush).toHaveBeenCalledExactlyOnceWith("/mcp/registry/cat-1");
  });

  it("withholds settings without catalog access", () => {
    // No `update` grant on the item and no registry-wide `update`: the
    // retired `mcpServerInstallation:admin` action no longer decides this.
    grantAllExcept({ mcpRegistry: ["update"] });
    renderCard(
      cloneElement(card, {
        item: registryRow({ ...itemFields, effectiveActions: ["read"] }),
      }),
    );

    expect(
      screen.queryByRole("button", {
        name: `Server settings for ${item.name}`,
      }),
    ).not.toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("shows managed Playwright without installation actions", () => {
    const playwrightItem = registryRow({
      ...itemFields,
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      name: "microsoft__playwright-mcp",
      serverType: "local",
      toolCount: 1,
    });
    const managedRuntime = {
      ...personalInstall,
      id: "managed-playwright-runtime",
      catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
      ownerId: null,
      scope: "org",
      serverType: "local",
      users: [],
    } as InstalledServer;
    useMcpServersMock.mockReturnValue({ data: [managedRuntime] });

    renderCard(
      <McpServerCard
        variant="local"
        item={playwrightItem}
        installedServer={managedRuntime}
        installingItemId={null}
        deploymentStatuses={{}}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
        isBuiltInPlaywright
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Chat using microsoft__playwright-mcp",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reinstall/i })).toBeNull();
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
        item={registryRow({
          ...itemFields,
          serverType: "local",
          imageApprovalRequired: true,
        })}
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

  it("still offers a personal Install when a team connection serves the viewer", () => {
    useMcpServersMock.mockReturnValue({
      data: [
        {
          ...personalInstall,
          ownerId: "teammate",
          scope: "team",
          teamId: "team-a",
          canUseCredential: true,
        },
      ],
    });
    renderCard(card);

    expect(
      screen.getByRole("button", { name: `Install ${item.name}` }),
    ).toBeInTheDocument();
  });

  it("offers Install when only a colleague's personal connection exists", () => {
    useMcpServersMock.mockReturnValue({
      data: [
        {
          ...personalInstall,
          ownerId: "colleague",
          users: ["colleague"],
          canUseCredential: false,
        },
      ],
    });
    renderCard(card);

    expect(
      screen.getByRole("button", { name: `Install ${item.name}` }),
    ).toBeInTheDocument();
  });

  it("offers Chat only once the viewer has a connection of their own", () => {
    const colleagueInstall = {
      ...personalInstall,
      ownerId: "colleague",
      users: ["colleague"],
      canUseCredential: false,
    };
    useMcpServersMock.mockReturnValue({ data: [colleagueInstall] });
    const { unmount } = renderCard(
      cloneElement(card, {
        item: registryRow({ ...itemFields, toolCount: 3 }),
      }),
    );

    expect(
      screen.queryByRole("button", { name: `Chat using ${item.name}` }),
    ).toBeNull();
    unmount();

    useMcpServersMock.mockReturnValue({
      data: [colleagueInstall, personalInstall],
    });
    renderCard(
      cloneElement(card, {
        item: registryRow({ ...itemFields, toolCount: 3 }),
      }),
    );

    expect(
      screen.getByRole("button", { name: `Chat using ${item.name}` }),
    ).toBeInTheDocument();
  });

  it("reports a failed OAuth refresh once when its issue badge is already shown", () => {
    useMcpServersMock.mockReturnValue({
      data: [{ ...personalInstall, oauthRefreshError: "refresh_failed" }],
    });
    renderCard(
      cloneElement(card, {
        issues: [
          {
            kind: "needs-reauth",
            audience: "you",
            catalogId: item.id,
            serverId: personalInstall.id,
            detail: null,
            since: null,
            fingerprint: "v1:needs-reauth:test",
            muted: false,
            mutedReason: null,
          },
        ],
      }),
    );

    expect(screen.getAllByText("Needs re-authentication")).toHaveLength(1);
  });

  it("overlays a local runtime status dot on the icon with its status tooltip", async () => {
    const user = userEvent.setup();
    const localItem = registryRow({
      ...itemFields,
      id: "cat-local",
      name: "hibernated-local-server",
      serverType: "local",
    });
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
    const localItem = registryRow({
      ...itemFields,
      id: "cat-running",
      name: "running-local-server",
      serverType: "local",
    });
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

  it("asks the server to rank items needing action first and renders its order", () => {
    const flagged = registryRow({
      ...itemFields,
      id: "cat-flagged",
      name: "Flagged server",
    });
    const personal = registryRow({
      ...itemFields,
      id: "cat-personal",
      name: "Personal server",
    });
    const alpha = registryRow({
      ...itemFields,
      id: "cat-alpha",
      name: "Alpha server",
    });
    const zeta = registryRow({
      ...itemFields,
      id: "cat-zeta",
      name: "Zeta server",
    });
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

    // The server applies the order; it answers in the order it was asked for.
    registryPageMock.mockReturnValue(
      pageOf([flagged, personal, alpha, zeta], [[flagged.id], []]),
    );
    renderCard(<InternalMCPCatalog />);

    // The server ranks the attention order itself; the browser sends no
    // tiers while the server's ranking agrees with its own.
    expect(registryPageMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ rankTiers: expect.anything() }),
      expect.anything(),
    );
    expect(registryPageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sortBy: "attention",
        limit: 10,
        offset: 0,
      }),
      expect.anything(),
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
    ).toEqual([flagged.name, personal.name, alpha.name, zeta.name]);
  });

  it("waits for the viewer's teams and rights, and a connected feed, before comparing with the server's order", () => {
    const flagged = registryRow({
      ...itemFields,
      id: "cat-flagged",
      name: "Flagged server",
    });
    registryIssuesMock.set(flagged.id, [
      {
        kind: "needs-reauth",
        audience: "you",
        catalogId: flagged.id,
        serverId: "srv-flagged",
        detail: null,
        since: null,
        fingerprint: "v1:needs-reauth:flagged",
        muted: false,
        mutedReason: null,
      },
    ]);
    registryPageMock.mockReturnValue(pageOf([flagged], [[], []]));
    const noLiveTiers = () =>
      expect(registryPageMock).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ rankTiers: expect.anything() }),
        expect.anything(),
      );

    // Teams still loading: the live rule's answer is a guess.
    liveRuleInputs.reauthReady = false;
    const first = renderCard(<InternalMCPCatalog />);
    noLiveTiers();
    first.unmount();

    // A dropped or disabled feed holds no runtime faults to compare.
    liveRuleInputs.reauthReady = true;
    // A feed back from a gap shows statuses from before it until it answers.
    for (const feedState of [
      "disconnected",
      "disabled",
      "reconnecting",
    ] as const) {
      liveRuleInputs.feedState = feedState;
      const view = renderCard(<InternalMCPCatalog />);
      noLiveTiers();
      view.unmount();
    }
    liveRuleInputs.feedState = "ready";
  });

  it("sends its live tiers once the server's attention ranking disagrees with them", () => {
    const flagged = registryRow({
      ...itemFields,
      id: "cat-flagged",
      name: "Flagged server",
    });
    registryIssuesMock.set(flagged.id, [
      {
        kind: "needs-reauth",
        audience: "you",
        catalogId: flagged.id,
        serverId: "srv-flagged",
        detail: null,
        since: null,
        fingerprint: "v1:needs-reauth:flagged",
        muted: false,
        mutedReason: null,
      },
    ]);
    // The server's copy of the runtime state had nothing flagged yet.
    registryPageMock.mockReturnValue(pageOf([flagged], [[], []]));
    renderCard(<InternalMCPCatalog />);

    expect(registryPageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sortBy: "attention",
        rankTiers: [[flagged.id], []],
      }),
      expect.anything(),
    );
  });
  it("explains that an uninstalled card must be installed before selection", async () => {
    const user = userEvent.setup();
    useMcpServersMock.mockReturnValue({ data: [] });
    registryPageMock.mockReturnValue(pageOf([item]));
    renderCard(<InternalMCPCatalog />);

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

  it("requests the page, size and order the URL names", () => {
    nav.search = new URLSearchParams(
      "page=3&pageSize=20&sortBy=name&sortDirection=desc&search=git",
    );
    registryPageMock.mockReturnValue(pageOf([item]));
    renderCard(<InternalMCPCatalog />);

    expect(registryPageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        limit: 20,
        offset: 40,
        sortBy: "name",
        sortDirection: "desc",
        search: "git",
      }),
      expect.anything(),
    );
  });

  it("narrows the rows on screen at once and asks the server once typing pauses", () => {
    vi.useFakeTimers();
    try {
      const alpha = { ...item, id: "cat-alpha", name: "alpha-server" };
      const beta = { ...item, id: "cat-beta", name: "beta-server" };
      nav.search = new URLSearchParams();
      registryPageMock.mockReturnValue(pageOf([alpha, beta]));
      const view = renderCard(<InternalMCPCatalog />);
      expect(screen.queryAllByText("beta-server").length).toBeGreaterThan(0);

      // The box writes each keystroke to the URL; the server's answer for the
      // new term has not arrived yet.
      nav.search = new URLSearchParams("search=alp");
      view.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <InternalMCPCatalog />
        </QueryClientProvider>,
      );

      expect(screen.queryAllByText("beta-server")).toHaveLength(0);
      expect(screen.queryAllByText("alpha-server").length).toBeGreaterThan(0);
      expect(registryPageMock).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ search: expect.anything() }),
        expect.anything(),
      );

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(registryPageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "alp" }),
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for exactly the request the route started before it rendered", () => {
    // The route sends the URL's page request while the session is checked;
    // the page only finds it if its own request is the same, in the same
    // placeholder scope.
    for (const url of [
      "",
      "page=3&pageSize=20&sortBy=name&sortDirection=desc&search=git",
      "status=installed&labels=team%3Dplatform",
    ]) {
      nav.search = new URLSearchParams(url);
      registryPageMock.mockReturnValue(pageOf([item]));
      const { unmount } = renderCard(<InternalMCPCatalog />);

      expect(registryPageMock).toHaveBeenLastCalledWith(
        registryPageRequestFromUrl(new URLSearchParams(url)),
        expect.objectContaining({ placeholderScope: "all" }),
      );
      unmount();
    }
  });

  it("moves to the last page that still exists when the list shrinks", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    nav.search = new URLSearchParams("page=5&pageSize=10");
    registryPageMock.mockReturnValue({
      data: {
        ...pageOf([]).data,
        pagination: { ...pageOf([]).data.pagination, total: 12 },
      },
    });
    renderCard(<InternalMCPCatalog />);

    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/mcp/registry?page=2&pageSize=10",
    );
    replaceState.mockRestore();
  });

  it("keeps the search box and filters when the list request fails", () => {
    registryPageMock.mockReturnValue({ data: undefined, isError: true });
    renderCard(<InternalMCPCatalog />);

    expect(
      screen.getByPlaceholderText("Search MCP servers by name"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("MCP servers could not be loaded"),
    ).toBeInTheDocument();
  });

  it("caps an out-of-range page size and a long search before asking", () => {
    nav.search = new URLSearchParams(
      `pageSize=500&page=abc&search=${"x".repeat(300)}`,
    );
    registryPageMock.mockReturnValue(pageOf([item]));
    renderCard(<InternalMCPCatalog />);

    const [params] = registryPageMock.mock.lastCall ?? [];
    expect(params).toMatchObject({ limit: 10, offset: 0 });
    expect(params.search).toHaveLength(256);
  });

  it("waits for the environments before asking for an environment filter", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    nav.search = new URLSearchParams("environment=Production&page=3");
    environmentsMock.mockReturnValue({ data: undefined });
    // What a request sent too early would get back: no rows at all.
    registryPageMock.mockReturnValue(pageOf([]));
    renderCard(<InternalMCPCatalog />);

    expect(registryPageMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    // A result computed without the environment ids must not move the page.
    expect(replaceState).not.toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it("keeps selections made on other pages and acts on all of them", async () => {
    const user = userEvent.setup();
    const pageOneRow = registryRow({ ...itemFields, id: "cat-p1" });
    const pageTwoRow = registryRow({
      ...itemFields,
      id: "cat-p2",
      name: "page-two-server",
    });
    useMcpServersMock.mockReturnValue({
      data: [
        { ...personalInstall, id: "srv-p1", catalogId: "cat-p1" },
        { ...personalInstall, id: "srv-p2", catalogId: "cat-p2" },
      ],
    });
    registryPageMock.mockReturnValue(pageOf([pageOneRow]));
    const view = renderCard(<InternalMCPCatalog />);
    await user.click(
      screen.getByRole("checkbox", { name: "Select some-remote-server" }),
    );

    registryPageMock.mockReturnValue(pageOf([pageTwoRow]));
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <InternalMCPCatalog />
      </QueryClientProvider>,
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Select page-two-server" }),
    );

    expect(screen.getAllByText("2 servers selected").length).toBeGreaterThan(0);
    // The bulk bar renders above the grid; the card has its own "Uninstall".
    await user.click(screen.getAllByRole("button", { name: "Uninstall" })[0]);
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Uninstall 2 servers?",
    );
  });

  it("asks for every matching row by filters alone, not by the live order", () => {
    registryPageMock.mockReturnValue(pageOf([item]));
    renderCard(<InternalMCPCatalog />);

    const [query] = matchingIdsMock.mock.lastCall ?? [];
    expect(query).not.toHaveProperty("rankTiers");
    expect(query).not.toHaveProperty("sortBy");
  });

  it("waits for the issue index before re-authenticating a highlighted connection", async () => {
    nav.search = new URLSearchParams("reauth=cat-1&server=srv-team");
    issueIndexMock.mockReturnValue({ data: undefined });
    fetchCatalogItemMock.mockResolvedValue({
      ...itemFields,
      oauthConfig: null,
      userConfig: {},
    });
    registryPageMock.mockReturnValue(pageOf([item]));
    const view = renderCard(<InternalMCPCatalog />);
    expect(fetchCatalogItemMock).not.toHaveBeenCalled();

    issueIndexMock.mockReturnValue({
      data: {
        catalogItems: [],
        servers: [
          {
            id: "srv-team",
            catalogId: "cat-1",
            scope: "team",
            teamId: "team-a",
            ownerId: "someone",
          },
        ],
      },
    });
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <InternalMCPCatalog />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(remoteDialogMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isReauth: true,
          existingScope: "team",
          existingTeamId: "team-a",
        }),
      ),
    );
  });
});
