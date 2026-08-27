"use client";

import { E2eTestId, isPlaywrightCatalogItem } from "@archestra/shared";
import {
  ArrowLeft,
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
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  type OverviewFact,
  OverviewSummary,
} from "@/components/overview-summary";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { typeRole } from "@/lib/design/type-scale";
import { useEnvironments } from "@/lib/environment.query";
import {
  useInternalMcpCatalog,
  useRefreshInternalMcpCatalogImage,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type McpDeploymentFeedState,
  useAutoModeAgents,
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import { useCanModifyCatalogItem } from "../_parts/catalog-edit-access";
import { resolveCatalogEnvironmentLabel } from "../_parts/catalog-environment-label";
import { shouldShowMcpCardChatButton } from "../_parts/chat-button-visibility";
import { collapseMultitenantInstalls } from "../_parts/collapse-multitenant-installs";
import { DeleteCatalogDialog } from "../_parts/delete-catalog-dialog";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  type DeploymentStatusSummary,
  getDeploymentStatusChipLabel,
} from "../_parts/deployment-status";
import { buildDetailTabHref } from "../_parts/detail-tab-href";
import { InlineMcpReauthentication } from "../_parts/inline-mcp-reauthentication";
import { ManageUsersContent } from "../_parts/manage-users-dialog";
import { McpCapabilityBadges } from "../_parts/mcp-capability-badges";
import { transformCatalogItemToFormValues } from "../_parts/mcp-catalog-form.utils";
import { McpLogsContent, type McpLogsTab } from "../_parts/mcp-logs-dialog";
import {
  getMcpServerActionModel,
  mcpServerAction,
  mcpServerActionHref,
} from "../_parts/mcp-server-actions-model";
import { deriveAgentUsage } from "../_parts/mcp-server-agent-usage";
import type { CatalogItem, InstalledServer } from "../_parts/mcp-server-card";
import { McpServerIssueNotice } from "../_parts/mcp-server-issue-notice";
import { McpServerUsageTab } from "../_parts/mcp-server-usage-tab";
import { useCatalogInstall } from "../_parts/use-catalog-install";
import { useChatWithCatalogItem } from "../_parts/use-chat-with-catalog-item";
import { YamlConfigContent } from "../_parts/yaml-config-dialog";

type DetailTab =
  | "overview"
  | "usage"
  | "credentials"
  | "logs"
  | "inspector"
  | "shell"
  | "yaml";

const DIAGNOSTIC_PANELS: Array<{
  id: Exclude<DetailTab, "overview">;
  title: string;
  logsTab?: McpLogsTab;
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

// The Logs/Inspector/Shell tabs share one mounted <McpLogsContent>; this maps
// the page-level tab id to that component's internal tab.
const LOGS_TAB_BY_ID: Record<string, McpLogsTab> = {
  logs: "logs",
  inspector: "inspector",
  shell: "debug",
};

const MCP_CONNECTIONS_SECTION_ID = "connections";

export function McpCatalogItemPage({ id }: { id: string }) {
  const router = useRouter();
  const { data: catalogItems, isPending } = useInternalMcpCatalog({});
  const item = catalogItems?.find((catalogItem) => catalogItem.id === id);

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
        backLink={<BackToRegistryLink />}
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
        backLink={<BackToRegistryLink />}
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

function BackToRegistryLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      asChild
    >
      <Link href="/mcp/registry">
        <ArrowLeft className="h-4 w-4" />
        MCP Registry
      </Link>
    </Button>
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

  const { data: allMcpServers } = useMcpServers();
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

  const allServersForCatalog = (allMcpServers ?? []).filter(
    (s) => s.catalogId === item.id,
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

  const diagnosticPanels = DIAGNOSTIC_PANELS.filter(
    (panel) => variant === "local" || !panel.localOnly,
  );
  // Diagnostics need at least one install to read from.
  const diagnosticTabs = allInstalls.length > 0 ? diagnosticPanels : [];
  // Remote servers manage credentials; local servers manage hosted
  // installations. Built-ins need neither.
  const showConnectionsTab = variant !== "builtin";

  // Overview and Credentials/Installations share the unified main page. Only
  // secondary operational views remain in the tab strip.
  const tabIds: DetailTab[] = [
    "usage",
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

  // The server's key configuration, as one always-visible row.
  const overviewFacts = useMcpServerOverviewFacts(item);

  const tabHref = (tab: DetailTab) =>
    buildDetailTabHref({
      tab,
      pathname,
      searchParams: new URLSearchParams(searchParams.toString()),
    });

  const connectionsCount = allServersForCatalog.length;
  const { data: autoModeAgents } = useAutoModeAgents();
  const agentUsageCount = deriveAgentUsage({
    serversForCatalog: allServersForCatalog,
    autoModeAgents,
  }).total;

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
    {
      label: <TabLabel title="Usage" count={agentUsageCount} />,
      href: tabHref("usage"),
      selected: effectiveTab === "usage",
    },
    ...diagnosticTabs.map((panel) => ({
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
  const showChatButton = shouldShowMcpCardChatButton({
    toolsCount: item.toolCount ?? 0,
    isBuiltin: variant === "builtin",
    hasInstallation: allServersForCatalog.length > 0,
  });

  const [deleteRequested, setDeleteRequested] = useState(false);
  // Recreate the K8s pods with a freshly pulled image (local servers only).
  const refreshImageMutation = useRefreshInternalMcpCatalogImage();
  const canRestartPods =
    canModify && variant === "local" && deploymentServerIds.length > 0;

  useEffect(() => {
    if (tabParam !== "credentials" || !showConnectionsTab) return;
    document
      .getElementById(MCP_CONNECTIONS_SECTION_ID)
      ?.scrollIntoView?.({ block: "start" });
  }, [showConnectionsTab, tabParam]);

  return (
    <PageLayout
      // The wizard's column, so Edit opens in the same one this page reads in.
      maxWidth="wizard"
      title={
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <McpCatalogIcon icon={item.icon} catalogId={item.id} size={24} />
          </div>
          <span className="min-w-0 truncate">{item.name}</span>
          <Badge variant="secondary" className="capitalize font-normal">
            {item.serverType}
          </Badge>
          <McpCapabilityBadges
            providesUi={item.providesUi}
            providesSkills={item.providesSkills}
            skillCount={item.skillCount}
          />
          {item.serverType !== "builtin" && (
            <Badge variant="outline" className="font-normal">
              {environmentLabel ?? defaultEnvironment.name}
            </Badge>
          )}
        </div>
      }
      status={
        statusIssue ? undefined : (
          <ServerStatus
            variant={variant}
            deploymentSummary={deploymentSummary}
            deploymentFeedState={deploymentFeedState}
            connectionsCount={connectionsCount}
          />
        )
      }
      documentTitle={item.name}
      backLink={<BackToRegistryLink />}
      description={item.description ?? ""}
      tabs={tabs}
      actionButton={
        <div className="flex shrink-0 items-center gap-2">
          {showChatButton && (
            <Button
              variant="outline"
              disabled={isChatCreating}
              onClick={() => startChat(item)}
            >
              <MessageSquare className="h-4 w-4" />
              {isChatCreating ? "Creating..." : "Chat"}
            </Button>
          )}
          {canModify && (
            <Button asChild>
              <Link href={mcpServerActionHref(editAction)}>
                <Pencil className="h-4 w-4" />
                {editAction.label}
              </Link>
            </Button>
          )}
          {(canRestartPods ||
            (userCanCreateCatalogItem && !isPlaywright) ||
            (canModify && !isPlaywright)) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
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
        {effectiveTab === "usage" && (
          <McpServerUsageTab
            serversForCatalog={allServersForCatalog}
            autoModeAgents={autoModeAgents}
          />
        )}

        {effectiveTab === "overview" && (
          <div className="space-y-10">
            {item.serverType !== "builtin" && (
              <OverviewSummary
                headingId="mcp-overview-heading"
                facts={overviewFacts}
                configHref={
                  canModify ? mcpServerActionHref(editAction) : undefined
                }
              />
            )}

            <CardIssues
              item={item}
              issues={itemIssues}
              servers={allServersForCatalog}
            />

            {showConnectionsTab && (
              <section
                id={MCP_CONNECTIONS_SECTION_ID}
                aria-labelledby="mcp-connections-heading"
                className="scroll-mt-24 space-y-4"
              >
                <h2
                  id="mcp-connections-heading"
                  className="text-base font-semibold tracking-tight text-foreground"
                  data-testid={E2eTestId.McpServerSettingsConnectionsNavButton}
                >
                  <TabLabel
                    title={
                      variant === "local" ? "Installations" : "Credentials"
                    }
                    count={connectionsCount}
                  />
                </h2>
                <div className="space-y-4 rounded-lg border bg-card p-4">
                  {reauthServer ? (
                    <InlineMcpReauthentication
                      item={item}
                      server={reauthServer}
                      onClose={closeReauthentication}
                      onCompleted={closeReauthentication}
                    />
                  ) : null}
                  <ManageUsersContent
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
                </div>
              </section>
            )}
          </div>
        )}

        {/* Diagnostics — Logs / Inspector / Shell share one mounted panel so the
          pod selector and live stream survive switching between them. */}
        {isLogsTab && (
          <Card className="py-0">
            <div className="flex h-[calc(100dvh-16rem)] min-h-[480px] flex-col p-6">
              <McpLogsContent
                isActive={isLogsTab}
                serverName={item.name}
                installs={debugInstalls}
                deploymentStatuses={deploymentStatuses}
                hideHeader
                hideTabBar
                controlledTab={LOGS_TAB_BY_ID[effectiveTab]}
                initialServerId={logsServerId}
              />
            </div>
          </Card>
        )}

        {effectiveTab === "yaml" && (
          <Card className="py-0">
            <div className="flex h-[calc(100dvh-16rem)] min-h-[480px] flex-col p-6">
              <YamlConfigContent item={item} onClose={() => {}} hideHeader />
            </div>
          </Card>
        )}

        {/* Inline install flow (remote/local/no-auth/OAuth) — no navigation. */}
        {install.dialogs}

        <DeleteCatalogDialog
          item={deleteRequested ? item : null}
          onClose={() => setDeleteRequested(false)}
          onDeleted={onDeleted}
        />
      </div>
    </PageLayout>
  );
}

/**
 * The server's key configuration, as one row: how it is reached and run, and
 * how it authenticates. Derived through the wizard's own
 * `transformCatalogItemToFormValues`, so the page cannot drift from the form
 * that wrote the values.
 *
 * The full record — OAuth endpoints, managed credentials, headers, run-time
 * arguments — is behind the same link the header's Edit uses, rather than
 * mirrored here a second time read-only.
 */
function useMcpServerOverviewFacts(item: CatalogItem): OverviewFact[] {
  const values = useMemo(() => transformCatalogItemToFormValues(item), [item]);
  const _hibernation = useIdleHibernationFact(item);
  // Only the derivation comes from the form shape (the auth method): its
  // `localConfig` is textarea-shaped — `arguments` is one newline-joined
  // string there — so everything factual reads the API's own object.
  const local = item.localConfig;
  const facts: OverviewFact[] = [];

  if (item.serverType === "remote" && item.serverUrl) {
    facts.push({
      label: "Server URL",
      value: <CodeLine>{item.serverUrl}</CodeLine>,
    });
  }

  if (item.serverType === "local") {
    facts.push({
      label: "Transport",
      value:
        local?.transportType === "stdio" ? (
          <span>stdio</span>
        ) : (
          <span>
            Streamable HTTP
            {local?.httpPort || local?.httpPath ? (
              <span className="text-muted-foreground">
                {" "}
                · {local?.httpPort ?? 8080}
                {local?.httpPath ?? "/mcp"}
              </span>
            ) : null}
          </span>
        ),
    });
    facts.push({
      label: "Deployment",
      value: (
        <span>
          {values.multitenant
            ? "Multi-tenant — one shared deployment"
            : "Single-tenant — one per installation"}
        </span>
      ),
    });
    if (local?.dockerImage) {
      facts.push({
        label: "Image",
        value: <CodeLine>{local.dockerImage}</CodeLine>,
      });
    }
  }

  facts.push({
    label: "Authentication",
    value: (
      <span>
        {AUTH_METHOD_LABEL[values.authMethod] ?? AUTH_METHOD_LABEL.none}
      </span>
    ),
  });

  return facts;
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
  const { data: servers = [] } = useMcpServers();

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
  connectionsCount,
}: {
  variant: "builtin" | "local" | "remote";
  deploymentSummary: DeploymentStatusSummary | null;
  /** Whether pod statuses can arrive at all, and whether any have yet. */
  deploymentFeedState: McpDeploymentFeedState;
  connectionsCount: number;
}) {
  if (variant === "builtin") {
    return <Badge variant="secondary">Built-in</Badge>;
  }
  // A dot is a claim about a pod, so it is drawn only where a pod's state was
  // actually reported.
  if (deploymentSummary) {
    return (
      <span className="inline-flex items-center gap-2">
        <DeploymentStatusDot state={deploymentSummary.overallState} />
        <span className={typeRole({ role: "body" })}>
          {getDeploymentStatusChipLabel({
            summary: deploymentSummary,
            format: "ratio-with-state",
          })}
        </span>
      </span>
    );
  }
  if (connectionsCount > 0) {
    // No summary means no deployment entry for any of this server's ids. The
    // feed's own state decides what that means, never the absence of an entry
    // — the same rule the list's `installedStatusLabel` follows. A remote
    // server has no pod at all, so "Installed" is its whole runtime story.
    return (
      <span className={typeRole({ role: "body" })}>
        {variant === "remote" || deploymentFeedState === "disabled"
          ? "Installed"
          : deploymentFeedState === "loading"
            ? "Checking…"
            : "Status unavailable"}
      </span>
    );
  }
  return <span className={typeRole({ role: "body" })}>Not installed</span>;
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

function CodeLine({ children }: { children: ReactNode }) {
  return (
    <code className="block overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 font-mono text-xs">
      {children}
    </code>
  );
}

/** Authentication method names from the wizard, without its helper prose. */
const AUTH_METHOD_LABEL: Record<string, string> = {
  none: "None",
  bearer: "Token header",
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
 * Tab label with an optional count. The e2e hook belongs on the tab's `testId`
 * rather than here — PageLayout renders each label in its desktop row, its
 * mobile row and possibly an overflow popover, so a test id on the label
 * resolves to several elements at once.
 */
function TabLabel({ title, count }: { title: string; count: number }) {
  return (
    <span className="flex items-center gap-1">
      <span>{title}</span>
      {count > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </span>
  );
}
