"use client";

import {
  E2eTestId,
  grantsAudience,
  isPlaywrightCatalogItem,
} from "@archestra/shared";
import {
  Cable,
  Copy,
  MessageSquare,
  MoreHorizontal,
  PackageX,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import type { OverviewFact } from "@/components/overview-summary";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useSavedBrowserLogins } from "@/lib/browser-storage-state.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { typeRole } from "@/lib/design/type-scale";
import { useEnvironments } from "@/lib/environment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useRefreshInternalMcpCatalogImage } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpUsageSummary } from "@/lib/mcp/mcp-agent-usage.query";
import { useInternalMcpCatalogItem } from "@/lib/mcp/mcp-registry.query";
import {
  type McpDeploymentFeedState,
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { useMcpDeploymentPermission } from "@/lib/mcp/use-mcp-deployment-permission";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import { useResourcePermissions } from "@/lib/resource-permissions.query";
import { formatCompactNumber } from "@/lib/utils/format-compact-number";
import { cn } from "@/lib/utils/tailwind";
import { useCanModifyCatalogItem } from "../_parts/catalog-edit-access";
import { resolveCatalogEnvironmentLabel } from "../_parts/catalog-environment-label";
import { shouldShowMcpCardChatButton } from "../_parts/chat-button-visibility";
import { collapseMultitenantInstalls } from "../_parts/collapse-multitenant-installs";
import { DeleteCatalogDialog } from "../_parts/delete-catalog-dialog";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  type DeploymentStatusSummary,
  getDeploymentLabel,
  getDeploymentStatusChipLabel,
} from "../_parts/deployment-status";
import { buildDetailTabHref } from "../_parts/detail-tab-href";
import { InlineMcpReauthentication } from "../_parts/inline-mcp-reauthentication";
import { getLocalInstallationCopy } from "../_parts/local-installation-copy";
import { ManageUsersContent } from "../_parts/manage-users-dialog";
import type { McpCatalogFormValues } from "../_parts/mcp-catalog-form.types";
import { transformCatalogItemToFormValues } from "../_parts/mcp-catalog-form.utils";
import { isMcpServerInstalledForViewer } from "../_parts/mcp-registry-visibility";
import {
  MCP_ACCESS_SECTION_ID,
  McpServerAccessSection,
} from "../_parts/mcp-server-access-section";
import {
  getMcpServerActionModel,
  mcpServerAction,
  mcpServerActionHref,
} from "../_parts/mcp-server-actions-model";
import { deriveAgentUsage } from "../_parts/mcp-server-agent-usage";
import type { CatalogItem, InstalledServer } from "../_parts/mcp-server-card";
import {
  McpServerConnectionPanel,
  type McpServerSpec,
} from "../_parts/mcp-server-connection-panel";
import {
  McpServerConsole,
  type McpServerConsoleTab,
} from "../_parts/mcp-server-console";
import { McpServerIssueNotice } from "../_parts/mcp-server-issue-notice";
import { McpServerToolsSection } from "../_parts/mcp-server-tools-section";
import { McpServerPagedUsageTab } from "../_parts/mcp-server-usage-tab";
import { PlaywrightSavedLoginsTab } from "../_parts/playwright-saved-logins-tab";
import { useCatalogInstall } from "../_parts/use-catalog-install";
import { useChatWithCatalogItem } from "../_parts/use-chat-with-catalog-item";
import { YamlConfigContent } from "../_parts/yaml-config-dialog";

type DetailTab =
  | "overview"
  | "logins"
  | "usage"
  | "credentials"
  | "logs"
  | "inspector"
  | "shell"
  | "yaml";

const DIAGNOSTIC_PANELS: Array<{
  id: Exclude<DetailTab, "overview">;
  title: string;
  logsTab?: McpServerConsoleTab;
  localOnly: boolean;
}> = [
  { id: "logs", title: "Logs", logsTab: "logs", localOnly: true },
  {
    id: "inspector",
    title: "Inspector",
    logsTab: "inspector",
    localOnly: false,
  },
  { id: "shell", title: "Shell", logsTab: "debug", localOnly: true },
  { id: "yaml", title: "K8s YAML", localOnly: true },
];

// The Logs/Inspector/Shell tabs share one mounted <McpServerConsole>; this
// maps the page-level tab id to that component's tab.
const LOGS_TAB_BY_ID: Record<string, McpServerConsoleTab> = {
  logs: "logs",
  inspector: "inspector",
  shell: "debug",
};

const MCP_CONNECTIONS_SECTION_ID = "connections";

export function McpCatalogItemPage({ id }: { id: string }) {
  const router = useRouter();
  // The one item this page shows, by id, with its list figures (tool count,
  // the caller's actions) — not the whole registry.
  const { data: itemById, isPending } = useInternalMcpCatalogItem(id);
  // An app's backing entry is never listed in the registry; its id opens
  // nothing here, as it did when the page looked the item up in the list.
  const item = itemById && itemById.serverType !== "app" ? itemById : undefined;

  // Deleting this server invalidates the catalog list, and the refetch lands
  // long before the client-side navigation back to the registry has resolved
  // its payload. For that window `item` is already gone while this route is
  // still mounted — without the flag the page would answer with its "Server
  // not found" empty state, flashing a 404 for a delete that just succeeded.
  const [isLeavingAfterDelete, setIsLeavingAfterDelete] = useState(false);

  // The row is never coming back, so keep the page in its loading state until
  // the route actually changes.
  if (isPending || (isLeavingAfterDelete && !item)) {
    return (
      <PageLayout
        title="MCP Server"
        description=""
        backLink={
          <PageBackLink href="/mcp/registry">MCP Registry</PageBackLink>
        }
        maxWidth="wizard"
      >
        <ItemPageSkeleton />
      </PageLayout>
    );
  }

  if (!item) {
    return (
      <PageLayout
        title="MCP Server"
        description=""
        backLink={
          <PageBackLink href="/mcp/registry">MCP Registry</PageBackLink>
        }
        maxWidth="wizard"
      >
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageX />
            </EmptyMedia>
            <EmptyTitle>Server not found</EmptyTitle>
            <EmptyDescription>
              This MCP server is not in the registry. It may have been removed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageLayout>
    );
  }

  return (
    <CatalogItemDetails
      item={item}
      onDeleted={() => {
        setIsLeavingAfterDelete(true);
        router.push("/mcp/registry");
      }}
    />
  );
}

function CatalogItemDetails({
  item,
  onDeleted,
}: {
  item: CatalogItem;
  /** Owned by the page so it can suppress its not-found state on the way out. */
  onDeleted: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const appName = useAppName();
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const pendingHrefRef = useRef<string | null>(null);
  useBeforeUnloadWhileDirty(permissionsDirty);
  const guard = useUnsavedChangesGuard({
    isDirty: permissionsDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) {
        if (href.startsWith(pathname)) router.replace(href, { scroll: false });
        else router.push(href);
      }
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );
  useGuardedInAppNavigation({
    isDirty: permissionsDirty,
    onRequestNavigate: requestNavigate,
  });

  const variant =
    item.serverType === "builtin"
      ? "builtin"
      : item.serverType === "remote"
        ? "remote"
        : "local";
  const actionModel = getMcpServerActionModel(item);
  const editAction = mcpServerAction(actionModel, "edit");
  const cloneAction = mcpServerAction(actionModel, "clone");
  const deleteAction = mcpServerAction(actionModel, "delete");
  const isPlaywright = isPlaywrightCatalogItem(item.id);

  const { canModify } = useCanModifyCatalogItem(
    variant !== "builtin" ? item : null,
  );
  const { data: userCanCreateCatalogItem } = useHasPermissions({
    mcpRegistry: ["create"],
  });
  const { data: userCanViewDeploymentYaml } = useMcpDeploymentPermission(
    item.id,
  );
  // Signing someone else out of the browser is member management: admins only
  const { data: userCanManageMembers } = useHasPermissions({
    member: ["update"],
  });
  const showSavedLogins = isPlaywright && !!userCanManageMembers;
  const { data: savedLogins } = useSavedBrowserLogins({
    enabled: showSavedLogins,
  });

  // This catalog's installs only, with their agents (the usage count and
  // tab). Narrowed in SQL: the agent lookup covers these installs alone.
  const { data: catalogMcpServers, isPending: isServersPending } =
    useMcpServers({
      catalogId: item.id,
      includeAssignedAgents: true,
    });
  const { statuses: deploymentStatuses, state: deploymentFeedState } =
    useMcpDeploymentStatuses();
  const { issuesByCatalog } = useMcpServerIssues(deploymentStatuses);
  // Dismissed alerts belong only to the registry's Dismissed facet. The
  // server page reports live operational state, so muted issues neither render
  // a notice here nor suppress the normal status.
  const itemIssues = (issuesByCatalog.get(item.id) ?? []).filter(
    (issue) => !issue.muted,
  );
  const statusIssue = itemIssues[0];
  useMcpInstallationStatusCacheSync();

  const { data: environmentList } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();
  const environmentLabel =
    variant === "builtin"
      ? null
      : resolveCatalogEnvironmentLabel({
          environmentId: item.environmentId,
          environments: environmentList?.environments ?? [],
          defaultEnvironmentName: defaultEnvironment.name,
        });

  const allServersForCatalog = useMemo(
    () => (catalogMcpServers ?? []).filter((s) => s.catalogId === item.id),
    [catalogMcpServers, item.id],
  );

  // Aggregate installations for the logs/inspector dropdown — local installs
  // when present, otherwise every install (mirrors the server card).
  const localInstalls = allServersForCatalog
    .filter((s) => s.serverType === "local")
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  const allInstalls =
    localInstalls.length > 0
      ? localInstalls
      : allServersForCatalog
          .slice()
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
  const deploymentServerIds = allServersForCatalog
    .filter((s) => s.serverType === "local")
    .map((s) => s.id);
  const deploymentSummary = computeDeploymentStatusSummary(
    deploymentServerIds,
    deploymentStatuses,
  );

  const debugInstalls = item.multitenant
    ? collapseMultitenantInstalls({
        installs: allInstalls,
        deploymentStatuses,
        catalogName: item.name,
      })
    : allInstalls;

  // The same permission the backend requires for a shared installation.
  // Without it (a member) the page shows only what is the viewer's own and
  // what they can act on; everyone else keeps the full detail.
  const { data: canManageInstallations } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const isMemberView = !canManageInstallations;
  const diagnosticPanels = DIAGNOSTIC_PANELS.filter(
    (panel) =>
      (variant === "local" || !panel.localOnly) &&
      !(isPlaywright && panel.id === "yaml") &&
      (panel.id !== "yaml" || userCanViewDeploymentYaml) &&
      // A shell runs commands inside the server's container in the cluster;
      // the backend refuses it to a member as well.
      (panel.id !== "shell" || !isMemberView),
  );
  // Runtime diagnostics read an installation. YAML edits the catalog template
  // and must also be reachable before the first installation.
  const diagnosticTabs = diagnosticPanels.filter(
    (panel) => panel.id === "yaml" || allInstalls.length > 0,
  );
  // Remote servers manage credentials; local servers manage hosted
  // installations. Built-ins need neither.
  const showConnectionsTab = variant !== "builtin" && !isPlaywright;
  const connectionsLayout = useConnectionsLayout({
    item,
    servers: allServersForCatalog,
    isServersPending,
    enabled: showConnectionsTab,
  });
  // A member sees Access only if they can change it; to them the list is
  // detail they can do nothing with. The same query the section's layout
  // reads, so this adds no request.
  const { data: sharingPolicy } = useResourcePermissions(
    "mcpRegistry",
    item.id,
    showConnectionsTab,
  );
  const canManagePermissions =
    sharingPolicy?.effectiveActions.includes("manage-permissions") ?? false;
  const showAccessSection =
    showConnectionsTab && (!isMemberView || canManagePermissions);

  // Overview and Credentials/Installations share the unified main page. Only
  // secondary operational views remain in the tab strip.
  const tabIds: DetailTab[] = [
    ...(showSavedLogins ? (["logins"] as const) : []),
    // A member's usage would list only their own agents.
    ...(isMemberView ? [] : (["usage"] as const)),
    ...diagnosticTabs.map((panel) => panel.id),
  ];

  // Deep links: ?tab=credentials|logs|inspector|shell|yaml opens that tab,
  // ?server=<installId> pre-selects the install in the logs view.
  const tabParam = searchParams.get("tab");
  const serverParam = searchParams.get("server");

  // Legacy Overview links and Credentials/Installations deep links resolve to
  // the unified main page. Secondary tabs remain URL-driven.
  const effectiveTab: DetailTab =
    tabParam && tabIds.includes(tabParam as DetailTab)
      ? (tabParam as DetailTab)
      : "overview";
  const reauthServer =
    tabParam === "credentials" && serverParam
      ? allServersForCatalog.find(
          (server) => server.id === serverParam && !!server.oauthRefreshError,
        )
      : undefined;
  const selectReauthServer = (server: InstalledServer) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "credentials");
    params.set("server", server.id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const closeReauthentication = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("server");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const [logsServerId, setLogsServerId] = useState<string | null>(serverParam);

  // The server's key configuration, as one always-visible strip.
  const spec = useMcpServerSpec({
    item,
    appName,
    environmentName:
      variant === "builtin"
        ? null
        : (environmentLabel ?? defaultEnvironment.name),
  });

  const tabHref = (tab: DetailTab) =>
    buildDetailTabHref({
      tab,
      pathname,
      searchParams: new URLSearchParams(searchParams.toString()),
    });

  // A member's view lists only their own installation, and a person has at
  // most one personal installation per server: the heading names one, and a
  // count could only read 0 or 1, so it shows none.
  const connectionsCount = isMemberView
    ? undefined
    : allServersForCatalog.length;
  const connectionsTitle =
    variant !== "local"
      ? "Credentials"
      : isMemberView
        ? "Installation"
        : "Installations";
  const assignedUsage = useMemo(
    () =>
      deriveAgentUsage({
        serversForCatalog: allServersForCatalog,
        autoModeAgents: undefined,
      }),
    [allServersForCatalog],
  );
  const { data: usageSummary } = useMcpUsageSummary({
    catalogId: item.id,
    assignedAgents: assignedUsage.assigned,
    enabled: !isMemberView,
    previews: false,
  });
  const agentUsageCount =
    usageSummary?.pagination.total ?? assignedUsage.assigned.length;

  const tabs: {
    label: React.ReactNode;
    href: string;
    testId?: string;
    selected?: boolean;
  }[] = [
    // The main page, named. Without it the tab strip is a one-way door:
    // opening Usage or Inspector left the reader with nothing pointing back
    // at the server's own details, only the back link out to the list.
    // `selected` rather than URL matching, because the main page is the
    // absence of `?tab=` and so is a prefix of every other tab's URL.
    {
      label: "Overview",
      href: tabHref("overview"),
      selected: effectiveTab === "overview",
    },
    ...(tabIds.includes("logins")
      ? [
          {
            label: (
              <TabLabel title="Saved logins" count={savedLogins?.length ?? 0} />
            ),
            href: tabHref("logins"),
            selected: effectiveTab === "logins",
          },
        ]
      : []),
    ...diagnosticTabs
      .filter((panel) => panel.id !== "yaml")
      .map((panel) => ({
        label: panel.title,
        href: tabHref(panel.id),
        selected: effectiveTab === panel.id,
      })),
    ...(tabIds.includes("usage")
      ? [
          {
            label: <TabLabel title="Usage" count={agentUsageCount} />,
            href: tabHref("usage"),
            selected: effectiveTab === "usage",
          },
        ]
      : []),
    ...diagnosticTabs
      .filter((panel) => panel.id === "yaml")
      .map((panel) => ({
        label: panel.title,
        href: tabHref(panel.id),
        selected: effectiveTab === panel.id,
      })),
  ];
  const isLogsTab =
    effectiveTab === "logs" ||
    effectiveTab === "inspector" ||
    effectiveTab === "shell";

  // Jump to the logs tab pre-targeting a specific pod (from the credentials list).
  const openPodLogs = (serverId: string) => {
    setLogsServerId(serverId);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "logs");
    params.set("server", serverId);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const install = useCatalogInstall();

  // "Chat" spins up (or reuses) a personal agent with this catalog's tools —
  // same flow and visibility gate as the registry card. The gate reads
  // `item.toolCount` (not the fetched `tools` list) to match the card exactly.
  const { startChat, isCreating: isChatCreating } = useChatWithCatalogItem();
  const isInstalledForViewer =
    isMcpServerInstalledForViewer(allServersForCatalog);
  const showChatButton = shouldShowMcpCardChatButton({
    toolsCount: item.toolCount ?? 0,
    isBuiltin: variant === "builtin",
    hasInstallation: isInstalledForViewer,
  });

  const [deleteRequested, setDeleteRequested] = useState(false);
  // Recreate the K8s pods with a freshly pulled image (local servers only).
  const refreshImageMutation = useRefreshInternalMcpCatalogImage();
  const canRestartPods =
    canModify && variant === "local" && deploymentServerIds.length > 0;

  // Credentials and Permissions were tabs once; their links now land on the
  // matching Overview section.
  useEffect(() => {
    const sectionId =
      tabParam === "credentials" && showConnectionsTab
        ? MCP_CONNECTIONS_SECTION_ID
        : tabParam === "permissions" && showAccessSection
          ? MCP_ACCESS_SECTION_ID
          : null;
    if (!sectionId) return;
    document.getElementById(sectionId)?.scrollIntoView?.({ block: "start" });
  }, [showAccessSection, showConnectionsTab, tabParam]);

  return (
    <PageLayout
      // The wizard's column, so Edit opens in the same one this page reads in.
      maxWidth="wizard"
      icon={<McpCatalogIcon icon={item.icon} catalogId={item.id} size={24} />}
      title={<span className="block min-w-0 truncate">{item.name}</span>}
      status={
        statusIssue ? undefined : (
          <ServerStatus
            variant={variant}
            deploymentSummary={deploymentSummary}
            deploymentFeedState={deploymentFeedState}
            isInstalledForViewer={isInstalledForViewer}
            singleInstallation={isMemberView}
          />
        )
      }
      documentTitle={item.name}
      backLink={<PageBackLink href="/mcp/registry">MCP Registry</PageBackLink>}
      description={
        effectiveTab === "yaml" ? undefined : (item.description ?? "")
      }
      tabs={tabs}
      // Saved logins adds a tab only the Playwright server has; on a phone
      // the diagnostics fold into "More" so the row does not crowd.
      mobileVisibleCount={tabIds.includes("logins") ? 2 : undefined}
      actionButton={
        <div className="flex shrink-0 items-center gap-2">
          {/* Once installed, the next step is a client: the Connect page puts
              these tools into Claude Code, Cursor and the rest. */}
          {showChatButton && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/connection">
                <Cable className="h-4 w-4" />
                {/* On a phone only the icons show, so the actions still fit
                    beside the title; the names stay for screen readers. */}
                <span className="max-sm:sr-only">Connect</span>
              </Link>
            </Button>
          )}
          {showChatButton && (
            <Button
              variant="outline"
              size="sm"
              disabled={isChatCreating}
              onClick={() => startChat(item)}
            >
              <MessageSquare className="h-4 w-4" />
              <span className="max-sm:sr-only">
                {isChatCreating ? "Creating..." : "Chat"}
              </span>
            </Button>
          )}
          {canModify && effectiveTab !== "yaml" && (
            <Button size="sm" asChild>
              <Link href={mcpServerActionHref(editAction)}>
                <Pencil className="h-4 w-4" />
                <span className="max-sm:sr-only">{editAction.label}</span>
              </Link>
            </Button>
          )}
          {(canRestartPods ||
            (userCanCreateCatalogItem && !isPlaywright) ||
            (canModify && !isPlaywright)) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">More actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canRestartPods && (
                  <DropdownMenuItem
                    disabled={refreshImageMutation.isPending}
                    onClick={() => refreshImageMutation.mutate(item.id)}
                  >
                    <RefreshCw
                      className={cn(
                        "h-4 w-4",
                        refreshImageMutation.isPending && "animate-spin",
                      )}
                    />
                    Restart pods with a fresh image
                  </DropdownMenuItem>
                )}
                {userCanCreateCatalogItem && !isPlaywright && (
                  <DropdownMenuItem
                    onClick={() =>
                      router.push(mcpServerActionHref(cloneAction))
                    }
                  >
                    <Copy className="h-4 w-4" />
                    {cloneAction.label}
                  </DropdownMenuItem>
                )}
                {canModify && !isPlaywright && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleteRequested(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {deleteAction.label}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {effectiveTab === "logins" && <PlaywrightSavedLoginsTab />}
        {effectiveTab === "usage" && (
          <McpServerPagedUsageTab
            catalogId={item.id}
            serversForCatalog={allServersForCatalog}
          />
        )}

        {effectiveTab === "overview" && (
          <div className="space-y-8">
            <CardIssues
              item={item}
              issues={itemIssues}
              servers={allServersForCatalog}
            />

            <McpServerConnectionPanel spec={spec} />

            <SettingsSectionGroup>
              {showConnectionsTab && (
                <SettingsSection
                  id={MCP_CONNECTIONS_SECTION_ID}
                  className="scroll-mt-24"
                  title={
                    <span
                      data-testid={
                        E2eTestId.McpServerSettingsConnectionsNavButton
                      }
                    >
                      <TabLabel
                        title={connectionsTitle}
                        count={connectionsCount}
                      />
                    </span>
                  }
                  // A member's list of only their own needs no explanation.
                  description={
                    isMemberView
                      ? undefined
                      : variant === "local"
                        ? getLocalInstallationCopy(item.multitenant === true)
                            .section
                        : "The credentials this server is used with."
                  }
                >
                  {reauthServer ? (
                    <InlineMcpReauthentication
                      item={item}
                      server={reauthServer}
                      onClose={closeReauthentication}
                      onCompleted={closeReauthentication}
                    />
                  ) : null}
                  {connectionsLayout === "pending" ? (
                    // Held until the sharing level is known, so a personal
                    // server does not flash the full tables first.
                    <Skeleton className="h-14 w-full rounded-lg" />
                  ) : (
                    <ManageUsersContent
                      personalOnly={connectionsLayout === "personal"}
                      isActive
                      onClose={() => {}}
                      label={item.name}
                      catalogId={item.id}
                      onAddPersonalConnection={() =>
                        install.addPersonalConnection(item)
                      }
                      onAddSharedConnection={(teamId) =>
                        install.addSharedConnection(item, teamId)
                      }
                      onAddOrgConnection={() => install.addOrgConnection(item)}
                      deploymentStatuses={deploymentStatuses}
                      hideHeader
                      bodyTestId={E2eTestId.McpServerSettingsConnectionsContent}
                      isInstalling={install.installingItemId === item.id}
                      onReauthenticate={selectReauthServer}
                      onOpenPodLogs={
                        variant === "local" ? openPodLogs : undefined
                      }
                    />
                  )}
                </SettingsSection>
              )}
              {showAccessSection && (
                <McpServerAccessSection
                  catalogId={item.id}
                  memberView={isMemberView}
                  onDirtyChange={setPermissionsDirty}
                />
              )}
              {/* Playwright has no installations or access to manage, so its
                  tools fill the page instead. */}
              {isPlaywright && <McpServerToolsSection catalogId={item.id} />}
            </SettingsSectionGroup>
          </div>
        )}

        {/* Diagnostics — Logs / Inspector / Shell share one mounted panel so the
          pod selector and live stream survive switching between them. */}
        {isLogsTab && (
          <McpServerConsole
            tab={LOGS_TAB_BY_ID[effectiveTab]}
            serverName={item.name}
            installs={debugInstalls}
            deploymentStatuses={deploymentStatuses}
            initialServerId={logsServerId}
          />
        )}

        {effectiveTab === "yaml" && (
          <div className="flex h-[calc(100dvh-16rem)] min-h-[480px] flex-col">
            <YamlConfigContent item={item} onClose={() => {}} hideHeader />
          </div>
        )}

        {/* Inline install flow (remote/local/no-auth/OAuth) — no navigation. */}
        {install.dialogs}

        <DeleteCatalogDialog
          item={deleteRequested ? item : null}
          onClose={() => setDeleteRequested(false)}
          onDeleted={onDeleted}
        />
      </div>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />
    </PageLayout>
  );
}

/**
 * How the Installations/Credentials section lays out. A server whose own
 * grants share it with nobody is "personal": only the viewer's own
 * installation matters, shown as one row. Anyone else's installation keeps
 * the full tables, so an admin never loses sight of other people's — and so
 * does a sharing level that is unknown or unreadable. "pending" holds the
 * section while the answer loads.
 */
function useConnectionsLayout({
  item,
  servers,
  isServersPending,
  enabled,
}: {
  item: CatalogItem;
  servers: InstalledServer[];
  isServersPending: boolean;
  enabled: boolean;
}): "pending" | "personal" | "full" {
  const { data: session, isPending: isSessionPending } = useSession();
  const sharing = useResourcePermissions("mcpRegistry", item.id, enabled);
  const currentUserId = session?.user?.id;
  const hasOthersInstallations =
    !!currentUserId &&
    servers.some(
      (server) =>
        !isPersonalInstallation(server) || server.ownerId !== currentUserId,
    );

  if (!enabled || hasOthersInstallations) return "full";
  if (isServersPending || isSessionPending || sharing.isPending) {
    return "pending";
  }
  if (sharing.data && grantsAudience(sharing.data.grants) === "personal") {
    return "personal";
  }
  return "full";
}

// `scope` is nullable on rows created before it existed; a team id implies a
// team installation, and everything else without a scope is personal.
function isPersonalInstallation(server: InstalledServer): boolean {
  return (server.scope ?? (server.teamId ? "team" : "personal")) === "personal";
}

/**
 * The server's key configuration: how it is reached and run, and how it
 * authenticates. The auth method is derived through the wizard's own
 * `transformCatalogItemToFormValues`, so the page cannot drift from the form
 * that wrote the values.
 *
 * The full record — OAuth endpoints, managed credentials, headers, run-time
 * arguments — is behind the same link the header's Edit uses, rather than
 * mirrored here a second time read-only.
 */
function useMcpServerSpec({
  item,
  appName,
  environmentName,
}: {
  item: CatalogItem;
  appName: string;
  environmentName: string | null;
}): McpServerSpec {
  const values = useMemo(() => transformCatalogItemToFormValues(item), [item]);
  const _hibernation = useIdleHibernationFact(item);
  // Only the derivation comes from the form shape (the auth method): its
  // `localConfig` is textarea-shaped — `arguments` is one newline-joined
  // string there — so everything factual reads the API's own object.
  const local = item.localConfig;
  const serverType =
    item.serverType === "builtin"
      ? "builtin"
      : item.serverType === "remote"
        ? "remote"
        : "local";
  // The runtime treats an unset transport as stdio, so only an explicit
  // streamable-http shows the HTTP label.
  const isHttp = local?.transportType === "streamable-http";

  return {
    serverType,
    hosting:
      serverType === "builtin"
        ? `Built into ${appName}`
        : serverType === "local"
          ? "Managed deployment"
          : "External server",
    environment: environmentName,
    serverUrl:
      serverType === "remote" ? (item.serverUrl ?? undefined) : undefined,
    transport:
      serverType === "local"
        ? isHttp
          ? "Streamable HTTP"
          : "stdio"
        : undefined,
    transportDetail:
      serverType === "local" && isHttp && (local?.httpPort || local?.httpPath)
        ? `${local?.httpPort ?? 8080}${local?.httpPath ?? "/mcp"}`
        : undefined,
    deployment:
      serverType === "local"
        ? values.multitenant
          ? { label: "Multi-tenant", detail: "One shared deployment" }
          : { label: "Single-tenant", detail: "One per installation" }
        : undefined,
    dockerImage:
      serverType === "local" ? (local?.dockerImage ?? undefined) : undefined,
    command:
      serverType === "local" && local?.command
        ? [local.command, ...(local.arguments ?? [])]
        : undefined,
    auth: AUTH_METHOD_LABEL[values.authMethod],
    createdBy: item.createdBy ?? null,
    toolCount: item.toolCount ?? 0,
    interactiveTools: !!item.providesUi,
    skillCount: item.providesSkills ? (item.skillCount ?? 0) : undefined,
  };
}

/**
 * The per-server idle-hibernation override, read-only — mirroring the edit
 * page's own section, and absent when there is none: only a self-hosted
 * server in an organization that hibernates idle servers has one. The value
 * lives on the install rows, and a reinstall can move one of them alone, so
 * divergence reads as "Mixed" rather than whichever row happens to be first.
 */
function useIdleHibernationFact(item: CatalogItem): OverviewFact[] {
  const { data: organization } = useOrganization();
  const enterpriseCoreActive = useEnterpriseFeature("core");
  const hibernationBeta = useFeature("mcpIdleHibernationBetaEnabled");
  // Only this item's installs, without agents: the fact reads their modes.
  const { data: servers = [] } = useMcpServers({
    includeAssignedAgents: false,
    catalogId: item.id,
  });

  if (
    item.serverType !== "local" ||
    !hibernationBeta ||
    !enterpriseCoreActive ||
    !organization?.mcpIdleHibernationEnabled
  ) {
    return [];
  }

  const modes = [
    ...new Set(
      servers
        .filter((server) => server.catalogId === item.id)
        .map((server) => server.hibernationMode ?? "inherit"),
    ),
  ];
  const mode = modes.length === 1 ? modes[0] : undefined;
  const label = mode ? HIBERNATION_COPY[mode] : undefined;

  return [
    {
      label: "Idle hibernation",
      value: (
        <span>{label ?? (modes.length === 0 ? "Not installed" : "Mixed")}</span>
      ),
    },
  ];
}

/** What each hibernation choice means for a server that goes idle. */
const HIBERNATION_COPY: Record<string, string> = {
  inherit: "Organization setting",
  enabled: "Always allowed",
  disabled: "Never",
};

/** One compact subject card. Editing starts from the page header. */
function _DetailCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function _FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

/**
 * Runtime state for the Status card. Outstanding issues live beside the page
 * title and in their owning configuration card, so they are not repeated here.
 */
function ServerStatus({
  variant,
  deploymentSummary,
  deploymentFeedState,
  isInstalledForViewer,
  singleInstallation,
}: {
  variant: "builtin" | "local" | "remote";
  deploymentSummary: DeploymentStatusSummary | null;
  /** Whether pod statuses can arrive at all, and whether any have yet. */
  deploymentFeedState: McpDeploymentFeedState;
  /** The registry card's rule, so this page and the card's Install agree. */
  isInstalledForViewer: boolean;
  /**
   * The viewer sees only their own installation, so a ratio could only read
   * 0/1 or 1/1: the state alone says it.
   */
  singleInstallation: boolean;
}) {
  if (variant === "builtin") {
    return <Badge variant="secondary">Built-in</Badge>;
  }
  // Somebody else's connection (visible to an admin) does not install the
  // server for the viewer, however its pod is doing.
  if (!isInstalledForViewer) {
    return <span className={typeRole({ role: "body" })}>Not installed</span>;
  }
  // A dot is a claim about a pod, so it is drawn only where a pod's state was
  // actually reported.
  if (deploymentSummary) {
    return (
      <span className="inline-flex items-center gap-2">
        <DeploymentStatusDot state={deploymentSummary.overallState} />
        {/* On a phone the dot alone says it, leaving the title its room. */}
        <span className={cn(typeRole({ role: "body" }), "max-sm:sr-only")}>
          {singleInstallation
            ? getDeploymentLabel(deploymentSummary.overallState)
            : getDeploymentStatusChipLabel({
                summary: deploymentSummary,
                format: "ratio-with-state",
              })}
        </span>
      </span>
    );
  }
  // No summary means no deployment entry for any of this server's ids. The
  // feed's own state decides what that means, never the absence of an entry
  // — the same rule the list's `installedStatusLabel` follows. A remote
  // server has no pod at all, and the page of an installed server needs no
  // label that says so, so it shows nothing.
  if (variant === "remote" || deploymentFeedState === "disabled") {
    return null;
  }
  return (
    <span className={typeRole({ role: "body" })}>
      {deploymentFeedState === "loading" ||
      deploymentFeedState === "reconnecting"
        ? "Checking…"
        : "Status unavailable"}
    </span>
  );
}

/** Keep operational failures visible even while Overview is collapsed. */
function CardIssues({
  item,
  issues,
  servers,
}: {
  item: CatalogItem;
  issues: McpServerIssue[];
  servers: InstalledServer[];
}) {
  if (issues.length === 0) return null;
  return (
    <McpServerIssueNotice
      item={item}
      issues={issues}
      servers={servers}
      hideName
      panelActions="dismiss-only"
      className="bg-muted/40"
    />
  );
}

function _SubHeading({ label }: { label: string }) {
  return <p className={typeRole({ role: "label" })}>{label}</p>;
}

/** Authentication method names from the wizard, without its helper prose. */
const AUTH_METHOD_LABEL: Record<McpCatalogFormValues["authMethod"], string> = {
  none: "None",
  bearer: "Access token header (legacy)",
  auth_header: "Token header",
  oauth: "OAuth 2.1",
  oauth_client_credentials: "OAuth client credentials",
  enterprise_managed: "Identity provider exchange",
  idp_jwt: "Identity provider JWT",
};

function _OverviewField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <div className={typeRole({ role: "label" })}>{label}</div>
      <div className={cn(typeRole({ role: "body" }), "break-words")}>
        {children}
      </div>
    </div>
  );
}

function ItemPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-14 w-14 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 rounded-xl lg:col-span-2" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

/**
 * Tab label with an optional count, abbreviated past a thousand (130K) so a
 * busy server does not stretch the tab row; the exact figure is on hover. The e2e hook belongs on the tab's `testId`
 * rather than here — PageLayout renders each label in its desktop row, its
 * mobile row and possibly an overflow popover, so a test id on the label
 * resolves to several elements at once.
 */
function TabLabel({ title, count }: { title: string; count?: number }) {
  return (
    <span className="flex items-center gap-1">
      <span>{title}</span>
      {count !== undefined && count > 0 && (
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title={count >= 1000 ? count.toLocaleString() : undefined}
        >
          {formatCompactNumber(count)}
        </span>
      )}
    </span>
  );
}
