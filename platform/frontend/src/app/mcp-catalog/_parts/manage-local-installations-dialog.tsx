"use client";

import type { archestraApiTypes } from "@shared";
import { format } from "date-fns";
import { Server, Trash } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
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
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useMcpServers,
  useRevokeUserMcpServerAccess,
} from "@/lib/mcp-server.query";

interface ManageLocalInstallationsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  server:
    | archestraApiTypes.GetMcpServersResponses["200"][number]
    | null
    | undefined;
  label?: string;
}

export function ManageLocalInstallationsDialog({
  isOpen,
  onClose,
  server,
  label,
}: ManageLocalInstallationsDialogProps) {
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;

  // Subscribe to live mcp-servers query to get fresh data
  const { data: allServers } = useMcpServers();

  // Find all personal local servers with the same catalogId and aggregate their user details
  const userInstallations = useMemo(() => {
    if (!server?.catalogId || !allServers) return server?.userDetails || [];

    // Find all local personal servers with the same catalogId
    const localPersonalServers = allServers.filter(
      (s) =>
        s.catalogId === server.catalogId &&
        s.serverType === "local" &&
        s.authType === "personal",
    );

    // Aggregate user details from all personal servers
    const aggregatedUserDetails: Array<{
      userId: string;
      email: string;
      createdAt: string;
      serverId: string;
    }> = [];

    for (const srv of localPersonalServers) {
      if (srv.userDetails) {
        for (const userDetail of srv.userDetails) {
          // Only add if not already present
          if (
            !aggregatedUserDetails.some((ud) => ud.userId === userDetail.userId)
          ) {
            aggregatedUserDetails.push({
              ...userDetail,
              serverId: srv.id,
            });
          }
        }
      }
    }

    return aggregatedUserDetails;
  }, [allServers, server?.catalogId, server?.userDetails]);

  // Use the first server for operations that need a server ID
  const liveServer = useMemo(() => {
    if (!server?.catalogId || !allServers) return server;
    return allServers.find((s) => s.catalogId === server.catalogId) || server;
  }, [allServers, server]);

  const revokeAccessMutation = useRevokeUserMcpServerAccess();

  const handleRevoke = useCallback(
    async (userId: string) => {
      if (!liveServer?.catalogId) return;

      // Use catalogId to find and delete the user's personal installation
      await revokeAccessMutation.mutateAsync({
        catalogId: liveServer.catalogId,
        userId,
      });
    },
    [liveServer, revokeAccessMutation],
  );

  if (!liveServer) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Local installations
            <span className="text-muted-foreground font-normal">
              {label || liveServer.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            Manage personal installations for this local MCP server. Revoking
            access will uninstall the server and delete the pod.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {userInstallations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No users have installed this server yet.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Installed on</TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userInstallations.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {user.email}
                          {currentUserId === user.userId && (
                            <Badge
                              variant="secondary"
                              className="text-[11px] px-1.5 py-1 h-4 bg-teal-600/20 text-teal-700 dark:bg-teal-400/20 dark:text-teal-400 border-teal-600/30 dark:border-teal-400/30"
                            >
                              You
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(user.createdAt), "PPp")}
                      </TableCell>
                      <TableCell>
                        <Button
                          onClick={() => handleRevoke(user.userId)}
                          disabled={revokeAccessMutation.isPending}
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                        >
                          <Trash className="mr-1 h-3 w-3" />
                          Revoke
                        </Button>
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
