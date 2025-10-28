"use client";

import type { archestraApiTypes } from "@shared";
import { format } from "date-fns";
import { Building2, Trash } from "lucide-react";
import { useCallback, useMemo } from "react";
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
import { useRevokeTeamMcpServerAccess } from "@/lib/mcp-server.query";

interface ManageTeamsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  server:
    | archestraApiTypes.GetMcpServersResponses["200"][number]
    | null
    | undefined;
  label?: string;
}

export function ManageTeamsDialog({
  isOpen,
  onClose,
  server,
  label,
}: ManageTeamsDialogProps) {
  const teamDetails = useMemo(() => {
    return server?.teamDetails || [];
  }, [server]);

  const revokeAccessMutation = useRevokeTeamMcpServerAccess();

  const handleRevoke = useCallback(
    async (teamId: string) => {
      if (!server) return;

      await revokeAccessMutation.mutateAsync({
        serverId: server.id,
        teamId,
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
            <Building2 className="h-5 w-5" />
            Team Credentials
            <span className="text-muted-foreground font-normal">
              {label || server.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            View teams that have access to this MCP server.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {teamDetails.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No teams have been assigned to this server yet.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Team Name</TableHead>
                    <TableHead>Authenticated</TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teamDetails.map((team) => (
                    <TableRow key={team.teamId}>
                      <TableCell className="font-medium">{team.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(team.createdAt), "PPp")}
                      </TableCell>
                      <TableCell>
                        <Button
                          onClick={() => handleRevoke(team.teamId)}
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
