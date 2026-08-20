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
import { CopyButton } from "@/components/copy-button";
import { CopyableCode } from "@/components/copyable-code";
import { EntityPill } from "@/components/entity-pill";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PageLayout } from "@/components/page-layout";
import type { SettingTone } from "@/components/setting-icon";
import { SettingGroup, SettingRow } from "@/components/setting-row";
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
import {
  ACTION_LABEL,
  FIELD_LABEL,
  formatCreated,
} from "@/lib/design/resource-lexicon";
import { typeRole } from "@/lib/design/type-scale";
import { useEnvironments } from "@/lib/environment.query";
import {
  useCatalogTools,
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
import type {
  McpServerIssue,
  McpServerIssueKind,
} from "@/lib/mcp/mcp-server-issues";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import { cn, formatDate } from "@/lib/utils";
import { useCanModifyCatalogItem } from "../_parts/catalog-edit-access";
import { resolveCatalogEnvironmentLabel } from "../_parts/catalog-environment-label";
import type { SetupStepId } from "../_parts/catalog-setup-wizard";
import { shouldShowMcpCardChatButton } from "../_parts/chat-button-visibility";
import { DeleteCatalogDialog } from "../_parts/delete-catalog-dialog";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  type DeploymentStatusSummary,
  getDeploymentStatusChipLabel,
} from "../_parts/deployment-status";
import { buildDetailTabHref } from "../_parts/detail-tab-href";
import { ManageUsersContent } from "../_parts/manage-users-dialog";
import { McpCapabilityBadges } from "../_parts/mcp-capability-badges";
import { transformCatalogItemToFormValues } from "../_parts/mcp-catalog-form.utils";
import { McpLogsContent, type McpLogsTab } from "../_parts/mcp-logs-dialog";
import { deriveAgentUsage } from "../_parts/mcp-server-agent-usage";
import type { CatalogItem, InstalledServer } from "../_parts/mcp-server-card";
import { McpServerIssueBadge } from "../_parts/mcp-server-issue-badge";
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
  const { statuses: deploymentStatuses, state: deploymentFeedState } =
    useMcpDeploymentStatuses();
  const { issuesByCatalog } = useMcpServerIssues(deploymentStatuses);
  const itemIssues = issuesByCatalog.get(item.id);
  // The worst live issue first, exactly as the registry table's Status column
  // reads it (mcp-server-table.tsx). Issues are kind-ordered and `muted` cuts
  // across that order, so taking issues[0] made a server carrying a silenced
  // "Failed to start" plus a live "Needs re-authentication" report the
  // silenced fault here and the live one in the list.
  const statusIssue = itemIssues?.find((i) => !i.muted) ?? itemIssues?.[0];
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

  // Where each outstanding issue is explained: beside the configuration that
  // caused it, so the diagnosis and the remedy are one card apart.
  const issuesByCard = groupIssuesByCard(itemIssues ?? [], {
    // The built-in server is not reached over a connection anybody configures,
    // so `ConfigurationSections` renders no Connection card for it.
    hasConnectionCard: item.serverType !== "builtin",
  });

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
            {/* One card per subject rather than one panel of bands: whether
                the server is working, how it is reached, how callers
                authenticate, what it is given, what it exposes, and last the
                record itself. */}
            <DetailCard
              title="Status"
              description="Whether this server is answering right now."
              // Health is not something the wizard wrote, so this card has no
              // Edit; what it reports on is the wizard's Test Connection step,
              // which is where a reader who wants to change the answer goes.
              action={
                canModify && variant !== "builtin" ? (
                  <CardLink
                    href={catalogEditHref(item.id, "test")}
                    icon={<PlugZap className="h-4 w-4" />}
                    label="Test connection"
                    cardTitle="Status"
                  />
                ) : null
              }
            >
              <ServerStatus
                variant={variant}
                issue={statusIssue}
                deploymentSummary={deploymentSummary}
                deploymentFeedState={deploymentFeedState}
                connectionsCount={connectionsCount}
              />
              {/* An issue that belongs to the catalog entry rather than to any
                  one installation has no configuration card to sit under. */}
              <CardIssues
                item={item}
                issues={issuesByCard.summary}
                servers={allServersForCatalog}
              />
            </DetailCard>

            <ConfigurationSections
              item={item}
              canModify={canModify}
              environmentLabel={environmentLabel ?? defaultEnvironment.name}
              servers={allServersForCatalog}
              issues={issuesByCard}
            />

            <DetailCard
              title="Tools"
              description="What this server exposes to agents, and the guardrails on it."
              // "Guardrails" named half of what the control reaches: the
              // wizard's Tools & Guardrails step edits the tool list too, and
              // a card titled "Tools" whose only action says "Guardrails"
              // leaves no way in for someone looking to change the tools.
              action={
                canModify ? (
                  <CardEditLink
                    href={catalogEditHref(item.id, "tools")}
                    cardTitle="Tools"
                  />
                ) : null
              }
            >
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
                        <code
                          className={cn(
                            typeRole({ role: "code" }),
                            "font-medium",
                          )}
                        >
                          {parseFullToolName(tool.name).toolName || tool.name}
                        </code>
                        {tool.description && (
                          <p
                            className={cn(
                              typeRole({ role: "meta" }),
                              "mt-0.5 line-clamp-2",
                            )}
                          >
                            {tool.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                  {tools.length > TOOLS_PREVIEW_LIMIT &&
                    // The only listing of every tool is the wizard's step, so
                    // a reader who may not edit the catalog is told how many
                    // are hidden rather than sent to a route they cannot open.
                    (canModify ? (
                      <Link
                        href={catalogEditHref(item.id, "tools")}
                        className="inline-block text-sm font-medium text-primary hover:underline"
                      >
                        View all {tools.length} tools
                      </Link>
                    ) : (
                      <p className={typeRole({ role: "meta" })}>
                        Showing {TOOLS_PREVIEW_LIMIT} of {tools.length} tools.
                      </p>
                    ))}
                </>
              )}
            </DetailCard>

            {/* The record itself, last: nothing here was written on a wizard
                step, so the card offers no way into one, and the last change
                is a date alone — the catalog row records when it changed,
                never by whom. */}
            <DetailCard title="Details" action={null}>
              <FieldGrid>
                <OverviewField label="ID">
                  <span className="flex min-w-0 items-center gap-1">
                    <code
                      className={cn(
                        typeRole({ role: "code" }),
                        "min-w-0 truncate",
                      )}
                    >
                      {item.id}
                    </code>
                    <CopyButton text={item.id} className="shrink-0" />
                  </span>
                </OverviewField>
                <OverviewField label={FIELD_LABEL.created}>
                  {formatCreated({ createdAt: item.createdAt })}
                </OverviewField>
                <OverviewField label={FIELD_LABEL.lastUpdated}>
                  {formatDate({ date: item.updatedAt, dateFormat: "PP" })}
                </OverviewField>
                {/* Unlike the agent and skill pages, this page's title
                    carries the server's type rather than its scope, so an
                    org-wide server would otherwise read like a personal one.
                    A personal server says nothing: this page is only
                    reachable by the person it belongs to. */}
                {item.scope === "org" && (
                  <OverviewField label={FIELD_LABEL.accessibleTo}>
                    Everyone in the organization
                  </OverviewField>
                )}
                {item.scope === "team" && item.teams.length > 0 ? (
                  // The wizard grants each team either level, which no scope
                  // badge can say.
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
                ) : item.authorName ? (
                  <OverviewField label="Owner">{item.authorName}</OverviewField>
                ) : null}
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
              </FieldGrid>
            </DetailCard>
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
 *
 * One card each. All three open the same wizard step, because that is where
 * all three were written — the mapping cards owe the wizard is that every
 * card leads to exactly one step, not that every step has exactly one card.
 */
function ConfigurationSections({
  item,
  canModify,
  environmentLabel,
  servers,
  issues,
}: {
  item: CatalogItem;
  canModify: boolean;
  environmentLabel: string;
  servers: InstalledServer[];
  issues: IssuesByCard;
}) {
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
  const editHref = canModify ? catalogEditHref(item.id, "configuration") : null;

  return (
    <>
      {/* The built-in server is not reached over a connection anybody
          configures, so it has no Connection card rather than an empty one. */}
      {item.serverType !== "builtin" && (
        <DetailCard
          title="Connection"
          description={
            isLocal
              ? "How this server is built and run."
              : "Where this server is reached."
          }
          action={
            editHref ? (
              <CardEditLink href={editHref} cardTitle="Connection" />
            ) : null
          }
        >
          <FieldGrid>
            <OverviewField label={FIELD_LABEL.environment}>
              {environmentLabel}
            </OverviewField>
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
          </FieldGrid>
          <IdleHibernationRow item={item} />
          <CardIssues
            item={item}
            issues={issues.connection}
            servers={servers}
          />
        </DetailCard>
      )}

      <DetailCard
        title="Authentication"
        description="How callers prove who they are to this server."
        action={
          editHref ? (
            <CardEditLink href={editHref} cardTitle="Authentication" />
          ) : null
        }
      >
        <SettingGroup>
          <SettingRow
            icon={<KeyRound className="size-4" />}
            title="Method"
            tone={values.authMethod === "none" ? "off" : "on"}
            state={auth.label}
          >
            {auth.describe}
          </SettingRow>
        </SettingGroup>
        {(values.authMethod === "oauth" ||
          values.authMethod === "oauth_client_credentials") &&
          oauth && (
            <FieldGrid>
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
            </FieldGrid>
          )}
        {managed && (
          <FieldGrid>
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
          </FieldGrid>
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
        <CardIssues
          item={item}
          issues={issues.authentication}
          servers={servers}
        />
      </DetailCard>

      {isLocal && (envVars.length > 0 || envFrom.length > 0) && (
        <DetailCard
          title="Environment variables"
          description="What the server's container is given at run time."
          action={
            editHref ? (
              <CardEditLink href={editHref} cardTitle="Environment variables" />
            ) : null
          }
        >
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
        </DetailCard>
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
    <SettingGroup>
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
    </SettingGroup>
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

/**
 * One card of the overview: its title, a line on what is inside, and one
 * action — the wizard step that wrote it, or nothing on the cards the wizard
 * never wrote. Every title is the same rank; the cards are siblings, and the
 * page title above is the only thing that outranks them.
 */
function DetailCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  /** Explicit, including the `null` that says this card has no action. */
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className={typeRole({ role: "section-title" })}>{title}</h2>
          {description && (
            <p className={typeRole({ role: "meta" })}>{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A card's own way into the wizard, in the header's top-right corner. The
 * `data-testid` marks it as the header's action rather than merely the first
 * link inside the card: card bodies carry links of their own.
 */
function CardLink({
  href,
  icon,
  label,
  cardTitle,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  /**
   * The card this action belongs to, appended to the accessible name. This
   * page renders several actions labelled only "Edit", and a links list or a
   * voice command of five identical "Edit" entries names nothing.
   */
  cardTitle: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      asChild
      className="-mr-2 shrink-0 text-muted-foreground"
      data-testid={CARD_ACTION_TEST_ID}
    >
      {/* `aria-label` rather than an extra sr-only span: the accessible name
          of two adjacent inline spans concatenates with no separator, so they
          read as one run-together word. The visible label stays inside the
          aria-label, so a voice command on it still matches. */}
      <Link href={href} aria-label={`${label} ${cardTitle}`}>
        {icon}
        <span>{label}</span>
      </Link>
    </Button>
  );
}

const CARD_ACTION_TEST_ID = "card-action";

function CardEditLink({
  href,
  cardTitle,
}: {
  href: string;
  cardTitle: string;
}) {
  return (
    <CardLink
      href={href}
      cardTitle={cardTitle}
      icon={<Pencil className="h-4 w-4" />}
      label={ACTION_LABEL.edit}
    />
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

/**
 * The status the registry list shows for this server, derived the same way:
 * an outstanding issue IS the status, and only a server with none reads as
 * installed. Deriving it from row existence alone put a green "Connected"
 * directly above a notice saying the token had been rejected, and left the
 * built-in server — which nobody installs — reading "Not installed".
 */
function ServerStatus({
  variant,
  issue,
  deploymentSummary,
  deploymentFeedState,
  connectionsCount,
}: {
  variant: "builtin" | "local" | "remote";
  /** The worst outstanding issue, as the list's Status column reads it. */
  issue: McpServerIssue | undefined;
  deploymentSummary: DeploymentStatusSummary | null;
  /** Whether pod statuses can arrive at all, and whether any have yet. */
  deploymentFeedState: McpDeploymentFeedState;
  connectionsCount: number;
}) {
  if (variant === "builtin") {
    return <Badge variant="secondary">Built-in</Badge>;
  }
  if (issue) {
    return <McpServerIssueBadge issue={issue} />;
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

/**
 * The issues one card owns, explained where their cause is configured — the
 * same notice the registry's Needs-attention tab renders, so the diagnosis
 * reads identically. Tinted off the card so it reads as an inset rather than
 * as a second card inside this one.
 */
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
      className="bg-muted/40"
    />
  );
}

interface IssuesByCard {
  /** Catalog-scope trouble, which belongs to no one installation. */
  summary: McpServerIssue[];
  connection: McpServerIssue[];
  authentication: McpServerIssue[];
}

/**
 * Which card owns each kind of trouble. A rejected token is an authentication
 * fault and belongs beside the authentication configuration; a pod that will
 * not start belongs beside how the server is built and run. An issue with no
 * `serverId` is about the catalog entry rather than any installation, and
 * stays with the status it explains.
 *
 * `hasConnectionCard` is the escape hatch, not a style choice: the built-in
 * server has no Connection card, and `computeMcpServerIssues` does not
 * exclude its catalog entry, so anything routed to that card would be dropped
 * from the page without it. Every bucket must have a card that renders it.
 */
function groupIssuesByCard(
  issues: McpServerIssue[],
  { hasConnectionCard }: { hasConnectionCard: boolean },
): IssuesByCard {
  const grouped: IssuesByCard = {
    summary: [],
    connection: [],
    authentication: [],
  };
  for (const issue of issues) {
    const card = issue.serverId ? ISSUE_CARD[issue.kind] : "summary";
    grouped[
      card === "connection" && !hasConnectionCard ? "summary" : card
    ].push(issue);
  }
  return grouped;
}

const ISSUE_CARD: Record<McpServerIssueKind, "connection" | "authentication"> =
  {
    "needs-reauth": "authentication",
    "failed-to-start": "connection",
    "not-running": "connection",
    "stuck-starting": "connection",
    starting: "connection",
    "reinstall-required": "connection",
    "awaiting-approval": "connection",
  };

/** The wizard, opened on the step that wrote what the reader is looking at. */
function catalogEditHref(catalogId: string, step: SetupStepId) {
  return `/mcp/registry/${encodeURIComponent(catalogId)}/edit?step=${step}`;
}

function SubHeading({ label }: { label: string }) {
  return <p className={typeRole({ role: "label" })}>{label}</p>;
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
