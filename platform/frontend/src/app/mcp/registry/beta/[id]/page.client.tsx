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
  MoreHorizontal,
  PackageX,
  Pencil,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useCanModifyCatalogItem } from "../../_parts/catalog-edit-access";
import { resolveCatalogEnvironmentLabel } from "../../_parts/catalog-environment-label";
import { DeleteCatalogDialog } from "../../_parts/delete-catalog-dialog";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  getDeploymentLabel,
} from "../../_parts/deployment-status";
import { McpLogsContent, type McpLogsTab } from "../../_parts/mcp-logs-dialog";
import { YamlConfigContent } from "../../_parts/yaml-config-dialog";
import { ManageUsersContent } from "../_parts/manage-users-dialog";
import type { CatalogItem } from "../_parts/mcp-server-card";
import { useCatalogInstall } from "../_parts/use-catalog-install";

type DetailTab =
  | "overview"
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

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        asChild
      >
        <Link href="/mcp/registry/beta">
          <ArrowLeft className="h-4 w-4" />
          MCP Registry
        </Link>
      </Button>

      {isPending ? (
        <ItemPageSkeleton />
      ) : !item ? (
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
      ) : (
        <CatalogItemDetails item={item} />
      )}
    </div>
  );
}

function CatalogItemDetails({ item }: { item: CatalogItem }) {
  const router = useRouter();
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
  // Credentials get their own tab for every non-builtin server (built-ins need
  // none), mirroring the old settings dialog's Connections nav item.
  const showConnectionsTab = variant !== "builtin";

  // Every tab beyond the always-present Overview dashboard.
  const tabIds: DetailTab[] = [
    ...(showConnectionsTab ? (["credentials"] as DetailTab[]) : []),
    ...diagnosticTabs.map((panel) => panel.id),
  ];
  const showTabs = tabIds.length > 0;

  // Deep links: ?tab=credentials|logs|inspector|shell|yaml opens that tab,
  // ?server=<installId> pre-selects the install in the logs view.
  const tabParam = searchParams.get("tab");
  const serverParam = searchParams.get("server");
  const [activeTab, setActiveTab] = useState<DetailTab>(
    tabParam && tabIds.includes(tabParam as DetailTab)
      ? (tabParam as DetailTab)
      : "overview",
  );
  const [logsServerId, setLogsServerId] = useState<string | null>(serverParam);

  const effectiveTab: DetailTab = tabIds.includes(activeTab)
    ? activeTab
    : "overview";
  const isLogsTab =
    effectiveTab === "logs" ||
    effectiveTab === "inspector" ||
    effectiveTab === "shell";

  // Jump to the logs tab pre-targeting a specific pod (from the credentials list).
  const openPodLogs = (serverId: string) => {
    setLogsServerId(serverId);
    setActiveTab("logs");
  };

  // Install inline on this page (no navigation). The dialog lets the user pick
  // scope/credential; the add-* helpers pre-target a personal/team/org scope.
  const install = useCatalogInstall();
  const openInstall = () =>
    item.serverType === "local"
      ? install.installLocal(item)
      : install.installRemote(item);

  const [deleteRequested, setDeleteRequested] = useState(false);
  // Recreate the K8s pods with a freshly pulled image (local servers only).
  const refreshImageMutation = useRefreshInternalMcpCatalogImage();
  const canRestartPods =
    canModify && variant === "local" && deploymentServerIds.length > 0;

  const connectionsCount = allServersForCatalog.length;
  const statusText =
    variant === "local"
      ? deploymentSummary
        ? `${deploymentSummary.running}/${deploymentSummary.total} ${getDeploymentLabel(deploymentSummary.overallState).toLowerCase()}`
        : "Not installed"
      : connectionsCount > 0
        ? "Connected"
        : "Not installed";

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
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <McpCatalogIcon icon={item.icon} catalogId={item.id} size={36} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {item.name}
              </h1>
              <Badge variant="secondary" className="capitalize">
                {item.serverType}
              </Badge>
            </div>
            {item.description && (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!hasPersonalConnection && variant !== "builtin" && (
            <Button variant="outline" onClick={openInstall}>
              <PlugZap className="h-4 w-4" />
              Install
            </Button>
          )}
          {canModify && (
            <Button asChild>
              <Link href={`/mcp/registry/beta/${item.id}/edit`}>
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
                    Restart pods
                  </DropdownMenuItem>
                )}
                {userCanCreateCatalogItem && !isPlaywright && (
                  <DropdownMenuItem
                    onClick={() =>
                      router.push(
                        `/mcp/registry/beta/new?${MCP_CATALOG_CLONE_QUERY_PARAM}=${item.id}`,
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
      </div>

      {/* Tabs — Overview dashboard + diagnostics, shown once installed */}
      {showTabs && (
        <Tabs
          value={effectiveTab}
          onValueChange={(value) => setActiveTab(value as DetailTab)}
        >
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {showConnectionsTab && (
              <TabsTrigger
                value="credentials"
                data-testid={E2eTestId.McpServerSettingsConnectionsNavButton}
              >
                Credentials
                {connectionsCount > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                    {connectionsCount}
                  </span>
                )}
              </TabsTrigger>
            )}
            {diagnosticTabs.map((panel) => (
              <TabsTrigger key={panel.id} value={panel.id}>
                {panel.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
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
                      <Link
                        href={`/mcp/registry/beta/${item.id}/edit?step=tools`}
                      >
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
                        Tools appear once the server is connected and reachable.
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
                            {parseFullToolName(tool.name).toolName || tool.name}
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
                        href={`/mcp/registry/beta/${item.id}/edit?step=tools`}
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
                    {statusText}
                  </span>
                </OverviewField>
                {variant !== "builtin" && (
                  <OverviewField label="Environment">
                    {environmentLabel ?? defaultEnvironment.name}
                  </OverviewField>
                )}
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
            <h2 className="text-base font-semibold">Credentials</h2>
            <CardDescription>
              Who is connected to this server and with which credentials.
            </CardDescription>
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
              onOpenPodLogs={variant === "local" ? openPodLogs : undefined}
            />
          </CardContent>
        </Card>
      )}

      {/* Diagnostics — Logs / Inspector / Shell share one mounted panel so the
          pod selector and live stream survive switching between them. */}
      {isLogsTab && (
        <Card className="py-0">
          <div className="flex min-h-[480px] flex-col p-6">
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
          <div className="flex min-h-[480px] flex-col p-6">
            <YamlConfigContent item={item} onClose={() => {}} hideHeader />
          </div>
        </Card>
      )}

      {/* Inline install flow (remote/local/no-auth/OAuth) — no navigation. */}
      {install.dialogs}

      <DeleteCatalogDialog
        item={deleteRequested ? item : null}
        onClose={() => setDeleteRequested(false)}
        onDeleted={() => router.push("/mcp/registry/beta")}
      />
    </div>
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
