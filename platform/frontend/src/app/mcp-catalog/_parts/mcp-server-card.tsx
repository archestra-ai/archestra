"use client";

import type { archestraApiTypes } from "@shared";
import {
  Building2,
  FileText,
  MoreVertical,
  Pencil,
  RefreshCw,
  Trash2,
  User,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { AssignAgentDialog } from "@/app/tools/_parts/assign-agent-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WithRole } from "@/components/with-permission";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useMcpServerLogs,
  useMcpServerTools,
  useRevokeAllTeamsMcpServerAccess,
  useRevokeUserMcpServerAccess,
} from "@/lib/mcp-server.query";
import { BulkAssignAgentDialog } from "./bulk-assign-agent-dialog";
import { ManageTeamsDialog } from "./manage-teams-dialog";
import { ManageUsersDialog } from "./manage-users-dialog";
import { McpLogsDialog } from "./mcp-logs-dialog";
import { McpToolsDialog } from "./mcp-tools-dialog";
import { TransportBadges } from "./transport-badges";
import { UninstallServerDialog } from "./uninstall-server-dialog";

export type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export type CatalogItemWithOptionalLabel = CatalogItem & {
  label?: string | null;
};

export type InstalledServer =
  archestraApiTypes.GetMcpServersResponses["200"][number];

type ToolForAssignment = {
  id: string;
  name: string;
  description: string | null;
  parameters: Record<string, unknown>;
  createdAt: string;
  mcpServerId: string | null;
  mcpServerName: string | null;
};

type SimpleTool = {
  id: string;
  name: string;
  description: string | null;
  parameters: Record<string, unknown>;
  createdAt: string;
};

export type McpServerCardProps = {
  item: CatalogItemWithOptionalLabel;
  installedServer?:
    | (InstalledServer & {
        currentUserHasTeamAuth?: boolean;
      })
    | null;
  installingItemId: string | null;
  installationStatus?:
    | "error"
    | "pending"
    | "success"
    | "idle"
    | "discovering-tools"
    | null;
  onInstall: () => void;
  onInstallTeam: () => void;
  onInstallNoAuth: () => void;
  onReinstall: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isAdmin: boolean;
};

export type McpServerCardVariant = "remote" | "local";

export type McpServerCardBaseProps = McpServerCardProps & {
  variant: McpServerCardVariant;
};

export function McpServerCard({
  variant,
  item,
  installedServer,
  installingItemId,
  installationStatus,
  onInstall,
  onInstallTeam,
  onInstallNoAuth,
  onReinstall,
  onEdit,
  onDelete,
  isAdmin,
}: McpServerCardBaseProps) {
  const { data: tools, isLoading: isLoadingTools } = useMcpServerTools(
    installedServer?.id ?? null,
  );
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;
  const revokeUserAccessMutation = useRevokeUserMcpServerAccess();
  const revokeAllTeamsMutation = useRevokeAllTeamsMcpServerAccess();

  // Dialog state
  const [isToolsDialogOpen, setIsToolsDialogOpen] = useState(false);
  const [isManageUsersDialogOpen, setIsManageUsersDialogOpen] = useState(false);
  const [isManageTeamsDialogOpen, setIsManageTeamsDialogOpen] = useState(false);
  const [isLogsDialogOpen, setIsLogsDialogOpen] = useState(false);
  const [selectedToolForAssignment, setSelectedToolForAssignment] =
    useState<ToolForAssignment | null>(null);
  const [bulkAssignTools, setBulkAssignTools] = useState<SimpleTool[]>([]);
  const [toolsDialogKey, setToolsDialogKey] = useState(0);
  const [uninstallingServer, setUninstallingServer] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Fetch logs when dialog is opened (only if server is installed and is local)
  const shouldFetchLogs =
    isLogsDialogOpen && installedServer?.id && variant === "local";
  const {
    data: logsData,
    isLoading: isLoadingLogs,
    error: logsError,
  } = useMcpServerLogs(shouldFetchLogs ? installedServer.id : null);

  const needsReinstall = installedServer?.reinstallRequired ?? false;
  const userCount = installedServer?.users?.length ?? 0;
  const teamsCount = installedServer?.teams?.length ?? 0;
  const toolsDiscoveredCount = tools?.length ?? 0;
  const toolsAssignedCount = !tools
    ? 0
    : tools.filter((tool) => tool.assignedAgentCount > 0).length;
  const installed = !!installedServer && toolsDiscoveredCount > 0;
  const isInstalling = Boolean(
    installingItemId === item.id ||
      installationStatus === "pending" ||
      (installationStatus === "discovering-tools" && installedServer),
  );

  const localInstalllingLabel =
    installationStatus === "discovering-tools"
      ? "Discovering tools..."
      : "Installing...";
  const isCurrentUserAuthenticated =
    currentUserId && installedServer?.users
      ? installedServer.users.includes(currentUserId)
      : false;
  const currentUserHasTeamAuth = installedServer?.currentUserHasTeamAuth;

  const isRemoteVariant = variant === "remote";

  const requiresAuth = !!(
    (item.userConfig && Object.keys(item.userConfig).length > 0) ||
    item.oauthConfig
  );

  const handleRevokeMyAccess = async () => {
    if (!currentUserId || !installedServer?.catalogId) return;
    await revokeUserAccessMutation.mutateAsync({
      catalogId: installedServer.catalogId,
      userId: currentUserId,
    });
  };

  const handleRevokeTeamAccess = async () => {
    if (!installedServer?.catalogId) return;
    await revokeAllTeamsMutation.mutateAsync({
      catalogId: installedServer.catalogId,
    });
  };

  // JSX parts
  const manageCatalogItemDropdownMenu = (
    <div className="flex flex-wrap gap-1 items-center flex-shrink-0 mt-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2"
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <DropdownMenuItem
                    onClick={() => setIsLogsDialogOpen(true)}
                    disabled={variant !== "local"}
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    Logs
                  </DropdownMenuItem>
                </div>
              </TooltipTrigger>
              {variant !== "local" && (
                <TooltipContent>
                  <p>Only available for local MCP servers</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  const usersAuthenticated = (
    <>
      <div className="flex items-center gap-2">
        <User className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          Users authenticated:{" "}
          <span className="font-medium text-foreground">{userCount}</span>
          {isCurrentUserAuthenticated && (
            <Badge
              variant="secondary"
              className="ml-2 text-[11px] px-1.5 py-1 h-4 bg-teal-600/20 text-teal-700 dark:bg-teal-400/20 dark:text-teal-400 border-teal-600/30 dark:border-teal-400/30"
            >
              You
            </Badge>
          )}
        </span>
      </div>
      {userCount > 0 && (
        <Button
          onClick={() => setIsManageUsersDialogOpen(true)}
          size="sm"
          variant="link"
          className="h-7 text-xs"
        >
          Manage
        </Button>
      )}
    </>
  );

  const teamsAccess = (
    <>
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          Teams with access:{" "}
          <span className="font-medium text-foreground">{teamsCount}</span>
        </span>
      </div>
      {teamsCount > 0 && (
        <Button
          onClick={() => setIsManageTeamsDialogOpen(true)}
          size="sm"
          variant="link"
          className="h-7 text-xs"
        >
          Manage
        </Button>
      )}
    </>
  );

  const toolsAssigned = (
    <>
      <div className="flex items-center gap-2">
        <Wrench className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          Tools assigned:{" "}
          <span className="font-medium text-foreground">
            {toolsAssignedCount}{" "}
            {toolsDiscoveredCount ? `(out of ${toolsDiscoveredCount})` : ""}
          </span>
        </span>
      </div>
      {toolsDiscoveredCount > 0 && (
        <Button
          onClick={() => setIsToolsDialogOpen(true)}
          size="sm"
          variant="link"
          className="h-7 text-xs"
        >
          Manage
        </Button>
      )}
    </>
  );

  const remoteCardContent = (
    <>
      <WithRole requiredExactRole="admin">
        <div className="bg-muted/50 rounded-md mb-2 overflow-hidden flex flex-col">
          {[
            { id: "1", content: usersAuthenticated },
            { id: "2", content: teamsAccess },
            { id: "3", content: toolsAssigned },
          ].map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between px-3 py-2 text-sm border-b border-muted h-10"
            >
              {item.content}
            </div>
          ))}
        </div>
      </WithRole>
      {needsReinstall && (
        <Button
          onClick={onReinstall}
          size="sm"
          variant="default"
          className="w-full"
          disabled={isInstalling}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {isInstalling ? "Reinstalling..." : "Reinstall Required"}
        </Button>
      )}
      {requiresAuth && !isCurrentUserAuthenticated && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={onInstall}
                disabled={isInstalling}
                size="sm"
                variant="outline"
                className="w-full"
              >
                <User className="mr-2 h-4 w-4" />
                {isInstalling ? "Adding..." : "Auth for myself"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Authenticate to create a token for my personal usage</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {isCurrentUserAuthenticated && (
        <Button
          onClick={handleRevokeMyAccess}
          size="sm"
          variant="outline"
          className="w-full bg-accent text-accent-foreground hover:bg-accent"
        >
          Revoke personal token
        </Button>
      )}
      <WithRole requiredExactRole="admin">
        {currentUserHasTeamAuth && (
          <Button
            onClick={handleRevokeTeamAccess}
            size="sm"
            variant="outline"
            className="w-full bg-accent text-accent-foreground hover:bg-accent"
          >
            Revoke teams token
          </Button>
        )}
      </WithRole>
      <WithRole requiredExactRole="admin">
        {requiresAuth && !currentUserHasTeamAuth && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onInstallTeam}
                  disabled={isInstalling}
                  size="sm"
                  variant="outline"
                  className="w-full"
                >
                  <Building2 className="mr-2 h-4 w-4" />
                  {isInstalling ? "Adding..." : "Auth for teams"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Authenticate and allow teams to use my token</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </WithRole>
    </>
  );

  const localCardContent = (
    <>
      <WithRole requiredExactRole="admin">
        <div className="bg-muted/50 rounded-md mb-2 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 text-sm border-b border-muted h-10">
            {toolsAssigned}
          </div>
        </div>
      </WithRole>
      {needsReinstall && (
        <Button
          onClick={onReinstall}
          size="sm"
          variant="default"
          className="w-full"
          disabled={isInstalling}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {isInstalling ? "Reinstalling..." : "Reinstall Required"}
        </Button>
      )}
      <WithRole requiredExactRole="member">
        {installed ? (
          <Button disabled size="sm" variant="outline" className="w-full">
            Installed
          </Button>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    disabled
                    size="sm"
                    variant="outline"
                    className="w-full"
                  >
                    Not installed
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>Only Admins can install MCP servers</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </WithRole>
      <WithRole requiredExactRole="admin">
        {installed ? (
          <Button
            onClick={() =>
              installedServer &&
              setUninstallingServer({
                id: installedServer.id,
                name: item.label || item.name,
              })
            }
            size="sm"
            variant="outline"
            className="w-full"
          >
            Uninstall
          </Button>
        ) : (
          <Button
            onClick={onInstallNoAuth}
            disabled={isInstalling}
            size="sm"
            variant="outline"
            className="w-full"
          >
            {isInstalling ? localInstalllingLabel : "Install"}
          </Button>
        )}
      </WithRole>
    </>
  );

  const dialogs = (
    <>
      <McpToolsDialog
        key={toolsDialogKey}
        open={isToolsDialogOpen}
        onOpenChange={(open) => {
          setIsToolsDialogOpen(open);
          if (!open) {
            setSelectedToolForAssignment(null);
          }
        }}
        serverName={installedServer?.name ?? ""}
        tools={tools ?? []}
        isLoading={isLoadingTools}
        onAssignTool={(tool) => {
          setSelectedToolForAssignment({
            ...tool,
            mcpServerId: installedServer?.id ?? null,
            mcpServerName: installedServer?.name ?? null,
          });
        }}
        onBulkAssignTools={(tools) => {
          setBulkAssignTools(tools);
        }}
      />

      {logsData && (
        <McpLogsDialog
          open={isLogsDialogOpen}
          onOpenChange={setIsLogsDialogOpen}
          serverName={installedServer?.name ?? item.name}
          logs={logsData.logs}
          command={logsData.command}
          isLoading={isLoadingLogs}
          error={logsError}
        />
      )}

      <BulkAssignAgentDialog
        tools={bulkAssignTools.length > 0 ? bulkAssignTools : null}
        open={bulkAssignTools.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setBulkAssignTools([]);
            // Reset the tools dialog to clear selections
            setToolsDialogKey((prev) => prev + 1);
          }
        }}
        catalogId={item.id}
      />

      <AssignAgentDialog
        tool={
          selectedToolForAssignment
            ? {
                id: selectedToolForAssignment.id,
                tool: {
                  id: selectedToolForAssignment.id,
                  name: selectedToolForAssignment.name,
                  description: selectedToolForAssignment.description,
                  parameters: selectedToolForAssignment.parameters,
                  createdAt: selectedToolForAssignment.createdAt,
                  updatedAt: selectedToolForAssignment.createdAt,
                  mcpServerId: selectedToolForAssignment.mcpServerId,
                  mcpServerName: selectedToolForAssignment.mcpServerName,
                },
                agent: null,
                createdAt: selectedToolForAssignment.createdAt,
                updatedAt: selectedToolForAssignment.createdAt,
              }
            : null
        }
        open={!!selectedToolForAssignment}
        onOpenChange={(open) => {
          if (!open) setSelectedToolForAssignment(null);
        }}
      />

      <ManageUsersDialog
        isOpen={isManageUsersDialogOpen}
        onClose={() => setIsManageUsersDialogOpen(false)}
        server={installedServer}
        label={item.label || item.name}
      />

      <ManageTeamsDialog
        isOpen={isManageTeamsDialogOpen}
        onClose={() => setIsManageTeamsDialogOpen(false)}
        server={installedServer}
        label={item.label || item.name}
      />

      <UninstallServerDialog
        server={uninstallingServer}
        onClose={() => setUninstallingServer(null)}
      />
    </>
  );

  return (
    <Card className="flex flex-col relative pt-4">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <CardTitle className="text-lg truncate mb-1 flex items-center">
              {item.name}
            </CardTitle>
            <div className="flex items-center gap-2">
              {item.oauthConfig && (
                <Badge variant="secondary" className="text-xs">
                  OAuth
                </Badge>
              )}
              <TransportBadges
                isRemote={isRemoteVariant}
                transportType={item.localConfig?.transportType}
              />
              {isRemoteVariant && !requiresAuth && (
                <Badge
                  variant="secondary"
                  className="text-xs bg-green-700 text-white"
                >
                  No auth required
                </Badge>
              )}
            </div>
          </div>
          {isAdmin && manageCatalogItemDropdownMenu}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isRemoteVariant ? remoteCardContent : localCardContent}
      </CardContent>
      {dialogs}
    </Card>
  );
}
