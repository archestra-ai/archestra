"use client";

import {
  E2eTestId,
  isPlaywrightCatalogItem,
  MCP_CATALOG_CLONE_QUERY_PARAM,
  parseFullToolName,
} from "@archestra/shared";
import {
  ArrowLeft,
  Copy,
  MessageSquare,
  MoreHorizontal,
  PackageX,
  Pencil,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import {
  useCatalogTools,
  useInternalMcpCatalog,
  useRefreshInternalMcpCatalogImage,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { cn, formatDate } from "@/lib/utils";
import { useCanModifyCatalogItem } from "../_parts/catalog-edit-access";
import { resolveCatalogEnvironmentLabel } from "../_parts/catalog-environment-label";
import { shouldShowMcpCardChatButton } from "../_parts/chat-button-visibility";
import { ConfigurationTab } from "../_parts/configuration-tab";
import { DeleteCatalogDialog } from "../_parts/delete-catalog-dialog";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  getDeploymentStatusChipLabel,
} from "../_parts/deployment-status";
import { buildDetailTabHref } from "../_parts/detail-tab-href";
import { ManageUsersContent } from "../_parts/manage-users-dialog";
import { McpLogsContent, type McpLogsTab } from "../_parts/mcp-logs-dialog";
import { deriveAgentUsage } from "../_parts/mcp-server-agent-usage";
import type { CatalogItem } from "../_parts/mcp-server-card";
import { McpServerUsageTab } from "../_parts/mcp-server-usage-tab";
import { useCatalogInstall } from "../_parts/use-catalog-install";
import { useChatWithCatalogItem } from "../_parts/use-chat-with-catalog-item";
import { YamlConfigContent } from "../_parts/yaml-config-dialog";

type DetailTab =
  | "overview"
  | "configuration"
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

// How many tools to preview on the Overview before linking out to guardrails.
const TOOLS_PREVIEW_LIMIT = 6;

export function McpCatalogItemPage({ id }: { id: string }) {
  const { data: catalogItems, isPending } = useInternalMcpCatalog({});
  const item = catalogItems?.find((catalogItem) => catalogItem.id === id);

  if (isPending) {
    return (
      <PageLayout
        title="MCP Server"
        description=""
        backLink={<BackToRegistryLink />}
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

  return <CatalogItemDetails item={item} />;
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

function CatalogItemDetails({ item }: { item: CatalogItem }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const variant =
    item.serverType === "builtin"
      ? "builtin"
      : item.serverType === "remote"
        ? "remote"
        : "local";
  const isPlaywright = isPlaywrightCatalogItem(item.id);

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { canModify } = useCanModifyCatalogItem(
    variant !== "builtin" ? item : null,
  );
  const { data: userCanCreateCatalogItem } = useHasPermissions({
    mcpRegistry: ["create"],
  });

  const { data: allMcpServers } = useMcpServers();
  const deploymentStatuses = useMcpDeploymentStatuses();
  useMcpInstallationStatusCacheSync();
  const { data: tools = [] } = useCatalogTools(item.id);

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
  const hasPersonalConnection = allServersForCatalog.some(
    (s) => s.ownerId === currentUserId && !s.teamId,
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

  // Multi-tenant catalogs alias one pod; pick the install whose deployment
  // status is reported, otherwise the first row, and label by catalog.
  const debugInstalls = item.multitenant
    ? (() => {
        const reporting =
          allInstalls.find((i) => deploymentStatuses[i.id]?.podName) ??
          allInstalls[0];
        return reporting
          ? [
              {
                ...reporting,
                name: item.name,
                ownerEmail: null,
                teamDetails: null,
                scope: null,
              },
            ]
          : [];
      })()
    : allInstalls;

  const diagnosticPanels = DIAGNOSTIC_PANELS.filter(
    (panel) => variant === "local" || !panel.localOnly,
  );
  // Diagnostics need at least one install to read from.
  const diagnosticTabs = allInstalls.length > 0 ? diagnosticPanels : [];
  // Remote servers manage credentials; local servers manage hosted
  // installations. Built-ins need neither.
  const showConnectionsTab = variant !== "builtin";

  // Every tab beyond the always-present Overview dashboard. Usage is always
  // present: "nothing uses this yet" is itself an answer, and it keeps the
  // ?tab=usage deep link from the registry card's hover card always resolvable.
  const tabIds: DetailTab[] = [
    "configuration",
    "usage",
    ...(showConnectionsTab ? (["credentials"] as DetailTab[]) : []),
    ...diagnosticTabs.map((panel) => panel.id),
  ];

  // Deep links: ?tab=credentials|logs|inspector|shell|yaml opens that tab,
  // ?server=<installId> pre-selects the install in the logs view.
  const tabParam = searchParams.get("tab");
  const serverParam = searchParams.get("server");

  // The URL is the single source of truth for the selected tab — the tab bar
  // renders links, so a click, a shared deep link and the back button all take
  // the same path. A ?tab= naming a tab that isn't available yet (diagnostics
  // appear only once an install loads) falls back to Overview and resolves on
  // its own when the tab shows up.
  const effectiveTab: DetailTab =
    tabParam && tabIds.includes(tabParam as DetailTab)
      ? (tabParam as DetailTab)
      : "overview";

  const [logsServerId, setLogsServerId] = useState<string | null>(serverParam);

  const tabHref = (tab: DetailTab) =>
    buildDetailTabHref({
      tab,
      pathname,
      searchParams: new URLSearchParams(searchParams.toString()),
    });

  const connectionsCount = allServersForCatalog.length;
  const agentUsageCount = deriveAgentUsage(allServersForCatalog).total;

  const tabs: { label: React.ReactNode; href: string; testId?: string }[] = [
    { label: "Overview", href: tabHref("overview") },
    { label: "Configuration", href: tabHref("configuration") },
    {
      label: <TabLabel title="Usage" count={agentUsageCount} />,
      href: tabHref("usage"),
    },
    ...(showConnectionsTab
      ? [
          {
            label: (
              <TabLabel
                title={variant === "local" ? "Installations" : "Credentials"}
                count={connectionsCount}
              />
            ),
            href: tabHref("credentials"),
            testId: E2eTestId.McpServerSettingsConnectionsNavButton,
          },
        ]
      : []),
    ...diagnosticTabs.map((panel) => ({
      label: panel.title,
      href: tabHref(panel.id),
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

  // Install inline on this page (no navigation). The dialog lets the user pick
  // scope/credential; the add-* helpers pre-target a personal/team/org scope.
  const install = useCatalogInstall();
  const openInstall = () =>
    item.serverType === "local"
      ? install.installLocal(item)
      : install.installRemote(item);

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

  const statusText =
    variant === "local"
      ? deploymentSummary
        ? getDeploymentStatusChipLabel({
            summary: deploymentSummary,
            format: "ratio-with-state",
          })
        : "Not connected"
      : connectionsCount > 0
        ? "Connected"
        : "Not connected";

  const endpoint =
    variant === "remote"
      ? item.serverUrl
      : variant === "local"
        ? [item.localConfig?.command, ...(item.localConfig?.arguments ?? [])]
            .filter(Boolean)
            .join(" ") ||
          item.localConfig?.dockerImage ||
          null
        : null;

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <McpCatalogIcon icon={item.icon} catalogId={item.id} size={24} />
          </div>
          <span className="min-w-0 truncate">{item.name}</span>
          <Badge variant="secondary" className="capitalize font-normal">
            {item.serverType}
          </Badge>
        </div>
      }
      documentTitle={item.name}
      backLink={<BackToRegistryLink />}
      description={item.description ?? ""}
      tabs={tabs}
      actionButton={
        <div className="flex shrink-0 items-center gap-2">
          {!hasPersonalConnection && variant !== "builtin" && (
            <Button variant="outline" onClick={openInstall}>
              <PlugZap className="h-4 w-4" />
              Connect
            </Button>
          )}
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
              <Link href={`/mcp/registry/${item.id}/edit`}>
                <Pencil className="h-4 w-4" />
                Edit
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
                      router.push(
                        `/mcp/registry/new?${MCP_CATALOG_CLONE_QUERY_PARAM}=${item.id}`,
                      )
                    }
                  >
                    <Copy className="h-4 w-4" />
                    Clone
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
                      Delete
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
          <McpServerUsageTab serversForCatalog={allServersForCatalog} />
        )}

        {effectiveTab === "configuration" && (
          <ConfigurationTab item={item} canModify={canModify} />
        )}

        {effectiveTab === "overview" && (
          <div className="space-y-4">
            {/* Capabilities + details */}
            <div className="grid items-start gap-4 lg:grid-cols-3">
              {/* Tools the server exposes */}
              <Card className="lg:col-span-2">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <CardTitle>
                        Tools
                        {!!(tools.length || item.toolCount) && (
                          <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
                            {tools.length || item.toolCount}
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription>
                        Capabilities this server exposes to agents.
                      </CardDescription>
                    </div>
                    {tools.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        asChild
                        className="-mr-2 shrink-0 text-muted-foreground"
                      >
                        <Link href={`/mcp/registry/${item.id}/edit?step=tools`}>
                          <ShieldCheck className="h-4 w-4" />
                          Guardrails
                        </Link>
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {tools.length === 0 ? (
                    <Empty className="border-0 py-8">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ShieldCheck />
                        </EmptyMedia>
                        <EmptyTitle>No tools discovered yet</EmptyTitle>
                        <EmptyDescription>
                          Tools appear once the server is connected and
                          reachable.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <>
                      <ul className="divide-y divide-border">
                        {tools.slice(0, TOOLS_PREVIEW_LIMIT).map((tool) => (
                          <li
                            key={tool.name}
                            className="py-2.5 first:pt-0 last:pb-0"
                          >
                            <code className="font-mono text-sm font-medium">
                              {parseFullToolName(tool.name).toolName ||
                                tool.name}
                            </code>
                            {tool.description && (
                              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                                {tool.description}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                      {tools.length > TOOLS_PREVIEW_LIMIT && (
                        <Link
                          href={`/mcp/registry/${item.id}/edit?step=tools`}
                          className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
                        >
                          View all {tools.length} tools
                        </Link>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Server details — operational summary */}
              <Card>
                <CardContent className="space-y-4 text-sm">
                  <OverviewField label="Status">
                    <span className="inline-flex items-center gap-2">
                      {deploymentSummary ? (
                        <DeploymentStatusDot
                          state={deploymentSummary.overallState}
                        />
                      ) : connectionsCount > 0 ? (
                        <DeploymentStatusDot state="running" />
                      ) : null}
                      <span>{statusText}</span>
                    </span>
                  </OverviewField>
                  {variant !== "builtin" && (
                    <OverviewField label="Environment">
                      {environmentLabel ?? defaultEnvironment.name}
                    </OverviewField>
                  )}
                  <OverviewField label="Accessible to">
                    {/*
                      `showSelfAsMe` because this is a labelled field rather
                      than one badge among many in a list: the viewer's own
                      personal server must still say "Me" instead of leaving
                      the field blank.
                    */}
                    <ResourceVisibilityBadge
                      scope={item.scope}
                      teams={item.teams}
                      authorId={item.authorId}
                      authorName={item.authorName}
                      currentUserId={currentUserId}
                      showSelfAsMe
                    />
                  </OverviewField>
                  {endpoint && (
                    <OverviewField
                      label={variant === "remote" ? "Server URL" : "Command"}
                    >
                      <code className="block overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 font-mono text-xs">
                        {endpoint}
                      </code>
                    </OverviewField>
                  )}
                  <OverviewField label="Created">
                    {formatDate({ date: item.createdAt, dateFormat: "PP" })}
                  </OverviewField>
                  {item.labels.length > 0 && (
                    <OverviewField label="Labels">
                      <div className="flex flex-wrap gap-1.5">
                        {item.labels.map((label) => (
                          <Badge
                            key={`${label.key}-${label.value}`}
                            variant="outline"
                            className="font-normal"
                          >
                            {label.key}: {label.value}
                          </Badge>
                        ))}
                      </div>
                    </OverviewField>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {effectiveTab === "credentials" && showConnectionsTab && (
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold">
                {variant === "local" ? "Installations" : "Credentials"}
              </h2>
            </CardHeader>
            <CardContent>
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
                onOpenPodLogs={variant === "local" ? openPodLogs : undefined}
              />
            </CardContent>
          </Card>
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
          onDeleted={() => router.push("/mcp/registry")}
        />
      </div>
    </PageLayout>
  );
}

function OverviewField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
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
