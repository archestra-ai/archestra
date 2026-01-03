"use client";

import { E2eTestId, formatSecretStorageType } from "@shared";
import { format } from "date-fns";
import { Trash, User } from "lucide-react";
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

  // Use the first server for display purposes
  const firstServer = allServers?.[0];

  const deleteMcpServerMutation = useDeleteMcpServer();

  const handleRevoke = async (mcpServer: (typeof allServers)[number]) => {
    await deleteMcpServerMutation.mutateAsync({
      id: mcpServer.id,
      name: mcpServer.name,
    });
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
                    <TableHead>Owner</TableHead>
                    <TableHead>Secret Storage</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allServers?.map((mcpServer) => (
                    <TableRow
                      key={mcpServer.id}
                      data-testid={E2eTestId.CredentialRow}
                      data-server-id={mcpServer.id}
                    >
                      <TableCell className="font-medium">
                        <span data-testid={E2eTestId.CredentialOwner}>
                          {getCredentialOwnerName(mcpServer)}
                        </span>
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
