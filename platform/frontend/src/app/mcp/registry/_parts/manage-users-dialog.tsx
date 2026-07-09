"use client";

import {
  ADMIN_ROLE_NAME,
  DocsPage,
  E2eTestId,
  formatSecretStorageType,
  getDocsUrl,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { format } from "date-fns";
import {
  AlertTriangle,
  Info,
  KeyRound,
  Plus,
  RefreshCw,
  Trash,
  User,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import {
  setOAuthCatalogId,
  setOAuthMcpServerId,
  setOAuthReturnUrl,
  setOAuthState,
} from "@/lib/auth/oauth-session";
import {
  useInternalMcpCatalog,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { AddServiceAccountDialog } from "./add-service-account-dialog";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
import { type DeploymentState, DeploymentStatusDot } from "./deployment-status";
import { formatOAuthFailureDetail } from "./oauth-reauth-detail";
import { useCanReauthenticate } from "./use-can-reauthenticate";

interface ManageUsersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
  /** Called when user wants to add a personal connection. */
  onAddPersonalConnection?: () => void;
  /** Called when user wants to add a team connection for a specific team */
  onAddSharedConnection?: (teamId: string) => void;
  /** Called when user wants to add an organization-wide connection */
  onAddOrgConnection?: () => void;
  /** Deployment statuses keyed by server ID */
  deploymentStatuses?: Record<string, McpDeploymentStatusEntry>;
  /** Called when user clicks a pod name to open the debug dialog */
  onOpenPodLogs?: (serverId: string) => void;
}

export function ManageUsersDialog({
  isOpen,
  onClose,
  label,
  catalogId,
  onAddPersonalConnection,
  onAddSharedConnection,
  onAddOrgConnection,
  deploymentStatuses = {},
  onOpenPodLogs,
}: ManageUsersDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="max-w-5xl h-[85vh] flex flex-col overflow-y-auto"
        data-testid={E2eTestId.ManageCredentialsDialog}
      >
        <ManageUsersContent
          isActive={isOpen}
          onClose={onClose}
          label={label}
          catalogId={catalogId}
          onAddPersonalConnection={onAddPersonalConnection}
          onAddSharedConnection={onAddSharedConnection}
          onAddOrgConnection={onAddOrgConnection}
          deploymentStatuses={deploymentStatuses}
          onOpenPodLogs={onOpenPodLogs}
        />
      </DialogContent>
    </Dialog>
  );
}

interface ManageUsersContentProps {
  isActive: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
  onAddPersonalConnection?: () => void;
  onAddSharedConnection?: (teamId: string) => void;
  onAddOrgConnection?: () => void;
  deploymentStatuses?: Record<string, McpDeploymentStatusEntry>;
  onOpenPodLogs?: (serverId: string) => void;
  hideHeader?: boolean;
  bodyTestId?: string;
}

export function ManageUsersContent({
  isActive,
  onClose,
  label,
  catalogId,
  onAddPersonalConnection,
  onAddSharedConnection,
  onAddOrgConnection,
  deploymentStatuses = {},
  onOpenPodLogs,
  hideHeader = false,
  bodyTestId,
}: ManageUsersContentProps) {
  // Subscribe to live mcp-servers query to get fresh data. We fetch all
  // servers (no catalogId filter) and keep those installed from this catalog.
  const { data: allServersUnfiltered = [], isFetched: serversFetched } =
    useMcpServers();
  const { data: catalogItems } = useInternalMcpCatalog({});

  const allServers = allServersUnfiltered.filter(
    (s) => s.catalogId === catalogId,
  );

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  // Get user's teams and permissions for re-authentication checks
  const { data: userTeams } = useMyTeams();
  const { data: hasMcpServerCreatePermission } = useHasPermissions({
    mcpServerInstallation: ["create"],
  });
  const { data: hasMcpServerUpdatePermission } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const { data: hasMcpServerAdminPermission } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  const [serviceAccountDialogOpen, setServiceAccountDialogOpen] =
    useState(false);

  // Use the first server for display purposes
  const firstServer = allServers?.[0];

  // Find the catalog item to check if it supports OAuth
  const catalogItem = catalogItems?.find((item) => item.id === catalogId);
  const isOAuthServer = !!catalogItem?.oauthConfig;

  const getServerScope = (
    mcpServer: (typeof allServers)[number],
  ): "personal" | "team" | "org" => {
    return mcpServer.scope ?? (mcpServer.teamId ? "team" : "personal");
  };

  const canReauthenticate = useCanReauthenticate();

  // Get tooltip message for disabled re-authenticate button
  const getReauthTooltip = (mcpServer: (typeof allServers)[number]): string => {
    if (!hasMcpServerCreatePermission) {
      return "You need MCP server create permission to re-authenticate";
    }
    const scope = getServerScope(mcpServer);
    if (scope === "org") {
      return "Only an organization admin can re-authenticate an organization connection";
    }
    if (scope === "personal") {
      return "Only the connection owner can re-authenticate";
    }
    // WHY: Different messages for different failure reasons
    if (!hasMcpServerUpdatePermission) {
      return "You don't have permission to re-authenticate team connections";
    }
    return "You can only re-authenticate connections for teams you are a member of";
  };

  // Check if user can revoke (delete) a credential
  // Personal: owner OR mcpServer:update. Team: team admin role OR (mcpServer:update AND membership).
  // Org: mcpServerInstallation:admin.
  const canRevoke = (mcpServer: (typeof allServers)[number]) => {
    const scope = getServerScope(mcpServer);
    if (scope === "org") return !!hasMcpServerAdminPermission;
    if (scope === "personal") {
      return (
        mcpServer.ownerId === currentUserId || !!hasMcpServerUpdatePermission
      );
    }
    if (isCurrentUserTeamAdmin(mcpServer.teamId)) return true;
    if (!hasMcpServerUpdatePermission) return false;
    return userTeams?.some((team) => team.id === mcpServer.teamId) ?? false;
  };

  const isCurrentUserTeamAdmin = (teamId: string | null | undefined) => {
    if (!teamId || !currentUserId) return false;
    const team = userTeams?.find((team) => team.id === teamId);
    return (
      team?.members?.some(
        (member) =>
          member.userId === currentUserId && member.role === ADMIN_ROLE_NAME,
      ) ?? false
    );
  };

  // Get tooltip message for disabled revoke button
  const getRevokeTooltip = (mcpServer: (typeof allServers)[number]): string => {
    const scope = getServerScope(mcpServer);
    if (scope === "org") {
      return "Only an organization admin can revoke an organization connection";
    }
    if (scope === "personal") {
      return "Only the connection owner or an editor/admin can revoke";
    }
    if (!hasMcpServerUpdatePermission) {
      return "You don't have permission to revoke team connections";
    }
    return "You can only revoke connections for teams you are a member of";
  };

  const deleteMcpServerMutation = useDeleteMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();

  const handleRevoke = async (mcpServer: (typeof allServers)[number]) => {
    await deleteMcpServerMutation.mutateAsync({
      id: mcpServer.id,
      name: mcpServer.name,
    });
  };

  const handleReauthenticate = async (
    mcpServer: (typeof allServers)[number],
  ) => {
    if (!catalogItem) {
      toast.error("Catalog item not found");
      return;
    }

    try {
      // Store the MCP server ID in session storage for re-authentication flow
      setOAuthMcpServerId(mcpServer.id);

      // Call backend to initiate OAuth flow
      const { authorizationUrl, state } =
        await initiateOAuthMutation.mutateAsync({
          catalogId: catalogItem.id,
        });

      // Store state in session storage for the callback
      setOAuthState(state);
      setOAuthCatalogId(catalogItem.id);

      // Remember where re-authentication started so the callback returns here
      setOAuthReturnUrl(window.location.href);

      // Redirect to OAuth provider
      window.location.href = authorizationUrl;
    } catch (error) {
      setOAuthMcpServerId(null);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to initiate re-authentication",
      );
    }
  };

  // Close dialog when all credentials are revoked (only after data has loaded),
  // but keep it open if add callbacks are available.
  const hasAddCallbacks =
    !!onAddPersonalConnection ||
    !!onAddSharedConnection ||
    !!onAddOrgConnection;
  useEffect(() => {
    if (isActive && serversFetched && !firstServer && !hasAddCallbacks) {
      onClose();
    }
  }, [isActive, serversFetched, firstServer, onClose, hasAddCallbacks]);

  if (!firstServer && !hasAddCallbacks) {
    return null;
  }

  type Server = (typeof allServers)[number];
  function splitByScope(servers: Server[]) {
    const teamServers = servers.filter(
      (s) => getServerScope(s) === "team" && !!s.teamId,
    );
    const orgServers = servers.filter((s) => getServerScope(s) === "org");
    const teamsWithConnection = new Set(teamServers.map((s) => s.teamId));
    const myPersonalServer =
      servers.find(
        (s) => getServerScope(s) === "personal" && s.ownerId === currentUserId,
      ) ?? null;
    const otherPersonalServers = servers.filter(
      (s) => getServerScope(s) === "personal" && s.ownerId !== currentUserId,
    );
    const availableTeamsForShared =
      userTeams?.filter((t) => !teamsWithConnection.has(t.id)) ?? [];
    const hasOrgConnection = orgServers.length > 0;
    return {
      teamServers,
      orgServers,
      myPersonalServer,
      otherPersonalServers,
      availableTeamsForShared,
      hasOrgConnection,
    };
  }

  const getCredentialOwnerName = (mcpServer: Server): string => {
    const scope = getServerScope(mcpServer);
    if (scope === "org") return "Organization";
    if (scope === "team") return mcpServer.teamDetails?.name || "Team";
    return mcpServer.ownerEmail || "Deleted user";
  };

  const split = splitByScope(allServers);
  const canonicalStateByPod = computeCanonicalStateByPod(
    allServers,
    deploymentStatuses,
  );

  const personalRows: ConnectionRow[] = [
    ...(split.myPersonalServer
      ? [{ server: split.myPersonalServer, isYou: true } as const]
      : []),
    ...split.otherPersonalServers.map((s) => ({ server: s, isYou: false })),
  ];
  const serviceAccountRows: ConnectionRow[] = [
    ...split.teamServers.map((s) => ({ server: s, isYou: false })),
    ...split.orgServers.map((s) => ({ server: s, isYou: false })),
  ];

  const canAddPersonal =
    hasAddCallbacks && !!onAddPersonalConnection && !split.myPersonalServer;
  const canAddTeam =
    hasAddCallbacks &&
    !!onAddSharedConnection &&
    split.availableTeamsForShared.length > 0;
  const canAddOrg =
    hasAddCallbacks &&
    !!onAddOrgConnection &&
    !split.hasOrgConnection &&
    !!hasMcpServerAdminPermission;
  const canAddServiceAccount = canAddTeam || canAddOrg;

  const rowProps: RowRenderProps = {
    isOAuthServer,
    deploymentStatuses,
    canonicalStateByPod,
    getCredentialOwnerName,
    canReauthenticate,
    getReauthTooltip,
    canRevoke,
    getRevokeTooltip,
    handleReauthenticate,
    handleRevoke,
    isDeleting: deleteMcpServerMutation.isPending,
    onOpenPodLogs,
  };

  return (
    <>
      {!hideHeader && (
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Connections
            <span className="text-muted-foreground font-normal">
              {label || firstServer?.name}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">Connections</DialogDescription>
        </DialogHeader>
      )}

      <div
        className={hideHeader ? "space-y-6" : "space-y-6 pb-4"}
        data-testid={bodyTestId}
      >
        {catalogItem && (
          <AgentConnectionsSection
            item={catalogItem}
            connections={allServers}
          />
        )}

        {(personalRows.length > 0 || canAddPersonal) && (
          <ConnectionsSection
            title="Personal connections"
            description="Each person connects their own account."
            emptyText="No personal connections yet."
            rows={personalRows}
            tableTestId={E2eTestId.ManageCredentialsDialogTable}
            action={
              canAddPersonal ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    onClose();
                    onAddPersonalConnection?.();
                  }}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Connect my account
                </Button>
              ) : null
            }
            {...rowProps}
          />
        )}

        {(serviceAccountRows.length > 0 || canAddServiceAccount) && (
          <ConnectionsSection
            title="Service accounts"
            description="Shared team & organization keys."
            emptyText="No service accounts yet."
            rows={serviceAccountRows}
            tableTestId={E2eTestId.ManageServiceAccountsTable}
            action={
              canAddServiceAccount ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  data-testid={
                    E2eTestId.ManageCredentialsAddServiceAccountButton
                  }
                  onClick={() => setServiceAccountDialogOpen(true)}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Add service account
                </Button>
              ) : null
            }
            {...rowProps}
          />
        )}
      </div>

      <AddServiceAccountDialog
        open={serviceAccountDialogOpen}
        onOpenChange={setServiceAccountDialogOpen}
        availableTeams={canAddTeam ? split.availableTeamsForShared : []}
        canAddOrg={canAddOrg}
        onConfirm={(target) => {
          onClose();
          if (target.type === "org") {
            onAddOrgConnection?.();
          } else {
            onAddSharedConnection?.(target.teamId);
          }
        }}
      />

      {!hideHeader && (
        <DialogStickyFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogStickyFooter>
      )}
    </>
  );
}

type ServerEntry = NonNullable<
  ReturnType<typeof useMcpServers>["data"]
>[number];

type ConnectionRow = { server: ServerEntry; isYou: boolean };

interface RowRenderProps {
  isOAuthServer: boolean;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  canonicalStateByPod: Map<string, string>;
  getCredentialOwnerName: (s: ServerEntry) => string;
  canReauthenticate: (s: ServerEntry) => boolean;
  getReauthTooltip: (s: ServerEntry) => string;
  canRevoke: (s: ServerEntry) => boolean;
  getRevokeTooltip: (s: ServerEntry) => string;
  handleReauthenticate: (s: ServerEntry) => void;
  handleRevoke: (s: ServerEntry) => void;
  isDeleting: boolean;
  onOpenPodLogs?: (serverId: string) => void;
}

function ConnectionsSection({
  title,
  description,
  action,
  rows,
  emptyText,
  tableTestId,
  ...rowProps
}: {
  title: string;
  description: string;
  action: React.ReactNode;
  rows: ConnectionRow[];
  emptyText: string;
  tableTestId: string;
} & RowRenderProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h4 className="text-sm font-medium">{title}</h4>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      <div className="overflow-hidden rounded-lg border">
        {rows.length > 0 ? (
          <ConnectionsTable rows={rows} testId={tableTestId} {...rowProps} />
        ) : (
          <p className="text-sm text-muted-foreground px-4 py-3">{emptyText}</p>
        )}
      </div>
    </div>
  );
}

function ConnectionsTable({
  rows,
  testId,
  isOAuthServer,
  deploymentStatuses,
  canonicalStateByPod,
  getCredentialOwnerName,
  canReauthenticate,
  getReauthTooltip,
  canRevoke,
  getRevokeTooltip,
  handleReauthenticate,
  handleRevoke,
  isDeleting,
  onOpenPodLogs,
}: {
  rows: ConnectionRow[];
  testId: string;
} & RowRenderProps) {
  const hasDeploymentStatuses = rows.some(
    (r) => deploymentStatuses[r.server.id],
  );

  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead className="whitespace-nowrap">Owner</TableHead>
          {hasDeploymentStatuses && (
            <TableHead className="whitespace-nowrap">Pod</TableHead>
          )}
          <TableHead className="whitespace-nowrap">Secret Storage</TableHead>
          <TableHead className="whitespace-nowrap">Created At</TableHead>
          <TableHead className="whitespace-nowrap">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ server, isYou }) => (
          <TableRow
            key={server.id}
            data-testid={E2eTestId.CredentialRow}
            data-server-id={server.id}
          >
            <TableCell className="font-medium max-w-[220px]">
              <div className="flex items-center gap-2">
                {isOAuthServer && server.oauthRefreshError && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent>Needs re-authentication</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <span
                  className="truncate"
                  data-testid={E2eTestId.CredentialOwner}
                >
                  {getCredentialOwnerName(server)}
                </span>
                {isYou && (
                  <Badge variant="secondary" className="text-[10px]">
                    You
                  </Badge>
                )}
              </div>
              {(server.teamId || server.scope === "org") && (
                <span className="text-muted-foreground text-xs block">
                  Created by: {server.ownerEmail}
                </span>
              )}
            </TableCell>
            {hasDeploymentStatuses && (
              <TableCell className="max-w-[260px]">
                {(() => {
                  const status = deploymentStatuses[server.id];
                  if (!status) {
                    return <span className="text-muted-foreground">—</span>;
                  }
                  const podName = status.podName;
                  const effectiveState =
                    (podName && canonicalStateByPod.get(podName)) ||
                    status.state;
                  const dot = (
                    <DeploymentStatusDot
                      state={
                        (effectiveState === "not_created" ||
                        effectiveState === "succeeded"
                          ? "running"
                          : effectiveState) as DeploymentState
                      }
                    />
                  );
                  if (!podName) {
                    return (
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
                        {dot}
                        <span>Pod not reported yet</span>
                      </div>
                    );
                  }
                  return (
                    <button
                      type="button"
                      onClick={() => onOpenPodLogs?.(server.id)}
                      className="flex w-full items-center gap-1.5 text-sm hover:underline cursor-pointer font-mono min-w-0"
                    >
                      {dot}
                      <span className="truncate min-w-0 flex-1 text-left">
                        {podName}
                      </span>
                    </button>
                  );
                })()}
              </TableCell>
            )}
            <TableCell className="text-muted-foreground">
              {formatSecretStorageType(server.secretStorageType)}
            </TableCell>
            <TableCell
              className="whitespace-nowrap text-muted-foreground"
              title={format(new Date(server.createdAt), "PPpp")}
            >
              {format(new Date(server.createdAt), "PP")}
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                {isOAuthServer && server.oauthRefreshError && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="w-full">
                          <Button
                            onClick={() => handleReauthenticate(server)}
                            disabled={!canReauthenticate(server)}
                            size="sm"
                            variant="outline"
                            className="h-7 w-full text-xs"
                          >
                            <RefreshCw className="mr-1 h-3 w-3" />
                            Re-authenticate
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {!canReauthenticate(server) && (
                        <TooltipContent>
                          {getReauthTooltip(server)}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                )}
                {isOAuthServer && server.oauthRefreshError && (
                  <div
                    className="mb-2 flex items-start gap-1 text-[11px] leading-tight text-destructive"
                    data-testid="oauth-reauth-detail"
                  >
                    <p className="min-w-0 break-words">
                      {formatOAuthFailureDetail(
                        server.oauthRefreshErrorMessage,
                        server.oauthRefreshFailedAt,
                      )}
                    </p>
                    {server.oauthRefreshErrorDescription && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="h-4 w-4 shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label="Show OAuth error details"
                            data-testid="oauth-reauth-detail-info"
                          >
                            <Info className="h-3 w-3" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          className="w-80 whitespace-pre-wrap break-words text-xs"
                        >
                          {server.oauthRefreshErrorDescription}
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                )}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="w-full">
                        <Button
                          onClick={() => handleRevoke(server)}
                          disabled={isDeleting || !canRevoke(server)}
                          size="sm"
                          variant="outline"
                          className="h-7 w-full text-xs"
                          data-testid={
                            isYou
                              ? `${E2eTestId.RevokeCredentialButton}-personal`
                              : `${E2eTestId.RevokeCredentialButton}-${getCredentialOwnerName(server)}`
                          }
                        >
                          <Trash className="mr-1 h-3 w-3" />
                          Revoke
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!canRevoke(server) && (
                      <TooltipContent>
                        {getRevokeTooltip(server)}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Multi-tenant catalogs alias one pod across N caller rows. Each row's
// K8sDeployment instance tracks its own state independently, so the row that
// didn't observe the pod first stays "pending" while the other goes "failed".
// Pick a canonical state per podName (across every connection for the catalog,
// so the personal and service-account tables agree) so all rows match.
const DEPLOYMENT_STATE_PRIORITY: Record<string, number> = {
  failed: 4,
  running: 3,
  succeeded: 3,
  pending: 2,
  not_created: 1,
};

function computeCanonicalStateByPod(
  servers: ServerEntry[],
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>,
): Map<string, string> {
  const canonicalStateByPod = new Map<string, string>();
  for (const server of servers) {
    const entry = deploymentStatuses[server.id];
    if (!entry?.podName) continue;
    const current = canonicalStateByPod.get(entry.podName);
    if (
      !current ||
      (DEPLOYMENT_STATE_PRIORITY[entry.state] ?? 0) >
        (DEPLOYMENT_STATE_PRIORITY[current] ?? 0)
    ) {
      canonicalStateByPod.set(entry.podName, entry.state);
    }
  }
  return canonicalStateByPod;
}

// The catalog-level "default credential" setting as a standard settings row:
// title, a plain-language description that names the current choice, and a
// dedicated select whose options are self-explanatory. It governs every tool
// assignment that resolves credentials at call time — Auto mode always, and
// Custom-mode assignments unless a specific connection is pinned on the
// assignment itself. NULL (default) = agents act on behalf of whoever is
// calling, using that person's own connection; an mcp_servers.id = agents
// always use that one connection. Saves on change; gated by the same
// authorization as editing the catalog item.
const ON_BEHALF_OF_VALUE = "__on_behalf_of__";

function AgentConnectionsSection({
  item,
  connections,
}: {
  item: NonNullable<Parameters<typeof useCanModifyCatalogItem>[0]>;
  connections: NonNullable<ReturnType<typeof useMcpServers>["data"]>;
}) {
  const { canModify } = useCanModifyCatalogItem(item);
  const updateMutation = useUpdateInternalMcpCatalogItem();
  const pinnedId = item.dynamicConnectionMcpServerId ?? null;
  const pinnedConnection = pinnedId
    ? connections.find((connection) => connection.id === pinnedId)
    : undefined;
  const pinRemoved = Boolean(pinnedId) && !pinnedConnection;

  const connectionLabel = (connection: (typeof connections)[number]) => {
    const scope = connection.scope ?? (connection.teamId ? "team" : "personal");
    if (scope === "org") return "Organization account";
    if (scope === "team")
      return `Team — ${connection.teamDetails?.name ?? "Unknown team"}`;
    return connection.ownerEmail ?? "Unknown user";
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="max-w-xl space-y-1">
        <h4 className="text-sm font-medium">Default credential</h4>
        <p className="text-sm text-muted-foreground">
          {!pinnedId ? (
            <>
              Agents connect on behalf of whoever is calling — each person uses
              their own connection if they have one, otherwise a team or
              organization connection they can access. Applies in Auto mode and
              to Custom tool assignments that resolve at call time.
            </>
          ) : pinRemoved ? (
            <>
              The selected connection was removed. Agents connect on behalf of
              whoever is calling until you choose another one.
            </>
          ) : (
            <>
              Agents connect as{" "}
              <span className="font-medium text-foreground">
                {pinnedConnection ? connectionLabel(pinnedConnection) : ""}
              </span>
              , no matter who is calling. Applies in Auto mode and to Custom
              tool assignments that resolve at call time.
            </>
          )}{" "}
          <ExternalDocsLink
            href={getDocsUrl(
              DocsPage.McpAuthentication,
              "resolve-at-call-time",
            )}
            className="underline"
            showIcon={false}
          >
            Learn more
          </ExternalDocsLink>
        </p>
      </div>
      <Select
        value={pinRemoved ? "" : (pinnedId ?? ON_BEHALF_OF_VALUE)}
        disabled={!canModify || updateMutation.isPending}
        onValueChange={(value) =>
          updateMutation.mutate({
            id: item.id,
            data: {
              dynamicConnectionMcpServerId:
                value === ON_BEHALF_OF_VALUE ? null : value,
            },
          })
        }
      >
        <SelectTrigger className="w-[260px]">
          <SelectValue placeholder="Connection removed" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value={ON_BEHALF_OF_VALUE}
            className="cursor-pointer"
            description="Everyone connects their own account."
          >
            <div className="flex items-center gap-1.5">
              <Zap className="h-3.5! w-3.5! text-amber-500" />
              <span>On behalf of the user</span>
            </div>
          </SelectItem>
          {connections.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
                Always use one account
              </div>
              {connections.map((connection) => (
                <SelectItem
                  key={connection.id}
                  value={connection.id}
                  className="cursor-pointer"
                >
                  <div className="flex items-center gap-1.5">
                    <KeyRound className="h-3.5! w-3.5! text-muted-foreground" />
                    <span>{connectionLabel(connection)}</span>
                  </div>
                </SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
