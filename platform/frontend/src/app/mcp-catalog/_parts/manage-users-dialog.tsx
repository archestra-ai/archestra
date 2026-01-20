"use client";

import { E2eTestId, formatSecretStorageType } from "@shared";
import { format } from "date-fns";
import { AlertTriangle, RefreshCw, Trash, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useInternalMcpCatalogSuspense } from "@/lib/internal-mcp-catalog.query";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp-server.query";

interface ManageUsersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
}

export function ManageUsersDialog({
  isOpen,
  onClose,
  label,
  catalogId,
}: ManageUsersDialogProps) {
  // Subscribe to live mcp-servers query to get fresh data
  const { data: allServers } = useMcpServers({ catalogId });
  const { data: catalogItems } = useInternalMcpCatalogSuspense({});
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  // Use the first server for display purposes
  const firstServer = allServers?.[0];

  // Find the catalog item to check if it supports OAuth
  const catalogItem = catalogItems?.find((item) => item.id === catalogId);
  const isOAuthServer = !!catalogItem?.oauthConfig;

  // Check if user has permission to update MCP servers (required for re-authentication)
  const { data: hasUpdatePermission } = useHasPermissions({
    mcpServer: ["update"],
  });

  // Check if user can re-authenticate a credential
  // For personal credentials (no teamId), only the owner can re-authenticate
  // For team credentials, user needs mcpServer update permission
  const canReauthenticate = (mcpServer: (typeof allServers)[number]) =>
    mcpServer.teamId
      ? hasUpdatePermission
      : mcpServer.ownerId === currentUserId;

  const deleteMcpServerMutation = useDeleteMcpServer();

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
      sessionStorage.setItem("oauth_mcp_server_id", mcpServer.id);

      // Call backend to initiate OAuth flow
      const response = await fetch("/api/oauth/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          catalogId: catalogItem.id,
        }),
      });

      if (!response.ok) {
        sessionStorage.removeItem("oauth_mcp_server_id");
        throw new Error("Failed to initiate OAuth flow");
      }

      const { authorizationUrl, state } = await response.json();

      // Store state in session storage for the callback
      sessionStorage.setItem("oauth_state", state);
      sessionStorage.setItem("oauth_catalog_id", catalogItem.id);

      // Redirect to OAuth provider
      window.location.href = authorizationUrl;
    } catch {
      sessionStorage.removeItem("oauth_mcp_server_id");
      toast.error("Failed to initiate re-authentication");
    }
  };

  if (!firstServer) {
    return null;
  }

  const getCredentialOwnerName = (
    mcpServer: (typeof allServers)[number],
  ): string =>
    mcpServer.teamId
      ? mcpServer.teamDetails?.name || "Team"
      : mcpServer.ownerEmail || "Unknown";

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-[700px]"
        data-testid={E2eTestId.ManageCredentialsDialog}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Manage credentials
            <span className="text-muted-foreground font-normal">
              {label || firstServer.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            Manage credentials for this MCP Registry item.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {allServers?.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No credentials available for this server.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table data-testid={E2eTestId.ManageCredentialsDialogTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[200px]">Owner</TableHead>
                    <TableHead>Secret Storage</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allServers?.map((mcpServer) => (
                    <TableRow
                      key={mcpServer.id}
                      data-testid={E2eTestId.CredentialRow}
                      data-server-id={mcpServer.id}
                    >
                      <TableCell className="font-medium max-w-[200px]">
                        <div className="flex items-center gap-2">
                          {isOAuthServer &&
                            mcpServer.oauthRefreshError &&
                            canReauthenticate(mcpServer) && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger>
                                    <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Authentication failed. Please
                                    re-authenticate.
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          <span
                            className="truncate"
                            data-testid={E2eTestId.CredentialOwner}
                          >
                            {getCredentialOwnerName(mcpServer)}
                          </span>
                        </div>
                        {mcpServer.teamId && (
                          <span className="text-muted-foreground text-xs block">
                            Created by: {mcpServer.ownerEmail}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatSecretStorageType(mcpServer.secretStorageType)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(mcpServer.createdAt), "PPp")}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {isOAuthServer &&
                            mcpServer.oauthRefreshError &&
                            canReauthenticate(mcpServer) && (
                              <Button
                                onClick={() => handleReauthenticate(mcpServer)}
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                              >
                                <RefreshCw className="mr-1 h-3 w-3" />
                                Re-authenticate
                              </Button>
                            )}
                          <Button
                            onClick={() => handleRevoke(mcpServer)}
                            disabled={deleteMcpServerMutation.isPending}
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            data-testid={`${E2eTestId.RevokeCredentialButton}-${getCredentialOwnerName(mcpServer)}`}
                          >
                            <Trash className="mr-1 h-3 w-3" />
                            Revoke
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
