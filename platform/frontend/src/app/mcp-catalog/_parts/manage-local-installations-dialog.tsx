"use client";

import { type archestraApiTypes, E2eTestId } from "@shared";
import { format } from "date-fns";
import { Info, Server, Trash, X } from "lucide-react";
import { useCallback, useMemo } from "react";
import { WithoutPermissions } from "@/components/roles/with-permissions";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useGrantTeamMcpServerAccess,
  useMcpServers,
  useRevokeTeamMcpServerAccess,
  useRevokeUserMcpServerAccess,
} from "@/lib/mcp-server.query";
import { useTeams } from "@/lib/team.query";

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
  const { data: allTeams } = useTeams();

  type UserWithTeams = {
    userId: string;
    email: string;
    createdAt: string;
    serverId: string;
    teams: Array<{ teamId: string; name: string; createdAt: string }>;
  };

  // Find all local servers with the same catalogId and aggregate their user details
  const userInstallations = useMemo((): UserWithTeams[] => {
    if (!server?.catalogId || !allServers) {
      // Transform base userDetails to include required fields
      return (server?.userDetails || []).map((ud) => ({
        ...ud,
        serverId: server?.id || "",
        teams: server?.teamDetails || [],
      }));
    }

    // Find all local servers with the same catalogId
    const localServers = allServers.filter(
      (s) => s.catalogId === server.catalogId && s.serverType === "local",
    );

    // Aggregate user details from all servers
    const aggregatedUserDetails: UserWithTeams[] = [];

    for (const srv of localServers) {
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

      // Use catalogId to find and delete the user's personal installation
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

      // Pass userId to grant access to the specific user's server/pod
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

  const getUnassignedTeamsForUser = (
    userTeams: Array<{ teamId: string; name: string; createdAt: string }>,
  ) => {
    const assignedTeamIds = new Set(userTeams.map((t) => t.teamId));
    return allTeams?.filter((team) => !assignedTeamIds.has(team.id)) || [];
  };

  // Get teams that a user belongs to (based on team membership)
  const getUserMembershipTeams = useCallback(
    (userId: string) => {
      if (!allTeams) return [];
      return allTeams.filter((team) =>
        team.members?.some((member) => member.userId === userId),
      );
    },
    [allTeams],
  );

  if (!liveServer) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-[900px]"
        data-testid={E2eTestId.LocalInstallationsDialog}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Local installations
            <WithoutPermissions permissions={{ profile: ["admin"] }}>
              {" "}
              of your team
            </WithoutPermissions>
            <span className="text-muted-foreground font-normal">
              {label || liveServer.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            Manage installations and team access for this local MCP server.
            Revoking access will uninstall the server and delete the pod.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {userInstallations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No users have installed this server yet.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table data-testid={E2eTestId.LocalInstallationsTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Owner</TableHead>
                    <TableHead>Installed on</TableHead>
                    <TableHead>
                      <div className="flex items-center gap-1">
                        Granted for teams
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>
                              Users without <code>profile:admin</code>{" "}
                              permission can only assign teams they belong to
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userInstallations.map((installation) => {
                    const unassignedTeams = getUnassignedTeamsForUser(
                      installation.teams,
                    );

                    return (
                      <TableRow
                        key={installation.userId}
                        data-testid={E2eTestId.CredentialRow}
                        data-user-email={installation.email}
                      >
                        <TableCell className="font-medium">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <span
                                data-testid={E2eTestId.CredentialOwnerEmail}
                              >
                                {installation.email}
                              </span>
                              {currentUserId === installation.userId && (
                                <Badge
                                  variant="secondary"
                                  className="text-[11px] px-1.5 py-1 h-4 bg-teal-600/20 text-teal-700 dark:bg-teal-400/20 dark:text-teal-400 border-teal-600/30 dark:border-teal-400/30"
                                >
                                  You
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {(() => {
                                const membershipTeams = getUserMembershipTeams(
                                  installation.userId,
                                );
                                if (membershipTeams.length === 0) {
                                  return (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] px-1 py-0 h-4 text-muted-foreground"
                                    >
                                      No team
                                    </Badge>
                                  );
                                }
                                return membershipTeams.map((team) => (
                                  <Badge
                                    key={team.id}
                                    variant="outline"
                                    className="text-[12px] px-2 py-2 h-4"
                                  >
                                    {team.name}
                                  </Badge>
                                ));
                              })()}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(installation.createdAt), "PPp")}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {installation.teams.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1">
                                {installation.teams.map((team) => (
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
                                          installation.serverId,
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
                                  handleGrantTeamAccess(
                                    installation.userId,
                                    teamId,
                                  )
                                }
                                disabled={grantTeamAccessMutation.isPending}
                              >
                                <SelectTrigger
                                  className="h-6 w-[130px] text-xs"
                                  data-testid={E2eTestId.CredentialTeamSelect}
                                >
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
                            {installation.teams.length === 0 &&
                              unassignedTeams.length === 0 && (
                                <span className="text-xs text-muted-foreground">
                                  No teams available
                                </span>
                              )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            onClick={() => handleRevoke(installation.userId)}
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
