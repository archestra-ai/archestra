"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  E2eTestId,
  getManageCredentialsButtonTestId,
  type McpDeploymentStatusEntry,
} from "@shared";
import {
  AlertTriangle,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  User,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useCreateProfile } from "@/lib/agent.query";
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeature } from "@/lib/config/config.query";
import { useCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers, useMcpServerTools } from "@/lib/mcp/mcp-server.query";
import { useTeams } from "@/lib/teams/team.query";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
} from "./deployment-status";
import { InstallationProgress } from "./installation-progress";
import {
  McpServerSettingsDialog,
  type SettingsPage,
} from "./mcp-server-settings-dialog";
import { UninstallServerDialog } from "./uninstall-server-dialog";

export type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export type CatalogItemWithOptionalLabel = CatalogItem & {
  label?: string | null;
};

export type InstalledServer =
  archestraApiTypes.GetMcpServersResponses["200"][number];

export type McpServerCardProps = {
  item: CatalogItemWithOptionalLabel;
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
  onReinstall: () => void | Promise<void>;
  onDetails: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCancelInstallation?: (serverId: string) => void;
  /** Called when user wants to add a personal connection from manage dialog */
  onAddPersonalConnection?: () => void;
  /** Called when user wants to add a shared connection for a specific team */
  onAddSharedConnection?: (teamId: string) => void;
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
  onDetails: _onDetails,
  onEdit: _onEdit,
  onDelete,
  onCancelInstallation,
  onAddPersonalConnection,
  onAddSharedConnection,
  isBuiltInPlaywright = false,
}: McpServerCardBaseProps) {
  const isBuiltin = variant === "builtin";
  const isPlaywrightVariant = isBuiltInPlaywright;

  // For builtin servers, fetch tools by catalog ID
  // For regular MCP servers, fetch by server ID
  const { data: mcpServerTools } = useMcpServerTools(
    !isBuiltin ? (installedServer?.id ?? null) : null,
  );
  const { data: catalogTools } = useCatalogTools(isBuiltin ? item.id : null);

  const tools = isBuiltin ? catalogTools : mcpServerTools;

  const createAgent = useCreateProfile();
  const bulkAssignTools = useBulkAssignTools();
  const [isChatCreating, setIsChatCreating] = useState(false);

  const isByosEnabled = useFeature("byosEnabled");
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;
  const { data: userIsMcpServerAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");

  // Fetch all MCP servers to get installations for logs dropdown
  const { data: allMcpServers } = useMcpServers();
  const { data: teams } = useTeams();

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
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<
    SettingsPage | undefined
  >(undefined);
  const [logsInitialServerId, setLogsInitialServerId] = useState<string | null>(
    null,
  );
  const [uninstallingServer, setUninstallingServer] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const openSettingsPage = (page: SettingsPage) => {
    setSettingsInitialPage(page);
    setSettingsDialogOpen(true);
  };

  const handleChatWithMcpServer = async () => {
    setIsChatCreating(true);
    const agentName = item.label || item.name;
    try {
      // Get or create: check if a personal agent with this name already exists for the current user
      const { data: existingAgents } = await archestraApiSdk.getAllAgents({
        query: { agentType: "agent" },
      });
      const existing = existingAgents?.find(
        (a) => a.name === agentName && a.authorId === currentUserId,
      );

      const agent =
        existing ??
        (await createAgent.mutateAsync({
          name: agentName,
          agentType: "agent",
          scope: "personal",
          teams: [],
          icon: item.icon ?? undefined,
        }));

      if (agent && tools && tools.length > 0) {
        const assignments = tools.map((tool) => ({
          agentId: agent.id,
          toolId: tool.id,
          resolveAtCallTime: true,
        }));
        await bulkAssignTools.mutateAsync({ assignments });
      }

      if (agent) {
        window.location.href = `/chat/new?agent_id=${agent.id}`;
      }
    } catch {
      toast.error("Failed to create chat agent");
    } finally {
      setIsChatCreating(false);
    }
  };

  const mcpServerOfCurrentCatalogItem = allMcpServers?.filter(
    (s) => s.catalogId === item.id,
  );

  // Find the current user's personal connection for this catalog item
  const personalServer = mcpServerOfCurrentCatalogItem?.find(
    (s) => s.ownerId === currentUserId && !s.teamId,
  );
  const hasPersonalConnection = !!personalServer;

  // Aggregate all installations for this catalog item (for logs dropdown)
  let localInstalls: NonNullable<typeof allMcpServers> = [];
  if (
    installedServer?.catalogId &&
    variant === "local" &&
    allMcpServers &&
    allMcpServers.length > 0
  ) {
    localInstalls = allMcpServers
      .filter(({ catalogId, serverType }) => {
        return (
          catalogId === installedServer.catalogId && serverType === "local"
        );
      })
      .sort((a, b) => {
        // Sort by createdAt ascending (oldest first, most recent last)
        return (
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });
  }

  // All installations for this catalog item (local + remote, for Inspector)
  const allInstalls: NonNullable<typeof allMcpServers> =
    localInstalls.length > 0
      ? localInstalls
      : (mcpServerOfCurrentCatalogItem ?? []).sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );

  const needsReinstall = installedServer?.reinstallRequired;

  // Check if the K8s deployment has failed (e.g. CrashLoopBackOff) even while installation is "pending"
  const installedDeploymentStatus = installedServer?.id
    ? deploymentStatuses[installedServer.id]
    : null;
  const isDeploymentFailed = installedDeploymentStatus?.state === "failed";

  const hasError = installedServer?.localInstallationStatus === "error";
  const errorMessage =
    installedServer?.localInstallationError || installedDeploymentStatus?.error;
  const _mcpServersCount = mcpServerOfCurrentCatalogItem?.length ?? 0;

  // Check for OAuth refresh errors on any credential the user can see
  // The backend already filters mcpServerOfCurrentCatalogItem to only include visible credentials
  const isOAuthServer = !!item.oauthConfig;
  const hasOAuthRefreshError =
    isOAuthServer &&
    (mcpServerOfCurrentCatalogItem?.some((s) => s.oauthRefreshError) ?? false);

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

  // Check if logs are available (local variant with at least one installation)
  const isLogsAvailable = variant === "local";

  // Collect server IDs for deployment status indicator
  const deploymentServerIds = (allMcpServers ?? [])
    .filter((s) => s.catalogId === item.id && s.serverType === "local")
    .map((s) => s.id);
  const deploymentSummary = computeDeploymentStatusSummary(
    deploymentServerIds,
    deploymentStatuses,
  );

  const chatButton =
    tools && tools.length > 0 ? (
      <Button
        variant="outline"
        size="sm"
        className="flex-1"
        disabled={isChatCreating}
        onClick={handleChatWithMcpServer}
      >
        <MessageSquare className="mr-2 h-4 w-4" />
        {isChatCreating ? "Creating..." : "Chat"}
      </Button>
    ) : null;

  const settingsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => openSettingsPage("configuration")}
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
  for (const server of mcpServerOfCurrentCatalogItem ?? []) {
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

  const toolsCount = tools?.length ?? 0;

  const hasCompactInfoContent =
    toolsCount > 0 ||
    (variant === "local" && deploymentServerIds.length > 0) ||
    (!isBuiltinVariant && connectionAvatars.length > 0);

  const compactInfoRow = hasCompactInfoContent ? (
    <div className="flex items-center gap-3 text-sm text-muted-foreground border-t pt-3">
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
              onClick={() => openSettingsPage("debug-logs")}
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
      {!isBuiltinVariant && connectionAvatars.length > 0 && (
        <div className="flex items-center gap-2">
          <AvatarGroup>
            {connectionAvatars.slice(0, MAX_AVATARS).map((entry) => {
              const connDeployment = computeDeploymentStatusSummary(
                entry.serverIds,
                deploymentStatuses,
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
                    onClick={() => openSettingsPage("connections")}
                    data-testid={getManageCredentialsButtonTestId(item.name)}
                  >
                    <AvatarFallback className="text-muted-foreground bg-muted">
                      <Plus className="h-3 w-3" />
                    </AvatarFallback>
                  </Avatar>
                </TooltipTrigger>
                <TooltipContent>Manage connections</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </AvatarGroup>
          {hasOAuthRefreshError && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertTriangle className="h-4 w-4 text-amber-500 cursor-help" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="font-medium mb-1">Authentication failed</p>
                  <p className="text-xs text-muted-foreground">
                    Some connections need re-authentication.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      )}
    </div>
  ) : null;

  const shouldShowErrorBanner = hasError || isDeploymentFailed;

  const remoteCardContent = (
    <>
      <div className="flex flex-wrap gap-2">
        {chatButton}
        {!isInstalling && isCurrentUserAuthenticated && needsReinstall && (
          <PermissionButton
            permissions={{ mcpServerInstallation: ["update"] }}
            onClick={onReinstall}
            size="sm"
            variant="outline"
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reconnect
          </PermissionButton>
        )}
        {!isInstalling &&
          (hasPersonalConnection ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                if (personalServer) {
                  setUninstallingServer({
                    id: personalServer.id,
                    name: personalServer.name,
                  });
                }
              }}
            >
              Disconnect
            </Button>
          ) : (
            <PermissionButton
              permissions={{ mcpServerInstallation: ["create"] }}
              onClick={onAddPersonalConnection ?? onInstallRemoteServer}
              size="sm"
              variant="outline"
              className="flex-1"
            >
              <User className="mr-2 h-4 w-4" />
              Connect
            </PermissionButton>
          ))}
      </div>
    </>
  );

  const localCardContent = (
    <>
      <div className="flex flex-wrap gap-2">
        {chatButton}
        {!isInstalling && isCurrentUserAuthenticated && needsReinstall && (
          <PermissionButton
            permissions={{ mcpServerInstallation: ["update"] }}
            onClick={onReinstall}
            size="sm"
            variant="outline"
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reinstall
          </PermissionButton>
        )}
        {!isInstalling &&
          (hasPersonalConnection ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                if (personalServer) {
                  setUninstallingServer({
                    id: personalServer.id,
                    name: personalServer.name,
                  });
                }
              }}
            >
              Uninstall
            </Button>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex-1">
                    <PermissionButton
                      permissions={{ mcpServerInstallation: ["create"] }}
                      onClick={onAddPersonalConnection ?? onInstallLocalServer}
                      disabled={!isLocalMcpEnabled}
                      size="sm"
                      variant="outline"
                      className="w-full"
                      data-testid={`${E2eTestId.ConnectCatalogItemButton}-${item.name}`}
                    >
                      <Server className="mr-2 h-4 w-4" />
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
          ))}
      </div>
    </>
  );

  const playwrightCardContent = (
    <>
      <div className="flex flex-wrap gap-2">
        {chatButton}
        {!isInstalling && isCurrentUserAuthenticated && needsReinstall && (
          <PermissionButton
            permissions={{ mcpServerInstallation: ["update"] }}
            onClick={onReinstall}
            size="sm"
            variant="outline"
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reinstall
          </PermissionButton>
        )}
        {!isInstalling &&
          (hasPersonalConnection ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                if (personalServer) {
                  setUninstallingServer({
                    id: personalServer.id,
                    name: personalServer.name,
                  });
                }
              }}
            >
              Uninstall
            </Button>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex-1">
                    <PermissionButton
                      permissions={{ mcpServerInstallation: ["create"] }}
                      onClick={onAddPersonalConnection ?? onInstallLocalServer}
                      disabled={!isLocalMcpEnabled}
                      size="sm"
                      variant="outline"
                      className="w-full"
                      data-testid={`${E2eTestId.ConnectCatalogItemButton}-${item.name}`}
                    >
                      <Server className="mr-2 h-4 w-4" />
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
          ))}
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
      <McpServerSettingsDialog
        open={settingsDialogOpen}
        onOpenChange={(open) => {
          setSettingsDialogOpen(open);
          if (!open) {
            setLogsInitialServerId(null);
            setSettingsInitialPage(undefined);
          }
        }}
        initialPage={settingsInitialPage}
        item={item}
        variant={variant}
        showConnections={!isBuiltinVariant}
        connectionCount={mcpServerOfCurrentCatalogItem?.length ?? 0}
        showDebug={isLogsAvailable}
        showInspector
        showYaml={variant === "local"}
        onAddPersonalConnection={onAddPersonalConnection}
        onAddSharedConnection={onAddSharedConnection}
        installs={allInstalls}
        deploymentStatuses={deploymentStatuses}
        deploymentServerIds={deploymentServerIds}
        onReinstall={() => onReinstall()}
        logsInitialServerId={logsInitialServerId}
        hasPersonalConnection={hasPersonalConnection}
        onConnect={
          onAddPersonalConnection ??
          (variant === "local" ? onInstallLocalServer : onInstallRemoteServer)
        }
        needsReinstall={
          !!needsReinstall && !isInstalling && isCurrentUserAuthenticated
        }
        onDelete={!isPlaywrightVariant ? onDelete : undefined}
      />

      <UninstallServerDialog
        server={uninstallingServer}
        onClose={() => setUninstallingServer(null)}
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
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          {(userIsMcpServerAdmin ||
            (item.scope === "personal" && item.authorId === currentUserId)) &&
            settingsButton}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 flex-grow">
        {variant === "local" && (isInstalling || shouldShowErrorBanner) && (
          <div className="bg-muted/50 rounded-md overflow-hidden">
            {isInstalling ? (
              <div className="px-3 py-2">
                <InstallationProgress
                  status={
                    installationStatus === "error"
                      ? null
                      : (installationStatus ?? null)
                  }
                  serverId={installedServer?.id}
                  deploymentStatuses={deploymentStatuses}
                  onMoreDetails={() => {
                    setSettingsInitialPage("debug-logs");
                    if (installedServer?.id) {
                      setLogsInitialServerId(installedServer.id);
                    }
                    setSettingsDialogOpen(true);
                  }}
                />
              </div>
            ) : isCurrentUserAuthenticated &&
              shouldShowErrorBanner &&
              errorMessage ? (
              <div className="flex items-center justify-between px-3 py-2 text-sm">
                <span
                  className="text-destructive"
                  data-testid={`${E2eTestId.McpServerError}-${item.name}`}
                >
                  Failed to start MCP server,{" "}
                  <button
                    type="button"
                    onClick={() => openSettingsPage("debug-logs")}
                    className="text-primary hover:underline cursor-pointer"
                    data-testid={`${E2eTestId.McpLogsViewButton}-${item.name}`}
                  >
                    view the logs
                  </button>{" "}
                  or{" "}
                  <button
                    type="button"
                    onClick={() => openSettingsPage("configuration")}
                    className="text-primary hover:underline cursor-pointer"
                    data-testid={`${E2eTestId.McpLogsEditConfigButton}-${item.name}`}
                  >
                    edit your config
                  </button>
                  .
                </span>
              </div>
            ) : null}
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
