"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  getManageCredentialsButtonTestId,
  MCP_CATALOG_EDIT_QUERY_PARAM,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import {
  ArrowUpRight,
  Bot,
  Copy,
  FileSearch,
  Globe,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  User,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type MouseEventHandler, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { TableCard } from "@/components/table-card-view";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { useReinstallInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import type { McpDeploymentFeedState } from "@/lib/mcp/mcp-server.query";
import { useAutoModeAgents, useMcpServers } from "@/lib/mcp/mcp-server.query";
import {
  canFixInstall,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { useCanReauthenticate } from "@/lib/mcp/use-can-reauthenticate";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { isCardShowingInstallInProgress } from "./card-install-state";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
import { clearCatalogEditParam } from "./catalog-edit-link";
import { resolveCatalogEnvironmentLabel } from "./catalog-environment-label";
import { shouldShowMcpCardChatButton } from "./chat-button-visibility";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusIconDot,
  STATE_PRIORITY,
} from "./deployment-status";
import { CatalogEditNoAccess } from "./edit-catalog-dialog";
import { InstallationProgress } from "./installation-progress";
import { McpCapabilityBadges } from "./mcp-capability-badges";
import {
  type AgentUsage,
  agentOwnerLabel,
  deriveAgentUsage,
} from "./mcp-server-agent-usage";
import { McpServerIssueBadge } from "./mcp-server-issue-badge";
import { McpServerIssueNotice } from "./mcp-server-issue-notice";
import { OAuthReauthIndicator } from "./oauth-reauth-indicator";
import {
  UninstallServerDialog,
  type UninstallServerInstall,
} from "./uninstall-server-dialog";
import { useChatWithCatalogItem } from "./use-chat-with-catalog-item";

export type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export type InstalledServer =
  archestraApiTypes.GetMcpServersResponses["200"][number];

export type McpServerCardProps = {
  item: CatalogItem;
  installedServer?: InstalledServer | null;
  installingItemId: string | null;
  installationStatus?:
    | "error"
    | "pending"
    | "success"
    | "idle"
    | "discovering-tools"
    | null;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  /**
   * Whether the live deployment feed has anything to say yet. Without it an
   * empty `deploymentStatuses` reads as "still loading" forever on every
   * deployment that has no Kubernetes runtime at all.
   */
  deploymentFeedState: McpDeploymentFeedState;
  /** This item's outstanding issues, from the registry's shared computation. */
  issues?: McpServerIssue[];
  onInstallRemoteServer: () => void;
  onInstallLocalServer: () => void;
  /**
   * Trigger a reinstall. `flaggedInstalls` is the set of installs the caller
   * wants reinstalled — derived from `reinstallRequired`. Empty/undefined means
   * "decide in the handler".
   */
  onReinstall: (
    flaggedInstalls?: Array<{
      id: string;
      name: string;
    }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => void | Promise<void>;
  onCancelInstallation?: (serverId: string) => void;
  /** When true, renders as a built-in Playwright server (non-editable, personal-only) */
  isBuiltInPlaywright?: boolean;
  selection?: {
    selected: boolean;
    onSelectedChange: (selected: boolean) => void;
    onSelectionClick: MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    disabledTooltip?: string;
  };
};

export type McpServerCardVariant = "remote" | "local" | "builtin";

export type McpServerCardBaseProps = McpServerCardProps & {
  variant: McpServerCardVariant;
};

export function McpServerCard({
  variant,
  item,
  installedServer,
  installingItemId,
  installationStatus,
  deploymentStatuses,
  deploymentFeedState: _deploymentFeedState,
  issues,
  onInstallRemoteServer,
  onInstallLocalServer,
  onReinstall,
  onCancelInstallation,
  isBuiltInPlaywright = false,
  selection,
}: McpServerCardBaseProps) {
  const isPlaywrightVariant = isBuiltInPlaywright;

  const { startChat, isCreating: isChatCreating } = useChatWithCatalogItem();

  const isByosEnabled = useFeature("byosEnabled");
  const alertingEnabled = useFeature("mcpServerAlertingEnabled") === true;
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");

  // A named, explicit environment is useful placement information. The
  // implicit Default is the baseline and stays unlabeled. Built-in servers
  // aren't environment-scoped, so skip them.
  const { data: environmentList } = useEnvironments();
  const environmentLabel =
    variant === "builtin"
      ? null
      : resolveCatalogEnvironmentLabel({
          environmentId: item.environmentId,
          environments: environmentList?.environments ?? [],
        });

  // Whether the current user can edit this catalog item: an admin, a team-admin
  // member of the item's teams, or the author of a personal item. Gates the
  // inline edit form opened via the `?edit=<id>` deep link.
  const { canModify: canEditCatalog, isLoading: canEditCatalogLoading } =
    useCanModifyCatalogItem(variant !== "builtin" ? item : null);

  // Fetch all MCP servers to get installations for logs dropdown
  const { data: allMcpServers } = useMcpServers();
  // Teams the user may install a shared connection for: any team for an install
  // admin, otherwise only the teams they belong to.
  const { data: isMcpServerInstallAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: teams } = useAssignableTeams({
    isResourceAdmin: !!isMcpServerInstallAdmin,
  });

  // Compute if user can create new installation (personal or team)
  // This is used to determine if the Connect button should be shown
  const _canCreateNewInstallation = (() => {
    if (!allMcpServers) return true; // Allow while loading

    const serversForCatalog = allMcpServers.filter(
      (s) => s.catalogId === item.id,
    );

    // Check if user has personal installation
    const hasPersonalInstallation = serversForCatalog.some(
      (s) => s.ownerId === currentUserId && !s.teamId,
    );

    // Check which teams already have this server
    const teamsWithInstallation = serversForCatalog
      .filter((s) => s.teamId)
      .map((s) => s.teamId);

    // Filter available teams
    const availableTeams =
      teams?.filter((t) => !teamsWithInstallation.includes(t.id)) ?? [];

    // Can create new installation if:
    // - Personal installation not yet created AND byos is not enabled
    // - There are teams available without this server
    return (
      (!hasPersonalInstallation && !isByosEnabled) || availableTeams.length > 0
    );
  })();

  // Dialog state
  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);
  // Shown when a shared `?edit=<id>` link targets this item but the current
  // user can't edit it.
  const [editNoAccessOpen, setEditNoAccessOpen] = useState(false);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Navigate to the catalog item detail page, optionally on a specific tab
  // and with a pre-selected install for the logs view.
  const goToItemPage = (tab?: string, serverId?: string) => {
    const params = new URLSearchParams();
    if (tab) params.set("tab", tab);
    if (serverId) params.set("server", serverId);
    const qs = params.toString();
    router.push(`/mcp/registry/${item.id}${qs ? `?${qs}` : ""}`);
  };
  // ── Shareable edit deep-link (`?edit=<catalogId>`) ──────────────────────
  // Legacy links: the editor now lives on the item detail page, so a shared
  // `?edit=<id>` link redirects there for users who can edit, and shows a
  // "no access" dialog for everyone else.
  const editParam = searchParams.get(MCP_CATALOG_EDIT_QUERY_PARAM);
  const deepLinkHandledRef = useRef(false);

  const clearEditParam = () => {
    if (!searchParams.get(MCP_CATALOG_EDIT_QUERY_PARAM)) return;
    const qs = clearCatalogEditParam(searchParams.toString());
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Resolve a shared link once per mount, after the edit-permission check
  // resolves so non-editors aren't redirected to a form they can't use.
  // Builtin items aren't editable, so canEditCatalog is false for them.
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (canEditCatalogLoading) return;
    if (editParam !== item.id) return;
    deepLinkHandledRef.current = true;
    if (canEditCatalog) {
      router.replace(`/mcp/registry/${item.id}/edit`);
    } else {
      setEditNoAccessOpen(true);
    }
  }, [editParam, item.id, canEditCatalog, canEditCatalogLoading, router]);

  const mcpServerOfCurrentCatalogItem = allMcpServers?.filter(
    (s) => s.catalogId === item.id,
  );

  // Find the current user's personal connection for this catalog item
  const personalServer = mcpServerOfCurrentCatalogItem?.find(
    (s) => s.ownerId === currentUserId && !s.teamId,
  );

  const allServersForCatalog = (allMcpServers ?? []).filter(
    (s) => s.catalogId === item.id,
  );
  const personalServersForCatalog = allServersForCatalog.filter(
    (s) => s.ownerId === currentUserId && !s.teamId,
  );
  const hasPersonalConnection =
    personalServersForCatalog.length > 0 || !!personalServer;

  // The distinct agents that can reach this catalog item, across every install
  // of it — the audience affected if those installs go away. Shared with the
  // detail page's Usage tab so both surfaces count the same way.
  const { data: autoModeAgents } = useAutoModeAgents();
  const {
    assigned: assignedAgents,
    autoOnly: autoModeOnlyAgents,
    total: totalAgentCount,
  } = deriveAgentUsage({
    serversForCatalog: allServersForCatalog,
    autoModeAgents,
  });

  // The most recent personal install for this catalog item, if any.
  const uninstallInstalls: UninstallServerInstall[] = (() => {
    const install = personalServersForCatalog
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];
    return install
      ? [
          {
            server: { id: install.id, name: install.name },
            assignedAgents: install.assignedAgents ?? [],
          },
        ]
      : [];
  })();

  const handleUninstallClick = () => {
    if (uninstallInstalls.length > 0) {
      setUninstallDialogOpen(true);
    }
  };

  // Gated like its Install and Reinstall siblings: removing a connection is
  // its own capability, and offering the button to a role without it only
  // buys the user a 403 from the delete call behind the dialog.
  const uninstallButton = hasPersonalConnection ? (
    <PermissionButton
      permissions={{ mcpServerInstallation: ["delete"] }}
      variant="outline"
      size="sm"
      className="flex-1 px-2.5"
      onClick={handleUninstallClick}
    >
      Uninstall
    </PermissionButton>
  ) : null;

  // The reinstall button follows `canFixInstall`, so an installs admin is
  // never shown a reinstall prompt for a connection whose button the card
  // then withholds because they do not own it.
  const userFlaggedInstalls = allServersForCatalog.filter(
    (s) =>
      s.reinstallRequired &&
      canFixInstall({
        server: s,
        viewer: {
          userId: currentUserId ?? null,
          canManageInstalls: !!isMcpServerInstallAdmin,
        },
      }),
  );
  const needsReinstall = userFlaggedInstalls.length > 0;
  const triggerReinstall = () =>
    onReinstall(
      userFlaggedInstalls.map((s) => ({
        id: s.id,
        name: s.name,
      })),
    );

  // Check if the K8s deployment has failed (e.g. CrashLoopBackOff) even while installation is "pending"
  const installedDeploymentStatus = installedServer?.id
    ? deploymentStatuses[installedServer.id]
    : null;
  const isDeploymentFailed = installedDeploymentStatus?.state === "failed";
  const _installationError =
    installationStatus === "error"
      ? (installedServer?.localInstallationError ?? "Installation failed")
      : null;

  const _mcpServersCount = mcpServerOfCurrentCatalogItem?.length ?? 0;

  // Check for OAuth refresh errors on any credential the user can see
  // The backend already filters mcpServerOfCurrentCatalogItem to only include visible credentials
  // Re-auth entry point gated by per-connection permission, not catalog-edit
  // access; the detailed reason lives on the credentials tab. When several
  // connections have failed, prefer one the caller can re-authenticate so the
  // marker stays actionable regardless of row order.
  const canReauthenticate = useCanReauthenticate();
  const oauthFailedServers = alertingEnabled
    ? (mcpServerOfCurrentCatalogItem?.filter((s) => s.oauthRefreshError) ?? [])
    : [];
  const oauthFailedServer =
    oauthFailedServers.find((s) => canReauthenticate(s)) ??
    oauthFailedServers[0];
  const oauthReauthIndicator = oauthFailedServer ? (
    <OAuthReauthIndicator
      onActivate={
        canReauthenticate(oauthFailedServer)
          ? () => goToItemPage("credentials")
          : undefined
      }
    />
  ) : null;

  const isInstalling = isCardShowingInstallInProgress({
    deploymentFailed: isDeploymentFailed,
    viewerTriggeredInstall: installingItemId === item.id,
    variant,
    installationStatus,
    hasInstalledServer: !!installedServer,
    installationOwnedByViewer:
      !!currentUserId && installedServer?.ownerId === currentUserId,
  });

  const isCurrentUserAuthenticated =
    currentUserId && installedServer?.users
      ? installedServer.users.includes(currentUserId)
      : false;
  const isRemoteVariant = variant === "remote";
  const isBuiltinVariant = variant === "builtin";

  // Catalog-scope reinstall: surfaces a banner + button on multi-tenant
  // local catalogs whose execution config (image, command, args, transport)
  // was edited. One click recreates the shared pod for everyone and cascades
  // tool sync. Gated by `canEditCatalog` (admin, a team-admin member of the
  // item's teams, or the personal-scope owner) since only those users can
  // apply catalog-scope changes.
  const needsCatalogReinstall =
    variant === "local" &&
    item.multitenant === true &&
    item.catalogReinstallRequired === true;
  const reinstallCatalogMutation = useReinstallInternalMcpCatalogItem();
  const triggerCatalogReinstall = () =>
    reinstallCatalogMutation.mutate(item.id);

  // Show ONE Reinstall button. For admins on a multi-tenant local catalog,
  // a single click drives both the per-install input collection (existing
  // modal flow) and the shared-pod recreate. For tenants, a precedence
  // rule hides the per-install button while the catalog flag is pending —
  // there's nothing useful they can do until the admin recreates the pod.
  const showAdminCatalogReinstall = needsCatalogReinstall && canEditCatalog;
  const showCombinedReinstall =
    showAdminCatalogReinstall ||
    (needsReinstall && !needsCatalogReinstall && isCurrentUserAuthenticated);

  const triggerCombinedReinstall = () => {
    if (showAdminCatalogReinstall && needsReinstall) {
      // Admin owes input AND catalog needs recreate: open the existing
      // per-install modal; on submit, parent chains catalog reinstall.
      return onReinstall(
        userFlaggedInstalls.map((s) => ({
          id: s.id,
          name: s.name,
        })),
        { alsoReinstallCatalog: true },
      );
    }
    if (showAdminCatalogReinstall) {
      // Admin doesn't owe input — fire catalog reinstall directly.
      return triggerCatalogReinstall();
    }
    // Tenant or admin without a catalog flag — existing per-install flow.
    return triggerReinstall();
  };

  // Collect server IDs for deployment status indicator.
  const deploymentServerIds = allServersForCatalog
    .filter((s) => s.serverType === "local")
    .map((s) => s.id);

  // Multi-tenant catalogs alias one K8s pod across many mcp_server rows.
  // Each row's K8sDeployment instance reports its own state independently
  // (one stays "pending" while another flips to "failed"), so before any
  // summary or per-row dot is computed, canonicalize the state per podName
  // by picking the highest-priority observation. All rows then agree.
  const effectiveDeploymentStatuses = (() => {
    if (!item.multitenant) return deploymentStatuses;
    const canonicalByPod = new Map<string, string>();
    for (const id of deploymentServerIds) {
      const entry = deploymentStatuses[id];
      if (!entry?.podName) continue;
      const current = canonicalByPod.get(entry.podName);
      if (
        !current ||
        (STATE_PRIORITY[entry.state] ?? 0) > (STATE_PRIORITY[current] ?? 0)
      ) {
        canonicalByPod.set(entry.podName, entry.state);
      }
    }
    if (canonicalByPod.size === 0) return deploymentStatuses;
    const next: typeof deploymentStatuses = { ...deploymentStatuses };
    for (const id of deploymentServerIds) {
      const entry = next[id];
      if (!entry?.podName) continue;
      const canonical = canonicalByPod.get(entry.podName);
      if (canonical && canonical !== entry.state) {
        next[id] = { ...entry, state: canonical as typeof entry.state };
      }
    }
    return next;
  })();

  const deploymentSummary = computeDeploymentStatusSummary(
    deploymentServerIds,
    effectiveDeploymentStatuses,
  );
  const deploymentStatusIndicator = deploymentSummary ? (
    <DeploymentStatusIconDot summary={deploymentSummary} />
  ) : null;
  // Worst live issue first, since issues are kind-ordered; an item whose only
  // trouble the viewer muted still shows it, muted.
  const statusIssue =
    issues?.find((issue) => !issue.muted) ?? issues?.[0] ?? null;
  const primaryIssueAction = statusIssue ? (
    <McpServerIssueNotice
      item={item}
      issues={issues ?? []}
      servers={allServersForCatalog}
      variant="primary-action"
    />
  ) : null;
  const toolsCount = item.toolCount ?? 0;

  const chatButton = shouldShowMcpCardChatButton({
    toolsCount,
    isBuiltin: isBuiltinVariant,
    hasInstallation: allServersForCatalog.length > 0,
  }) ? (
    <Button
      variant="outline"
      size="sm"
      className="flex-1"
      disabled={isChatCreating}
      aria-label={`Chat using ${item.name}`}
      onClick={() => startChat(item)}
    >
      <MessageSquare className="h-4 w-4" />
      {isChatCreating ? "Creating..." : "Chat"}
    </Button>
  ) : null;

  const settingsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      data-testid={`${E2eTestId.McpServerSettingsButton}-${item.name}`}
      onClick={() => goToItemPage()}
      aria-label={`Server settings for ${item.name}`}
    >
      <Pencil className="h-4 w-4" />
    </Button>
  );

  // A 4th connection folds into the +N count rather than lengthening the
  // stack: the stack is the widest fixed item in the compact info row, and
  // every extra circle comes straight out of the width the scope badge's name
  // has left to truncate into.
  const MAX_AVATARS = 3;
  const connectionAvatars: Array<{
    type: "team" | "user";
    label: string;
    key: string;
    serverIds: string[];
  }> = [];
  const seenKeys = new Set<string>();
  const hasOrgConnection = (mcpServerOfCurrentCatalogItem ?? []).some(
    (server) =>
      (server.scope ?? (server.teamId ? "team" : "personal")) === "org",
  );
  for (const server of mcpServerOfCurrentCatalogItem ?? []) {
    const serverScope = server.scope ?? (server.teamId ? "team" : "personal");
    if (serverScope === "org") {
      continue;
    }
    if (server.teamDetails?.name) {
      const key = `team-${server.teamDetails.teamId}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        connectionAvatars.push({
          type: "team",
          label: server.teamDetails.name,
          key,
          serverIds: [server.id],
        });
      } else {
        connectionAvatars.find((a) => a.key === key)?.serverIds.push(server.id);
      }
    } else if (server.ownerEmail) {
      const key = `user-${server.ownerEmail}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        connectionAvatars.push({
          type: "user",
          label: server.ownerEmail,
          key,
          serverIds: [server.id],
        });
      } else {
        connectionAvatars.find((a) => a.key === key)?.serverIds.push(server.id);
      }
    }
  }
  const extraCount = connectionAvatars.length - MAX_AVATARS;

  // Cards are one mixed list. Like Apps and Projects, every row names its
  // visibility so personal entries never rely on a removed ownership heading.
  const showScopeBadge = Boolean(item.scope);
  const showApprovalPanel = item.imageApprovalRequired === true;

  /** Who is connected and whether a connection needs attention. */
  const hasTrailingCluster =
    !isBuiltinVariant &&
    (connectionAvatars.length > 0 ||
      hasOrgConnection ||
      Boolean(oauthReauthIndicator));

  /** Whether anything follows the badge in the row. */
  const hasCompactInfoAfterScopeBadge =
    toolsCount > 0 || totalAgentCount > 0 || hasTrailingCluster;
  const hasCardMetadata = Boolean(
    environmentLabel ||
      statusIssue ||
      item.providesUi ||
      item.providesSkills ||
      showApprovalPanel,
  );

  const hasCompactInfoContent =
    hasCardMetadata || showScopeBadge || hasCompactInfoAfterScopeBadge;

  /*
    This usually fits on one line at the grid's card width, but operational
    states can add several badges and connection avatars at once. Let those
    fixed items wrap rather than paint outside a single-column card.

    Fixed items are `shrink-0` and the badge is the single elastic cell, so
    pressure lands on the one thing that can absorb it — a long author or team
    name truncates (its `title` keeps it readable) before the row wraps.

    Nothing separates the items but the gap. The 1px rules that used to sit
    between them cost ~21px each once their two gaps are counted — around a
    fifth of the row — which is most of what a name has to truncate into.
  */
  const compactInfoRow = hasCompactInfoContent ? (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
      {environmentLabel && (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          <span className="max-w-32 truncate">{environmentLabel}</span>
        </Badge>
      )}
      {statusIssue && (
        <span
          className="shrink-0"
          data-testid={
            statusIssue.kind === "failed-to-start"
              ? `${E2eTestId.McpServerError}-${item.name}-default`
              : undefined
          }
        >
          <McpServerIssueBadge issue={statusIssue} />
        </span>
      )}
      <McpCapabilityBadges
        providesUi={item.providesUi}
        providesSkills={item.providesSkills}
        skillCount={item.skillCount}
        className="shrink-0"
      />
      {showApprovalPanel && (
        <Badge variant="outline" className="shrink-0">
          Image needs approval
        </Badge>
      )}
      {showScopeBadge && (
        <div className="flex min-w-0 items-center">
          <ResourceVisibilityBadge
            scope={item.scope}
            teams={item.teams}
            authorId={item.authorId}
            authorName={item.authorName}
            currentUserId={currentUserId}
            showSelfAsMe
            compact
          />
        </div>
      )}
      {toolsCount > 0 && (
        <div className="flex shrink-0 items-center gap-1">
          <Wrench className="h-3.5 w-3.5" />
          <span data-testid={`${E2eTestId.McpServerToolsCount}`}>
            {toolsCount}
          </span>
        </div>
      )}
      {totalAgentCount > 0 && (
        <>
          {/*
            The popover is informational only, and it MUST NOT capture pointer
            events: it opens directly on top of the card's action row (Chat /
            Reinstall / Uninstall), so an interactive popover sits between the
            cursor and those buttons and swallows the click — the user presses
            Reinstall and nothing happens. `pointerEventsNone` puts the popper
            wrapper out of the hit-test path so clicks fall through to the
            button underneath. That leaves nothing clickable inside the card,
            so the trigger itself carries the link to the full usage list.
          */}
          <HoverCard openDelay={150}>
            <HoverCardTrigger asChild>
              <Link
                href={`/mcp/registry/${item.id}?tab=usage`}
                aria-label={`${totalAgentCount} ${
                  totalAgentCount === 1 ? "agent" : "agents"
                } can use ${item.name}, view usage`}
                className="flex shrink-0 items-center gap-1 hover:text-foreground transition-colors"
              >
                <Bot className="h-3.5 w-3.5" />
                <span data-testid={`${E2eTestId.McpServerAgentsCount}`}>
                  {totalAgentCount}
                </span>
              </Link>
            </HoverCardTrigger>
            <HoverCardContent pointerEventsNone className="w-72 p-3 text-sm">
              {assignedAgents.length > 0 && (
                <AgentUsageSection
                  title={`Used by ${assignedAgents.length} ${
                    assignedAgents.length === 1 ? "agent" : "agents"
                  } (assigned tools)`}
                  agents={assignedAgents}
                />
              )}
              {assignedAgents.length > 0 && autoModeOnlyAgents.length > 0 && (
                <div className="my-2 h-px bg-border" />
              )}
              {autoModeOnlyAgents.length > 0 && (
                <AgentUsageSection
                  title={`${autoModeOnlyAgents.length} auto-mode ${
                    autoModeOnlyAgents.length === 1 ? "agent" : "agents"
                  } (access all tools)`}
                  agents={autoModeOnlyAgents}
                />
              )}
              <p className="mt-2.5 flex items-center gap-1 border-t pt-2 text-xs text-muted-foreground">
                <span>View all usage</span>
                <ArrowUpRight className="h-3 w-3" />
              </p>
            </HoverCardContent>
          </HoverCard>
        </>
      )}
      {/*
        Trailing cluster, pushed to the card's right edge by `ml-auto` so the
        avatar stacks line up down a column of cards instead of each starting
        wherever its neighbour's name happened to end.
      */}
      {hasTrailingCluster && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {(connectionAvatars.length > 0 || hasOrgConnection) && (
            <AvatarGroup>
              {hasOrgConnection && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Installed organization-wide, manage credentials for ${item.name}`}
                        onClick={() => goToItemPage("credentials")}
                      >
                        <Avatar className="size-6 border-2 border-background cursor-pointer">
                          <AvatarFallback className="bg-amber-500/10 text-amber-800 dark:text-amber-400">
                            <Globe className="h-3 w-3" />
                          </AvatarFallback>
                        </Avatar>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Installed organization-wide. Manage credentials to review.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {connectionAvatars.slice(0, MAX_AVATARS).map((entry) => {
                const connDeployment = computeDeploymentStatusSummary(
                  entry.serverIds,
                  effectiveDeploymentStatuses,
                );
                const borderClass = connDeployment
                  ? {
                      running: "border-green-600 dark:border-green-800",
                      pending: "border-yellow-500 dark:border-yellow-600",
                      failed: "border-red-500 dark:border-red-700",
                      degraded: "border-orange-500 dark:border-orange-600",
                      // SPDX-SnippetBegin
                      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
                      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
                      hibernated: "border-muted-foreground",
                      waking: "border-muted-foreground",
                      // SPDX-SnippetEnd
                    }[connDeployment.overallState]
                  : "border-background";
                return (
                  <TooltipProvider key={entry.key}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Avatar className={`size-6 border-2 ${borderClass}`}>
                          <AvatarFallback
                            className={`text-[10px] ${entry.type === "team" ? "bg-accent" : ""}`}
                          >
                            {entry.label.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </TooltipTrigger>
                      <TooltipContent>
                        {entry.type === "team"
                          ? `Team: ${entry.label}`
                          : entry.label}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })}
              {extraCount > 0 && (
                <AvatarGroupCount className="size-6 text-[10px]">
                  +{extraCount}
                </AvatarGroupCount>
              )}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Manage credentials for ${item.name}`}
                      onClick={() => goToItemPage("credentials")}
                      data-testid={getManageCredentialsButtonTestId(item.name)}
                    >
                      <Avatar className="size-6 border-2 border-background cursor-pointer hover:opacity-80 transition-opacity">
                        <AvatarFallback className="text-muted-foreground bg-muted">
                          <Plus className="h-3 w-3" />
                        </AvatarFallback>
                      </Avatar>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Manage credentials</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </AvatarGroup>
          )}
          {oauthReauthIndicator}
        </div>
      )}
    </div>
  ) : null;

  const remoteInstallButton = (
    <PermissionButton
      permissions={{ mcpServerInstallation: ["create"] }}
      onClick={onInstallRemoteServer}
      size="sm"
      variant="outline"
      className="flex-1"
      aria-label={`Install ${item.name}`}
    >
      <User className="h-4 w-4" />
      Install
    </PermissionButton>
  );

  const remoteCardContent = (
    <>
      <div className="flex flex-nowrap gap-2 [&>*]:min-w-0">
        {primaryIssueAction}
        {chatButton}
        {!isInstalling && isCurrentUserAuthenticated && needsReinstall && (
          <PermissionButton
            permissions={{ mcpServerInstallation: ["create"] }}
            onClick={triggerReinstall}
            disabled={showApprovalPanel}
            size="sm"
            variant="outline"
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <RefreshCw className="h-4 w-4" />
            Reinstall
          </PermissionButton>
        )}
        {!isInstalling && (
          <>
            {uninstallButton}
            {!hasPersonalConnection && remoteInstallButton}
          </>
        )}
      </div>
    </>
  );

  // `showApprovalPanel` is declared above (before the card-content variants).
  // An admin reviews the config (→ edit page) and approves; the requester gets a
  // copy-link to share.
  const isInstallAdmin = !!isMcpServerInstallAdmin;

  const copyApprovalLink = () => {
    void copyToClipboard(
      `${window.location.origin}/mcp/registry/${item.id}/edit`,
    );
    toast.success("Link copied — share it with an admin to approve this image");
  };

  // When the image is gated, the full-width approval banner at the top of the
  // card body explains it and carries the action — so drop the inline install
  // button entirely (it would only fail the gate).
  const localInstallButton = showApprovalPanel ? null : (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex-1">
            <PermissionButton
              permissions={{ mcpServerInstallation: ["create"] }}
              onClick={onInstallLocalServer}
              disabled={!isLocalMcpEnabled}
              size="sm"
              variant="outline"
              className="w-full"
              data-testid={`${E2eTestId.ConnectCatalogItemButton}-${item.name}`}
            >
              <Server className="h-4 w-4" />
              Install
            </PermissionButton>
          </div>
        </TooltipTrigger>
        {!isLocalMcpEnabled && (
          <TooltipContent side="bottom">
            <p>{LOCAL_MCP_DISABLED_MESSAGE}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );

  const localCardContent = (
    <>
      <div className="flex flex-nowrap gap-2 [&>*]:min-w-0">
        {primaryIssueAction}
        {chatButton}
        {!isInstalling && showCombinedReinstall && (
          <PermissionButton
            permissions={
              showAdminCatalogReinstall
                ? { mcpRegistry: ["update"] }
                : { mcpServerInstallation: ["create"] }
            }
            onClick={triggerCombinedReinstall}
            disabled={reinstallCatalogMutation.isPending || showApprovalPanel}
            size="sm"
            variant="outline"
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <RefreshCw className="h-4 w-4" />
            Reinstall
          </PermissionButton>
        )}
        {!isInstalling && (
          <>
            {uninstallButton}
            {!hasPersonalConnection && localInstallButton}
          </>
        )}
      </div>
    </>
  );

  const playwrightCardContent = (
    <>
      <div className="flex flex-nowrap gap-2 [&>*]:min-w-0">
        {primaryIssueAction}
        {chatButton}
        {!isInstalling && isCurrentUserAuthenticated && needsReinstall && (
          <PermissionButton
            permissions={{ mcpServerInstallation: ["create"] }}
            onClick={triggerReinstall}
            disabled={showApprovalPanel}
            size="sm"
            variant="outline"
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <RefreshCw className="h-4 w-4" />
            Reinstall
          </PermissionButton>
        )}
        {!isInstalling && (
          <>
            {uninstallButton}
            {!hasPersonalConnection && localInstallButton}
          </>
        )}
      </div>
    </>
  );

  const builtinCardContent = (
    <>
      <div className="flex flex-nowrap gap-2 [&>*]:min-w-0">
        {primaryIssueAction}
        {chatButton}
      </div>
    </>
  );

  const dialogs = (
    <>
      <Dialog
        open={editNoAccessOpen}
        onOpenChange={(open) => {
          setEditNoAccessOpen(open);
          if (!open) clearEditParam();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="sr-only">
            <DialogTitle>No access</DialogTitle>
            <DialogDescription>
              You don't have access to edit this catalog item.
            </DialogDescription>
          </DialogHeader>
          <CatalogEditNoAccess />
        </DialogContent>
      </Dialog>

      <UninstallServerDialog
        open={uninstallDialogOpen}
        onClose={() => setUninstallDialogOpen(false)}
        installs={uninstallInstalls}
        isCancelingInstallation={isInstalling}
        onCancelInstallation={onCancelInstallation}
      />
    </>
  );

  const approvalAction = showApprovalPanel ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-full"
      onClick={
        isInstallAdmin
          ? () => router.push(`/mcp/registry/${item.id}/edit`)
          : copyApprovalLink
      }
    >
      {isInstallAdmin ? <FileSearch /> : <Copy />}
      <span>{isInstallAdmin ? "Review config" : "Copy approval link"}</span>
    </Button>
  ) : null;
  const cardActions =
    approvalAction ??
    (isBuiltinVariant
      ? builtinCardContent
      : isPlaywrightVariant
        ? playwrightCardContent
        : isRemoteVariant
          ? remoteCardContent
          : localCardContent);
  const hasCardBody = Boolean(
    compactInfoRow || (variant === "local" && isInstalling),
  );
  const cardBody = hasCardBody ? (
    <div className="space-y-3">
      {compactInfoRow}
      {variant === "local" && isInstalling && (
        <InstallationProgress
          status={
            installationStatus === "error" ? null : (installationStatus ?? null)
          }
          serverId={installedServer?.id}
          deploymentStatuses={deploymentStatuses}
          onMoreDetails={() => goToItemPage("logs", installedServer?.id)}
        />
      )}
    </div>
  ) : undefined;

  return (
    <>
      <TableCard
        testId={`${E2eTestId.McpServerCard}-${item.name}`}
        title={item.name}
        description={item.description}
        icon={
          <span className="relative flex size-9 items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
            <McpCatalogIcon icon={item.icon} catalogId={item.id} size={20} />
            {deploymentStatusIndicator}
          </span>
        }
        actions={canEditCatalog ? settingsButton : undefined}
        selected={selection?.selected}
        selectionDisabled={selection?.disabled}
        selectionDisabledTooltip={selection?.disabledTooltip}
        onSelectedChange={selection?.onSelectedChange}
        onSelectionClick={selection?.onSelectionClick}
        selectionLabel={selection ? `Select ${item.name}` : undefined}
        onNavigate={() => goToItemPage()}
        footer={cardActions}
        density="compact"
      >
        {cardBody}
      </TableCard>
      {dialogs}
    </>
  );
}

/**
 * One "used by" group in the card's hover card. Personal agents are seeded per
 * member and all share a name, so each is attributed to its owner — without it
 * the list reads as several identical "My Assistant" rows.
 */
function AgentUsageSection({
  title,
  agents,
}: {
  title: string;
  agents: AgentUsage[];
}) {
  const shown = agents.slice(0, AGENT_USAGE_PREVIEW_LIMIT);
  const remaining = agents.length - shown.length;

  return (
    <>
      <p className="font-medium">{title}</p>
      <div className="mt-1 space-y-0.5">
        {shown.map((agent) => {
          const owner = agentOwnerLabel(agent);
          return (
            <div key={agent.id} className="flex items-baseline gap-1.5">
              <span className="truncate">{agent.name}</span>
              {owner && (
                <span className="truncate text-xs text-muted-foreground">
                  {owner}
                </span>
              )}
            </div>
          );
        })}
        {remaining > 0 && (
          <div className="text-muted-foreground">+{remaining} more</div>
        )}
      </div>
    </>
  );
}

/** How many agents each hover-card group lists before collapsing to "+N more". */
const AGENT_USAGE_PREVIEW_LIMIT = 8;
