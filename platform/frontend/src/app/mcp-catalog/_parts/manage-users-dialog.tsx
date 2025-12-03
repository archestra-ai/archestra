"use client";

import type { archestraApiTypes } from "@shared";
import { format } from "date-fns";
import { Trash, User, X } from "lucide-react";
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
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useGrantTeamMcpServerAccess,
  useMcpServers,
  useRevokeTeamMcpServerAccess,
  useRevokeUserMcpServerAccess,
} from "@/lib/mcp-server.query";
import { useTeams } from "@/lib/team.query";

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

  // Subscribe to live mcp-servers query to get fresh data
  const { data: allServers } = useMcpServers();
  const { data: allTeams } = useTeams();

  // Find all servers with the same catalogId
  const serversForCatalog = useMemo(() => {
    if (!server?.catalogId || !allServers) return [];
    return allServers.filter((s) => s.catalogId === server.catalogId);
  }, [allServers, server?.catalogId]);

  type UserWithTeams = {
    userId: string;
    email: string;
    createdAt: string;
    serverId: string;
    teams: Array<{ teamId: string; name: string; createdAt: string }>;
  };

  // Aggregate user details with their associated server info
  const userDetails = useMemo((): UserWithTeams[] => {
    if (!server?.catalogId || !allServers) {
      // Transform base userDetails to include required fields
      return (server?.userDetails || []).map((ud) => ({
        ...ud,
        serverId: server?.id || "",
        teams: server?.teamDetails || [],
      }));
    }

    // Aggregate user details from all servers
    const aggregatedUserDetails: UserWithTeams[] = [];

    for (const srv of serversForCatalog) {
      if (srv.userDetails) {
        for (const userDetail of srv.userDetails) {
          // Only add if not already present
          if (
            !aggregatedUserDetails.some((ud) => ud.userId === userDetail.userId)
          ) {
            // Get teams assigned to this user's server
            const teamsForServer = srv.teamDetails || [];
            aggregatedUserDetails.push({
              ...userDetail,
              serverId: srv.id,
              teams: teamsForServer,
            });
          }
        }
      }
    }

    return aggregatedUserDetails;
  }, [
    allServers,
    server?.catalogId,
    server?.userDetails,
    server?.id,
    server?.teamDetails,
    serversForCatalog,
  ]);

  // Use the first server for operations that need a server ID
  const liveServer = useMemo(() => {
    if (!server?.catalogId || !allServers) return server;
    return allServers.find((s) => s.catalogId === server.catalogId) || server;
  }, [allServers, server]);

  const revokeAccessMutation = useRevokeUserMcpServerAccess();
  const grantTeamAccessMutation = useGrantTeamMcpServerAccess();
  const revokeTeamAccessMutation = useRevokeTeamMcpServerAccess();

  const handleRevoke = useCallback(
    async (userId: string) => {
      if (!liveServer?.catalogId) return;

      // Use catalogId to find and delete the user's server
      await revokeAccessMutation.mutateAsync({
        catalogId: liveServer.catalogId,
        userId,
      });
    },
    [liveServer, revokeAccessMutation],
  );

  const handleGrantTeamAccess = useCallback(
    (userId: string, teamId: string) => {
      if (!liveServer?.catalogId) return;

      grantTeamAccessMutation.mutate({
        catalogId: liveServer.catalogId,
        teamIds: [teamId],
        userId,
      });
    },
    [liveServer, grantTeamAccessMutation],
  );

  const handleRevokeTeamAccess = useCallback(
    async (serverId: string, teamId: string) => {
      await revokeTeamAccessMutation.mutateAsync({
        serverId,
        teamId,
      });
    },
    [revokeTeamAccessMutation],
  );

  // Collect all team IDs assigned to any credential
  const allAssignedTeamIds = useMemo(() => {
    const teamIds = new Set<string>();
    for (const user of userDetails) {
      for (const team of user.teams) {
        teamIds.add(team.teamId);
      }
    }
    return teamIds;
  }, [userDetails]);

  const getUnassignedTeamsForUser = () => {
    // Filter out teams already assigned to any credential
    return allTeams?.filter((team) => !allAssignedTeamIds.has(team.id)) || [];
  };

  if (!liveServer) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Manage Credentials
            <span className="text-muted-foreground font-normal">
              {label || liveServer.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            Manage user credentials and team access for this MCP server. Add
            teams to share credentials with team members.
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
                    <TableHead>User</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Teams</TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userDetails.map((user) => {
                    const unassignedTeams = getUnassignedTeamsForUser();

                    return (
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
                          <div className="flex flex-col gap-1">
                            {user.teams.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1">
                                {user.teams.map((team) => (
                                  <Badge
                                    key={team.teamId}
                                    variant="secondary"
                                    className="flex items-center gap-1 pr-1 h-6"
                                  >
                                    <span>{team.name}</span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        handleRevokeTeamAccess(
                                          user.serverId,
                                          team.teamId,
                                        )
                                      }
                                      disabled={
                                        revokeTeamAccessMutation.isPending
                                      }
                                      className="h-auto p-0.5 ml-0.5 hover:bg-destructive/20"
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </Badge>
                                ))}
                              </div>
                            )}
                            {unassignedTeams.length > 0 && (
                              <Select
                                value=""
                                onValueChange={(teamId) =>
                                  handleGrantTeamAccess(user.userId, teamId)
                                }
                                disabled={grantTeamAccessMutation.isPending}
                              >
                                <SelectTrigger className="h-6 w-[130px] text-xs">
                                  <SelectValue placeholder="Add team..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {unassignedTeams.map((team) => (
                                    <SelectItem
                                      key={team.id}
                                      value={team.id}
                                      className="cursor-pointer"
                                    >
                                      {team.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            {user.teams.length === 0 &&
                              unassignedTeams.length === 0 && (
                                <span className="text-xs text-muted-foreground">
                                  No teams available
                                </span>
                              )}
                          </div>
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
                    );
                  })}
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
