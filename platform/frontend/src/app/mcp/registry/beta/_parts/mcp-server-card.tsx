"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  getManageCredentialsButtonTestId,
  MCP_CATALOG_EDIT_QUERY_PARAM,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import {
  AlertTriangle,
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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { useReinstallInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { useCanModifyCatalogItem } from "../../_parts/catalog-edit-access";
import { clearCatalogEditParam } from "../../_parts/catalog-edit-link";
import { resolveCatalogEnvironmentLabel } from "../../_parts/catalog-environment-label";
import { shouldShowMcpCardChatButton } from "../../_parts/chat-button-visibility";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
} from "../../_parts/deployment-status";
import { InstallationProgress } from "../../_parts/installation-progress";
import { OAuthReauthIndicator } from "../../_parts/oauth-reauth-indicator";
import {
  UninstallServerDialog,
  type UninstallServerInstall,
} from "../../_parts/uninstall-server-dialog";
import { useCanReauthenticate } from "../../_parts/use-can-reauthenticate";
import { CatalogEditNoAccess } from "./edit-catalog-dialog";
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
  onInstallRemoteServer,
  onInstallLocalServer,
  onReinstall,
  onCancelInstallation,
  isBuiltInPlaywright = false,
}: McpServerCardBaseProps) {
  const isPlaywrightVariant = isBuiltInPlaywright;

  const { startChat, isCreating: isChatCreating } = useChatWithCatalogItem();

  const isByosEnabled = useFeature("byosEnabled");
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");

  // Environment label shown next to the title. Only surfaced once the org has
  // more than the single implicit Default environment; Default-assigned items
  // only show it when Default has been renamed. Built-in (Playwright) servers
  // aren't environment-scoped, so skip them. Both queries are shared/cached, so
  // calling them per card doesn't fan out requests.
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
    router.push(`/mcp/registry/beta/${item.id}${qs ? `?${qs}` : ""}`);
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
      router.replace(`/mcp/registry/beta/${item.id}/edit`);
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

  // The most recent personal install for this catalog item, if any.
  const uninstallInstalls: UninstallServerInstall[] = (() => {
    const install = personalServersForCatalog
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];
    return install ? [{ server: { id: install.id, name: install.name } }] : [];
  })();

  const handleUninstallClick = () => {
    if (uninstallInstalls.length > 0) {
      setUninstallDialogOpen(true);
    }
  };

  const uninstallButton = hasPersonalConnection ? (
    <Button
      variant="outline"
      size="sm"
      className="flex-1"
      onClick={handleUninstallClick}
    >
      Uninstall
    </Button>
  ) : null;

  const userFlaggedInstalls = allServersForCatalog.filter(
    (s) => s.reinstallRequired && s.ownerId === currentUserId,
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
  const isOAuthServer = !!item.oauthConfig;
  // Re-auth entry point gated by per-connection permission, not catalog-edit
  // access; the detailed reason lives on the credentials tab. When several
  // connections have failed, prefer one the caller can re-authenticate so the
  // marker stays actionable regardless of row order.
  const canReauthenticate = useCanReauthenticate();
  const oauthFailedServers = isOAuthServer
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

  const isInstalling = Boolean(
    !isDeploymentFailed &&
      (installingItemId === item.id ||
        (variant === "local" &&
          (installationStatus === "pending" ||
            (installationStatus === "discovering-tools" && installedServer)))),
  );

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
  const STATE_PRIORITY: Record<string, number> = {
    failed: 4,
    running: 3,
    succeeded: 3,
    pending: 2,
    not_created: 1,
  };
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
    >
      <Pencil className="h-4 w-4" />
    </Button>
  );

  const MAX_AVATARS = 4;
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

  const showAuthorAvatar =
    item.scope === "personal" && Boolean(item.authorName);

  const hasCompactInfoContent =
    showAuthorAvatar ||
    toolsCount > 0 ||
    (variant === "local" && deploymentServerIds.length > 0) ||
    (!isBuiltinVariant &&
      (connectionAvatars.length > 0 ||
        hasOrgConnection ||
        Boolean(oauthReauthIndicator)));

  const compactInfoRow = hasCompactInfoContent ? (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      {showAuthorAvatar && (
        <>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Avatar className="size-6 border-2 border-background">
                  <AvatarFallback className="text-[10px]">
                    {item.authorName?.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent>Author: {item.authorName}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {(toolsCount > 0 ||
            (variant === "local" && deploymentServerIds.length > 0) ||
            (!isBuiltinVariant &&
              (connectionAvatars.length > 0 || hasOrgConnection))) && (
            <div className="h-4 w-px bg-border" />
          )}
        </>
      )}
      {toolsCount > 0 && (
        <>
          <div className="flex items-center gap-1">
            <Wrench className="h-3.5 w-3.5" />
            <span data-testid={`${E2eTestId.McpServerToolsCount}`}>
              {toolsCount}
            </span>
          </div>
          <div className="h-4 w-px bg-border" />
        </>
      )}
      {variant === "local" && deploymentServerIds.length > 0 && (
        <>
          {deploymentSummary ? (
            <button
              type="button"
              onClick={() => goToItemPage("logs")}
              className="flex items-center gap-1.5 cursor-pointer hover:text-foreground transition-colors"
            >
              <DeploymentStatusDot state={deploymentSummary.overallState} />
              <span>
                {deploymentSummary.running}/{deploymentSummary.total}
              </span>
            </button>
          ) : (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground/50 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-muted-foreground/50" />
            </span>
          )}
          <div className="h-4 w-px bg-border" />
        </>
      )}
      {!isBuiltinVariant &&
        (connectionAvatars.length > 0 || hasOrgConnection) && (
          <div className="flex items-center gap-2">
            <AvatarGroup>
              {hasOrgConnection && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Avatar
                        className="size-6 border-2 border-background cursor-pointer"
                        onClick={() => goToItemPage("credentials")}
                      >
                        <AvatarFallback className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                          <Globe className="h-3 w-3" />
                        </AvatarFallback>
                      </Avatar>
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
                    <Avatar
                      className="size-6 border-2 border-background cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => goToItemPage("credentials")}
                      data-testid={getManageCredentialsButtonTestId(item.name)}
                    >
                      <AvatarFallback className="text-muted-foreground bg-muted">
                        <Plus className="h-3 w-3" />
                      </AvatarFallback>
                    </Avatar>
                  </TooltipTrigger>
                  <TooltipContent>Manage credentials</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </AvatarGroup>
          </div>
        )}
      {!isBuiltinVariant && oauthReauthIndicator}
    </div>
  ) : null;

  const remoteInstallButton = (
    <PermissionButton
      permissions={{ mcpServerInstallation: ["create"] }}
      onClick={onInstallRemoteServer}
      size="sm"
      variant="outline"
      className="flex-1"
    >
      <User className="h-4 w-4" />
      Install
    </PermissionButton>
  );

  // The trusted-image-registry policy holds this catalog's image until an admin
  // approves it. Declared before the card-content variants since they gate the
  // reinstall button on it.
  const showApprovalPanel = item.imageApprovalRequired === true;

  const remoteCardContent = (
    <>
      <div className="flex flex-wrap gap-2">
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
    void navigator.clipboard.writeText(
      `${window.location.origin}/mcp/registry/beta/${item.id}/edit`,
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
      <div className="flex flex-wrap gap-2">
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
      <div className="flex flex-wrap gap-2">
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
      <div>{chatButton}</div>
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

  return (
    <Card
      className="flex flex-col relative pt-4 gap-4 h-full"
      data-testid={`${E2eTestId.McpServerCard}-${item.name}`}
    >
      <CardHeader className="gap-0">
        <div className="flex items-start justify-between gap-4 overflow-hidden">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 overflow-hidden w-full">
              <McpCatalogIcon icon={item.icon} catalogId={item.id} size={20} />
              <TruncatedTooltip content={item.name}>
                <span className="text-lg font-semibold whitespace-nowrap text-ellipsis overflow-hidden">
                  {item.name}
                </span>
              </TruncatedTooltip>
              {environmentLabel && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-muted-foreground"
                >
                  <span className="max-w-32 truncate">{environmentLabel}</span>
                </Badge>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          {canEditCatalog && settingsButton}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 flex-grow">
        {showApprovalPanel && (
          <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-500">
              <span>
                {isInstallAdmin
                  ? "Image needs approval"
                  : "Admin review required"}
              </span>
              {isInstallAdmin ? (
                <button
                  type="button"
                  onClick={() =>
                    router.push(`/mcp/registry/beta/${item.id}/edit`)
                  }
                  title="Review config"
                  aria-label="Review config"
                  className="shrink-0 rounded p-0.5 hover:bg-amber-500/10"
                >
                  <FileSearch className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={copyApprovalLink}
                  title="Copy link"
                  aria-label="Copy link"
                  className="shrink-0 rounded p-0.5 hover:bg-amber-500/10"
                >
                  <Copy className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {allServersForCatalog.length > 0
                ? "The Docker image was changed to one that isn't from a trusted registry. Existing connections keep running the previous image until an admin approves."
                : isInstallAdmin
                  ? "This MCP server Docker image isn't from a trusted image registry. Review and approve configuration to allow installs."
                  : "This MCP server Docker image isn't from a trusted image registry. An admin must approve it before it can be installed."}
            </p>
          </div>
        )}
        {variant === "local" &&
          (() => {
            // Multi-tenant catalogs alias one K8s pod across many mcp_server
            // rows, so every sibling install reports the same error.
            // Collapse failed banners per (catalog) for multi-tenant —
            // the failure is catalog-scope by construction. Single-tenant
            // installs each own their own pod; dedup by podName falling
            // back to error text. The previous pod-name-only dedup was
            // brittle: `deploymentStatuses` is keyed per install id and
            // the WS handler may have delivered podName for some
            // siblings but not others, leaving N-1 banners showing.
            const seenKeys = new Set<string>();
            return allServersForCatalog.filter((s) => {
              if (s.localInstallationStatus !== "error") return false;
              const dedupKey = item.multitenant
                ? `catalog:${s.catalogId}`
                : (deploymentStatuses[s.id]?.podName ??
                  s.localInstallationError ??
                  s.id);
              if (seenKeys.has(dedupKey)) return false;
              seenKeys.add(dedupKey);
              return true;
            });
          })().map((failed) => {
            const errorMsg =
              failed.localInstallationError ?? "Installation failed";
            return (
              <div
                key={failed.id}
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid={`${E2eTestId.McpServerError}-${item.name}-default`}
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Installation failed</p>
                    <p className="truncate text-xs" title={errorMsg}>
                      {errorMsg}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-destructive"
                      data-testid={`${E2eTestId.McpLogsViewButton}-${item.name}-default`}
                      onClick={() => goToItemPage("logs", failed.id)}
                    >
                      View logs
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-destructive"
                      data-testid={`${E2eTestId.McpLogsEditConfigButton}-${item.name}-default`}
                      onClick={() =>
                        router.push(`/mcp/registry/beta/${item.id}/edit`)
                      }
                    >
                      Edit config
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        {variant === "local" && isInstalling && (
          <div className="bg-muted/50 rounded-md overflow-hidden">
            <div className="px-3 py-2">
              <InstallationProgress
                status={
                  installationStatus === "error"
                    ? null
                    : (installationStatus ?? null)
                }
                serverId={installedServer?.id}
                deploymentStatuses={deploymentStatuses}
                onMoreDetails={() => goToItemPage("logs", installedServer?.id)}
              />
            </div>
          </div>
        )}
        <div className="mt-auto flex flex-col gap-4">
          {compactInfoRow}
          {isBuiltinVariant
            ? builtinCardContent
            : isPlaywrightVariant
              ? playwrightCardContent
              : isRemoteVariant
                ? remoteCardContent
                : localCardContent}
        </div>
      </CardContent>
      {dialogs}
    </Card>
  );
}
