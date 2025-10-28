"use client";

import type { archestraApiTypes } from "@shared";
import { format } from "date-fns";
import { Trash, User } from "lucide-react";
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
import { useRevokeUserMcpServerAccess } from "@/lib/mcp-server.query";

interface ManageUsersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  server:
    | archestraApiTypes.GetMcpServersResponses["200"][number]
    | null
    | undefined;
  label?: string;
}

export function ManageUsersDialog({
  isOpen,
  onClose,
  server,
  label,
}: ManageUsersDialogProps) {
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;

  const userDetails = useMemo(() => {
    return server?.userDetails || [];
  }, [server]);

  const revokeAccessMutation = useRevokeUserMcpServerAccess();

  const handleRevoke = useCallback(
    async (userId: string) => {
      if (!server) return;

      await revokeAccessMutation.mutateAsync({
        serverId: server.id,
        userId,
      });
      onClose();
    },
    [server, revokeAccessMutation, onClose],
  );

  if (!server) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Personal Credentials
            <span className="text-muted-foreground font-normal">
              {label || server.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            Manage personal authentication for users who have authenticated to
            this MCP server.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {userDetails.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No users have authenticated to this server yet.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Authenticated</TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userDetails.map((user) => (
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
