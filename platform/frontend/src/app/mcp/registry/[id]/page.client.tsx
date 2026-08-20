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
  KeyRound,
  MessageSquare,
  Moon,
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
import { type ReactNode, useMemo, useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
import { EntityPill } from "@/components/entity-pill";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import type { SettingTone } from "@/components/setting-icon";
import { SettingRow } from "@/components/setting-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import {
  useCatalogTools,
  useInternalMcpCatalog,
  useRefreshInternalMcpCatalogImage,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useAutoModeAgents,
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import { cn, formatDate } from "@/lib/utils";
import { useCanModifyCatalogItem } from "../_parts/catalog-edit-access";
import { resolveCatalogEnvironmentLabel } from "../_parts/catalog-environment-label";
import { shouldShowMcpCardChatButton } from "../_parts/chat-button-visibility";
import { DeleteCatalogDialog } from "../_parts/delete-catalog-dialog";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  getDeploymentStatusChipLabel,
} from "../_parts/deployment-status";
import { buildDetailTabHref } from "../_parts/detail-tab-href";
import { ManageUsersContent } from "../_parts/manage-users-dialog";
import { transformCatalogItemToFormValues } from "../_parts/mcp-catalog-form.utils";
import { McpLogsContent, type McpLogsTab } from "../_parts/mcp-logs-dialog";
import { deriveAgentUsage } from "../_parts/mcp-server-agent-usage";
import type { CatalogItem } from "../_parts/mcp-server-card";
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

// How many tools to preview on the Overview before linking out to guardrails.
const TOOLS_PREVIEW_LIMIT = 6;

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
  const { issuesByCatalog } = useMcpServerIssues(deploymentStatuses);
  const itemIssues = issuesByCatalog.get(item.id);
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
  const { data: autoModeAgents } = useAutoModeAgents();
  const agentUsageCount = deriveAgentUsage({
    serversForCatalog: allServersForCatalog,
    autoModeAgents,
  }).total;

  const tabs: { label: React.ReactNode; href: string; testId?: string }[] = [
    { label: "Overview", href: tabHref("overview") },
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
        : "Not installed"
      : connectionsCount > 0
        ? "Connected"
        : "Not installed";

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
              Install
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
          <McpServerUsageTab
            serversForCatalog={allServersForCatalog}
            autoModeAgents={autoModeAgents}
          />
        )}

        {effectiveTab === "overview" && (
          <div className="space-y-4">
            {/* Outstanding issue, explained — same notice as the registry's
                Needs-attention tab, so the diagnosis reads identically. */}
            {itemIssues && itemIssues.length > 0 && (
              <McpServerIssueNotice
                item={item}
                issues={itemIssues}
                servers={allServersForCatalog}
                hideName
              />
            )}
            {/* One panel, as the wizard is: the server's facts open it as a
                heading section, the capabilities follow. */}
            <div className="divide-y rounded-lg border bg-card">
              <section className="grid gap-x-6 gap-y-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
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
                {item.scope === "team" && item.teams.length > 0 && (
                  // The wizard grants each team either level; the badge above
                  // names the teams but not what they may do.
                  <OverviewField label="Teams">
                    <ul className="flex flex-wrap gap-1.5">
                      {item.teams.map((team) => (
                        <li key={team.id}>
                          <EntityPill
                            name={team.name}
                            note={team.level === "write" ? "Manage" : "Use"}
                          />
                        </li>
                      ))}
                    </ul>
                  </OverviewField>
                )}
                <OverviewField label="Created">
                  <span>
                    {item.authorName ? (
                      <span>by {item.authorName} </span>
                    ) : null}
                    <span>
                      on{" "}
                      {formatDate({ date: item.createdAt, dateFormat: "PP" })}
                    </span>
                  </span>
                </OverviewField>
                {item.updatedAt !== item.createdAt && (
                  <OverviewField label="Last updated">
                    {formatDate({ date: item.updatedAt, dateFormat: "PPp" })}
                  </OverviewField>
                )}
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
              </section>

              <ConfigurationSections item={item} />

              {/* Tools the server exposes — the wizard's own step, so it
                  ranks a level above sections inside a step (h2 to their h3). */}
              <section className="space-y-4 p-4 pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold tracking-tight">
                      Tools
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Capabilities this server exposes to agents.
                    </p>
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
                        href={`/mcp/registry/${item.id}/edit?step=tools`}
                        className="inline-block text-sm font-medium text-primary hover:underline"
                      >
                        View all {tools.length} tools
                      </Link>
                    )}
                  </>
                )}
              </section>
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
          onDeleted={onDeleted}
        />
      </div>
    </PageLayout>
  );
}

/**
 * The configuration the setup wizard's first step holds, read-only and in the
 * order the wizard asks for it: how the server is reached and run, how it
 * authenticates, and what it is given at run time. Derived through the
 * wizard's own `transformCatalogItemToFormValues`, so the page cannot drift
 * from the form that wrote the values.
 */
function ConfigurationSections({ item }: { item: CatalogItem }) {
  const values = useMemo(() => transformCatalogItemToFormValues(item), [item]);
  const { data: identityProviders = [] } = useIdentityProviders();
  const isLocal = item.serverType === "local";
  // Only the derivations come from the form shape (auth method, headers):
  // its `localConfig` is textarea-shaped — `arguments` is one newline-joined
  // string there — so everything factual reads the API's own object.
  const local = item.localConfig;
  const auth = AUTH_METHOD_COPY[values.authMethod] ?? AUTH_METHOD_COPY.none;
  const oauth = values.oauthConfig;
  const managed = values.enterpriseManagedConfig;
  const identityProviderName = managed?.identityProviderId
    ? (identityProviders.find(
        (provider) => provider.id === managed.identityProviderId,
      )?.issuer ?? "Not visible to you")
    : null;
  const commandLine = [local?.command, ...(local?.arguments ?? [])]
    .filter(Boolean)
    .join(" ");
  const envVars = local?.environment ?? [];
  const promptedVars = envVars.filter(
    (variable) => variable.promptOnInstallation,
  );
  const fixedVars = envVars.filter(
    (variable) => !variable.promptOnInstallation,
  );
  const envFrom = local?.envFrom ?? [];
  const headers = values.additionalHeaders ?? [];

  return (
    <>
      <section className="space-y-4 p-4">
        <SectionHeading
          title="Connection"
          description={
            isLocal
              ? "How this server is built and run."
              : "Where this server is reached."
          }
        />
        <div className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {item.serverType === "remote" && item.serverUrl && (
            <OverviewField
              label="Server URL"
              className="sm:col-span-2 lg:col-span-3"
            >
              <CodeLine>{item.serverUrl}</CodeLine>
            </OverviewField>
          )}
          {isLocal && (
            <>
              <OverviewField label="Deployment">
                {values.multitenant
                  ? "Multi-tenant — one shared deployment"
                  : "Single-tenant — one deployment per installation"}
              </OverviewField>
              <OverviewField label="Transport">
                {local?.transportType === "stdio" ? (
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
                )}
              </OverviewField>
              <OverviewField label="Deployment spec">
                {item.deploymentSpecYaml ? "Customized" : "Generated"}
              </OverviewField>
              {local?.dockerImage && (
                <OverviewField
                  label="Image"
                  className="sm:col-span-2 lg:col-span-3"
                >
                  <CodeLine>{local.dockerImage}</CodeLine>
                </OverviewField>
              )}
              {commandLine && (
                <OverviewField
                  label="Command"
                  className="sm:col-span-2 lg:col-span-3"
                >
                  {/* The command as it runs, on one line — long ones scroll
                      rather than wrap, and the button copies the whole thing. */}
                  <CopyableCode
                    value={commandLine}
                    toastMessage="Command copied"
                    className="w-full"
                  >
                    <code className="block overflow-x-auto whitespace-nowrap font-mono text-xs">
                      {commandLine}
                    </code>
                  </CopyableCode>
                </OverviewField>
              )}
              {local?.serviceAccount && (
                <OverviewField label="Service account">
                  <CodeLine>{local.serviceAccount}</CodeLine>
                </OverviewField>
              )}
              {(local?.imagePullSecrets ?? []).length > 0 && (
                <OverviewField label="Image pull secrets">
                  {(local?.imagePullSecrets ?? []).length}
                </OverviewField>
              )}
            </>
          )}
        </div>
        <IdleHibernationRow item={item} />
      </section>

      <section className="space-y-4 p-4">
        <SectionHeading
          title="Authentication"
          description="How callers prove who they are to this server."
        />
        <div className="divide-y rounded-md border">
          <SettingRow
            icon={<KeyRound className="size-4" />}
            title="Method"
            tone={values.authMethod === "none" ? "off" : "on"}
            state={auth.label}
          >
            {auth.describe}
          </SettingRow>
        </div>
        {(values.authMethod === "oauth" ||
          values.authMethod === "oauth_client_credentials") &&
          oauth && (
            <div className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {oauth.tokenEndpoint && (
                <OverviewField
                  label="Token endpoint"
                  className="sm:col-span-2 lg:col-span-3"
                >
                  <CodeLine>{oauth.tokenEndpoint}</CodeLine>
                </OverviewField>
              )}
              {oauth.client_id && (
                <OverviewField label="Client ID">
                  <CodeLine>{oauth.client_id}</CodeLine>
                </OverviewField>
              )}
              <OverviewField label="Client secret">
                {item.clientSecretId || oauth.client_secret
                  ? "Configured"
                  : "Not set"}
              </OverviewField>
              {oauth.scopes && (
                <OverviewField label="Scopes">
                  <CodeLine>{String(oauth.scopes)}</CodeLine>
                </OverviewField>
              )}
            </div>
          )}
        {managed && (
          <div className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <OverviewField label="Identity provider">
              {identityProviderName ?? "Not set"}
            </OverviewField>
            {managed.requestedCredentialType && (
              <OverviewField label="Requested credential">
                {managed.requestedCredentialType}
              </OverviewField>
            )}
            {managed.tokenInjectionMode && (
              <OverviewField label="Injection">
                {managed.tokenInjectionMode}
              </OverviewField>
            )}
          </div>
        )}
        {headers.length > 0 && (
          <div className="space-y-1.5">
            <SubHeading label="Headers" />
            <ul className="flex flex-wrap gap-1.5">
              {headers.map((header) => (
                <li key={header.headerName}>
                  <EntityPill
                    name={header.headerName}
                    note={[
                      header.promptOnInstallation
                        ? "asked at install"
                        : "fixed",
                      header.required ? "required" : null,
                      header.sensitive ? "sensitive" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {isLocal && (envVars.length > 0 || envFrom.length > 0) && (
        <section className="space-y-4 p-4">
          <SectionHeading
            title="Environment"
            description="What the server's container is given at run time."
          />
          {promptedVars.length > 0 && (
            <div className="space-y-1.5">
              <SubHeading label="Asked at installation" />
              <EnvVarPills variables={promptedVars} />
            </div>
          )}
          {fixedVars.length > 0 && (
            <div className="space-y-1.5">
              <SubHeading label="Set on the server" />
              <EnvVarPills variables={fixedVars} />
            </div>
          )}
          {envFrom.length > 0 && (
            <div className="space-y-1.5">
              <SubHeading label="From Kubernetes" />
              <ul className="flex flex-wrap gap-1.5">
                {envFrom.map((source) => (
                  <li key={`${source.type}:${source.name}`}>
                    <EntityPill
                      name={source.name}
                      note={
                        source.type === "configMap" ? "ConfigMap" : "Secret"
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * The per-server idle-hibernation override, read-only — mirroring the edit
 * page's own section, including when it does not exist: only a self-hosted
 * server in an organization that hibernates idle servers has one. The value
 * lives on the install rows, and a reinstall can move one of them alone, so
 * divergence reads as "Mixed" rather than whichever row happens to be first.
 */
function IdleHibernationRow({ item }: { item: CatalogItem }) {
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
    return null;
  }

  const modes = [
    ...new Set(
      servers
        .filter((server) => server.catalogId === item.id)
        .map((server) => server.hibernationMode ?? "inherit"),
    ),
  ];
  const mode = modes.length === 1 ? modes[0] : undefined;
  const copy = mode ? HIBERNATION_COPY[mode] : undefined;

  return (
    <div className="divide-y rounded-md border">
      <SettingRow
        icon={<Moon className="size-4" />}
        title="Idle hibernation"
        tone={copy?.tone ?? "info"}
        state={copy?.label ?? (modes.length === 0 ? "Not installed" : "Mixed")}
      >
        {copy?.describe ??
          (modes.length === 0
            ? "No installation to hibernate yet."
            : "Installations of this server disagree; the edit page can set them all.")}
      </SettingRow>
    </div>
  );
}

/** What each hibernation choice means for a server that goes idle. */
const HIBERNATION_COPY: Record<
  string,
  { label: string; tone: SettingTone; describe: string }
> = {
  inherit: {
    label: "Organization setting",
    tone: "info",
    describe:
      "Hibernates when idle if the organization hibernates idle servers.",
  },
  enabled: {
    label: "Always allowed",
    tone: "on",
    describe: "Scales to zero when idle and starts again on the next call.",
  },
  disabled: {
    label: "Never",
    tone: "off",
    describe:
      "Stays running even while the organization hibernates idle servers.",
  },
};

/** One environment variable per chip: secrets keyed, files marked, required noted. */
function EnvVarPills({
  variables,
}: {
  variables: NonNullable<
    NonNullable<CatalogItem["localConfig"]>["environment"]
  >;
}) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {variables.map((variable) => (
        <li key={variable.key}>
          <EntityPill
            icon={
              variable.type === "secret" ? (
                <KeyRound className="size-3.5 text-muted-foreground" />
              ) : undefined
            }
            name={variable.key}
            note={[
              variable.mounted ? "file" : null,
              variable.required ? "required" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        </li>
      ))}
    </ul>
  );
}

/** A section inside the wizard's Configuration step — h3, under the h2 steps. */
function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function SubHeading({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">{label}</p>;
}

function CodeLine({ children }: { children: ReactNode }) {
  return (
    <code className="block overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 font-mono text-xs">
      {children}
    </code>
  );
}

/** What each authentication method means, in the wizard's own words. */
const AUTH_METHOD_COPY: Record<string, { label: string; describe: string }> = {
  none: {
    label: "None",
    describe: "Callers reach this server without credentials.",
  },
  bearer: {
    label: "Token header",
    describe: "Each person supplies a token when they connect.",
  },
  oauth: {
    label: "OAuth 2.1",
    describe: "Each person signs in to the server, which issues the token.",
  },
  oauth_client_credentials: {
    label: "OAuth client credentials",
    describe: "One machine identity authenticates every call.",
  },
  enterprise_managed: {
    label: "Identity provider exchange",
    describe:
      "The gateway exchanges the caller's identity for a credential the server accepts.",
  },
  idp_jwt: {
    label: "Identity provider JWT",
    describe: "The caller's signed identity token is passed through as it is.",
  },
};

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
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
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
