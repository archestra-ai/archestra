"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  archestraApiSdk,
  type archestraApiTypes,
  E2eTestId,
  type McpDeploymentStatusEntry,
} from "@shared";
import {
  AlertTriangle,
  Code,
  MessageSquare,
  MoreVertical,
  Pencil,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
  User,
} from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { toast } from "sonner";

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useCreateProfile } from "@/lib/agent.query";
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeatureFlag } from "@/lib/features.hook";
import { useCatalogTools } from "@/lib/internal-mcp-catalog.query";
import { useMcpServers, useMcpServerTools } from "@/lib/mcp-server.query";
import { useTeams } from "@/lib/team.query";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  getDeploymentLabel,
} from "./deployment-status";
import { InstallationProgress } from "./installation-progress";
import { ManageUsersDialog } from "./manage-users-dialog";

import { McpLogsDialog } from "./mcp-logs-dialog";

import { UninstallServerDialog } from "./uninstall-server-dialog";
import { YamlConfigDialog } from "./yaml-config-dialog";

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
  onReinstall: () => void;
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

function McpCatalogIcon({
  icon,
  catalogId,
  size = 20,
}: {
  icon?: string | null;
  catalogId?: string;
  size?: number;
}) {
  if (!icon && catalogId === ARCHESTRA_MCP_CATALOG_ID) {
    return (
      <Image
        src="/logo.png"
        alt="Archestra"
        width={size}
        height={size}
        className="shrink-0 rounded-sm object-contain"
      />
    );
  }

  if (!icon) {
    return (
      <Server
        className="shrink-0 text-muted-foreground"
        style={{ width: size, height: size }}
      />
    );
  }

  if (icon.startsWith("data:")) {
    return (
      <Image
        src={icon}
        alt="MCP server icon"
        width={size}
        height={size}
        className="shrink-0 rounded-sm object-contain"
      />
    );
  }

  return (
    <span className="shrink-0 leading-none" style={{ fontSize: size }}>
      {icon}
    </span>
  );
}

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
  onEdit,
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

  const isByosEnabled = useFeatureFlag("byosEnabled");
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;
  const { data: userIsMcpServerAdmin } = useHasPermissions({
    mcpServer: ["admin"],
  });
  const isLocalMcpEnabled = useFeatureFlag("orchestratorK8sRuntime");

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
  const [isManageUsersDialogOpen, setIsManageUsersDialogOpen] = useState(false);
  const [isLogsDialogOpen, setIsLogsDialogOpen] = useState(false);
  const [isYamlConfigDialogOpen, setIsYamlConfigDialogOpen] = useState(false);
  const [uninstallingServer, setUninstallingServer] = useState<{
    id: string;
    name: string;
  } | null>(null);

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
          useDynamicTeamCredential: true,
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

  const needsReinstall = installedServer?.reinstallRequired;
  const hasError = installedServer?.localInstallationStatus === "error";
  const errorMessage = installedServer?.localInstallationError;
  const _mcpServersCount = mcpServerOfCurrentCatalogItem?.length ?? 0;

  // Check for OAuth refresh errors on any credential the user can see
  // The backend already filters mcpServerOfCurrentCatalogItem to only include visible credentials
  const isOAuthServer = !!item.oauthConfig;
  const hasOAuthRefreshError =
    isOAuthServer &&
    (mcpServerOfCurrentCatalogItem?.some((s) => s.oauthRefreshError) ?? false);

  const isInstalling = Boolean(
    installingItemId === item.id ||
      (variant === "local" &&
        (installationStatus === "pending" ||
          (installationStatus === "discovering-tools" && installedServer))),
  );

  const isCurrentUserAuthenticated =
    currentUserId && installedServer?.users
      ? installedServer.users.includes(currentUserId)
      : false;
  const isRemoteVariant = variant === "remote";
  const isBuiltinVariant = variant === "builtin";

  // Check if logs are available (local variant with at least one installation)
  const hasLocalInstallations = localInstalls.length > 0;
  const isLogsAvailable = variant === "local" && hasLocalInstallations;

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

  const manageCatalogItemDropdownMenu = (
    <div className="flex flex-wrap gap-1 items-center flex-shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </DropdownMenuItem>
          {isLogsAvailable && (
            <DropdownMenuItem onClick={() => setIsLogsDialogOpen(true)}>
              <Terminal className="mr-2 h-4 w-4" />
              Debug
            </DropdownMenuItem>
          )}
          {variant === "local" && (
            <DropdownMenuItem onClick={() => setIsYamlConfigDialogOpen(true)}>
              <Code className="mr-2 h-4 w-4" />
              Edit K8s Deployment YAML
            </DropdownMenuItem>
          )}
          {!isPlaywrightVariant && (
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const MAX_AVATARS = 4;
  const connectionAvatars: Array<{
    type: "team" | "user";
    label: string;
    key: string;
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
        });
      }
    } else if (server.ownerEmail) {
      const key = `user-${server.ownerEmail}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        connectionAvatars.push({
          type: "user",
          label: server.ownerEmail,
          key,
        });
      }
    }
  }
  const extraCount = connectionAvatars.length - MAX_AVATARS;

  const connectionsAvatarGroup = (
    <>
      <div className="flex items-center gap-2">
        {connectionAvatars.length > 0 ? (
          <AvatarGroup>
            {connectionAvatars.slice(0, MAX_AVATARS).map((entry) => (
              <TooltipProvider key={entry.key}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Avatar
                      className={`size-6 border-2 border-background ${entry.type === "team" ? "rounded-md" : ""}`}
                    >
                      <AvatarFallback
                        className={`text-[10px] ${entry.type === "team" ? "rounded-md bg-primary/10" : ""}`}
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
            ))}
            {extraCount > 0 && (
              <AvatarGroupCount className="size-6 text-[10px]">
                +{extraCount}
              </AvatarGroupCount>
            )}
          </AvatarGroup>
        ) : (
          <span className="text-xs text-muted-foreground">No connections</span>
        )}
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
      <Button
        onClick={() => setIsManageUsersDialogOpen(true)}
        size="sm"
        variant="link"
        className="h-7 text-xs"
        data-testid={`${E2eTestId.ManageCredentialsButton}-${installedServer?.catalogName}`}
      >
        Manage
      </Button>
    </>
  );

  const shouldShowErrorBanner = hasError;

  const remoteCardContent = (
    <>
      <div className="bg-muted/50 rounded-md overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 text-sm border-b border-muted h-10">
          {connectionsAvatarGroup}
        </div>
      </div>
      {/* Show reconnect button only when NOT installing */}
      {isCurrentUserAuthenticated &&
        (needsReinstall || hasError) &&
        !isInstalling && (
          <PermissionButton
            permissions={{ mcpServer: ["update"] }}
            onClick={onReinstall}
            size="sm"
            variant="default"
            className="flex-1"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reconnect Required
          </PermissionButton>
        )}
      {/* Spacer + action buttons pinned to bottom */}
      <div className="mt-auto flex flex-wrap gap-2">
        {chatButton}
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
              permissions={{ mcpServer: ["create"] }}
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
      <div className="bg-muted/50 rounded-md overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 text-sm border-b border-muted h-10">
          {connectionsAvatarGroup}
        </div>
      </div>
      {/* Show reinstall button only when NOT installing (hide during reinstall to show progress bar) */}
      {isCurrentUserAuthenticated && needsReinstall && !isInstalling && (
        <PermissionButton
          permissions={{ mcpServer: ["update"] }}
          onClick={onReinstall}
          size="sm"
          variant="default"
          className="w-full"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Reinstall Required
        </PermissionButton>
      )}
      {/* Spacer + action buttons pinned to bottom */}
      <div className="mt-auto flex flex-wrap gap-2">
        {chatButton}
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
                      permissions={{ mcpServer: ["create"] }}
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
      <div className="bg-muted/50 rounded-md overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 text-sm border-b border-muted h-10">
          {connectionsAvatarGroup}
        </div>
      </div>
      {/* Show reinstall button only when NOT installing */}
      {isCurrentUserAuthenticated && needsReinstall && !isInstalling && (
        <PermissionButton
          permissions={{ mcpServer: ["update"] }}
          onClick={onReinstall}
          size="sm"
          variant="default"
          className="w-full"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Reinstall Required
        </PermissionButton>
      )}
      {/* Spacer + action buttons pinned to bottom */}
      <div className="mt-auto flex flex-wrap gap-2">
        {chatButton}
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
                      permissions={{ mcpServer: ["create"] }}
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
      <div className="mt-auto">{chatButton}</div>
    </>
  );

  const dialogs = (
    <>
      <McpLogsDialog
        open={isLogsDialogOpen}
        onOpenChange={setIsLogsDialogOpen}
        serverName={item.label || item.name}
        installs={localInstalls}
        deploymentStatuses={deploymentStatuses}
      />

      <ManageUsersDialog
        catalogId={item.id}
        isOpen={isManageUsersDialogOpen}
        onClose={() => setIsManageUsersDialogOpen(false)}
        label={item.label || item.name}
        onAddPersonalConnection={onAddPersonalConnection}
        onAddSharedConnection={onAddSharedConnection}
      />

      <UninstallServerDialog
        server={uninstallingServer}
        onClose={() => setUninstallingServer(null)}
        isCancelingInstallation={isInstalling}
        onCancelInstallation={onCancelInstallation}
      />

      <YamlConfigDialog
        item={isYamlConfigDialogOpen ? item : null}
        onClose={() => setIsYamlConfigDialogOpen(false)}
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
            <div
              className="flex items-center gap-2 mb-1 overflow-hidden w-full"
              title={item.name}
            >
              <McpCatalogIcon icon={item.icon} catalogId={item.id} size={20} />
              <span className="text-lg font-semibold whitespace-nowrap text-ellipsis overflow-hidden">
                {item.name}
              </span>
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          {(userIsMcpServerAdmin ||
            (item.scope === "personal" && item.authorId === currentUserId)) &&
            manageCatalogItemDropdownMenu}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 flex-grow">
        {(deploymentSummary || isInstalling || shouldShowErrorBanner) && (
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
                  serverName={item.label || item.name}
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
                    onClick={() => setIsLogsDialogOpen(true)}
                    className="text-primary hover:underline cursor-pointer"
                    data-testid={`${E2eTestId.McpLogsViewButton}-${item.name}`}
                  >
                    view the logs
                  </button>{" "}
                  or{" "}
                  <button
                    type="button"
                    onClick={onEdit}
                    className="text-primary hover:underline cursor-pointer"
                    data-testid={`${E2eTestId.McpLogsEditConfigButton}-${item.name}`}
                  >
                    edit your config
                  </button>
                  .
                </span>
              </div>
            ) : deploymentSummary ? (
              <div className="flex items-center justify-between px-3 py-2 text-sm h-10">
                <div className="flex items-center gap-2">
                  <DeploymentStatusDot state={deploymentSummary.overallState} />
                  <span className="text-muted-foreground">
                    {deploymentSummary.running} / {deploymentSummary.total}{" "}
                    deployments{" "}
                    {getDeploymentLabel(
                      deploymentSummary.overallState,
                    ).toLowerCase()}
                  </span>
                </div>
                {isLogsAvailable && (
                  <Button
                    onClick={() => setIsLogsDialogOpen(true)}
                    size="sm"
                    variant="link"
                    className="h-7 text-xs"
                  >
                    Debug
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        )}
        {isBuiltinVariant
          ? builtinCardContent
          : isPlaywrightVariant
            ? playwrightCardContent
            : isRemoteVariant
              ? remoteCardContent
              : localCardContent}
      </CardContent>
      {dialogs}
    </Card>
  );
}
