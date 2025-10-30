"use client";

import type { archestraApiTypes } from "@shared";
import { format } from "date-fns";
import { Building2, Trash, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
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
  useGrantTeamMcpServerAccess,
  useMcpServers,
  useRevokeTeamMcpServerAccess,
} from "@/lib/mcp-server.query";
import { useTeams } from "@/lib/team.query";

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
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [currentTeamId, setCurrentTeamId] = useState<string>("");
  const [selectedOwnerId, setSelectedOwnerId] = useState<string>("");

  // Subscribe to live mcp-servers query to get fresh data
  const { data: allServers } = useMcpServers();

  // Find all servers with the same catalogId and aggregate their team details
  const teamDetails: Array<{
    teamId: string;
    name: string;
    createdAt: string;
    serverId: string;
  }> = useMemo(() => {
    if (!server?.catalogId || !allServers) {
      // Fallback to server teamDetails if available, but add serverId
      if (server?.teamDetails && server?.id) {
        return server.teamDetails.map((td) => ({
          ...td,
          serverId: server.id,
        }));
      }
      return [];
    }

    // Find all servers with the same catalogId
    const serversForCatalog = allServers.filter(
      (s) => s.catalogId === server.catalogId,
    );

    // Aggregate team details from all servers
    const aggregatedTeamDetails: Array<{
      teamId: string;
      name: string;
      createdAt: string;
      serverId: string;
    }> = [];

    for (const srv of serversForCatalog) {
      if (srv.teamDetails) {
        for (const teamDetail of srv.teamDetails) {
          // Only add if not already present
          if (
            !aggregatedTeamDetails.some((td) => td.teamId === teamDetail.teamId)
          ) {
            aggregatedTeamDetails.push({
              ...teamDetail,
              serverId: srv.id,
            });
          }
        }
      }
    }

    return aggregatedTeamDetails;
  }, [allServers, server?.catalogId, server?.teamDetails, server?.id]);

  // Get all team-auth servers for this catalogId
  const teamAuthServers = useMemo(() => {
    if (!server?.catalogId || !allServers) return [];
    return allServers.filter(
      (s) => s.catalogId === server.catalogId && s.authType === "team",
    );
  }, [allServers, server]);

  const hasTeamAuthServer = teamAuthServers.length > 0;

  // Set initial selection when dialog opens
  useEffect(() => {
    if (isOpen && teamAuthServers.length > 0 && !selectedOwnerId) {
      setSelectedOwnerId(teamAuthServers[0].ownerId || "");
    }
  }, [isOpen, teamAuthServers, selectedOwnerId]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedTeamIds([]);
      setCurrentTeamId("");
      setSelectedOwnerId("");
    }
  }, [isOpen]);

  const { data: allTeams } = useTeams();
  const grantAccessMutation = useGrantTeamMcpServerAccess();
  const revokeAccessMutation = useRevokeTeamMcpServerAccess();

  // Get teams that are not already assigned
  const unassignedTeams = useMemo(() => {
    if (!allTeams) return [];
    const assignedTeamIds = new Set(teamDetails.map((t) => t.teamId));
    const selectedTeamIdsSet = new Set(selectedTeamIds);
    return allTeams.filter(
      (team) =>
        !assignedTeamIds.has(team.id) && !selectedTeamIdsSet.has(team.id),
    );
  }, [allTeams, teamDetails, selectedTeamIds]);

  const handleAddTeam = useCallback(
    (teamId: string) => {
      if (teamId && !selectedTeamIds.includes(teamId)) {
        setSelectedTeamIds([...selectedTeamIds, teamId]);
        setCurrentTeamId("");
      }
    },
    [selectedTeamIds],
  );

  const handleRemoveSelectedTeam = useCallback(
    (teamId: string) => {
      setSelectedTeamIds(selectedTeamIds.filter((id) => id !== teamId));
    },
    [selectedTeamIds],
  );

  const getTeamById = useCallback(
    (teamId: string) => {
      return allTeams?.find((team) => team.id === teamId);
    },
    [allTeams],
  );

  const getOwnerEmailByServerId = useCallback(
    (serverId: string) => {
      if (!allServers) return null;
      const server = allServers.find((s) => s.id === serverId);
      return server?.ownerEmail || null;
    },
    [allServers],
  );

  const handleGrantAccess = useCallback(async () => {
    if (!server?.catalogId || selectedTeamIds.length === 0) return;

    await grantAccessMutation.mutateAsync({
      catalogId: server.catalogId,
      teamIds: selectedTeamIds,
      userId: selectedOwnerId || undefined,
    });
    setSelectedTeamIds([]);
  }, [
    server?.catalogId,
    selectedTeamIds,
    selectedOwnerId,
    grantAccessMutation,
  ]);

  const handleRevoke = useCallback(
    async (teamId: string, serverId?: string) => {
      if (!serverId) return;

      // Use the specific serverId from the team details row
      await revokeAccessMutation.mutateAsync({
        serverId,
        teamId,
      });
    },
    [revokeAccessMutation],
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
            Teams with access
            <span className="text-muted-foreground font-normal">
              {label || server.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            {hasTeamAuthServer
              ? "Grant and manage team access to this MCP server. Teams will use your team authentication credentials."
              : "No team authentication is installed. You must install with team authentication first to grant team access."}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {hasTeamAuthServer ? (
            <>
              {/* Token Owner Selection */}
              <div className="space-y-2">
                <Label htmlFor="select-owner">
                  Token Owner (which admin's credentials to use)
                </Label>
                {teamAuthServers.length === 1 ? (
                  <div className="px-3 py-2 border rounded-md bg-muted text-sm">
                    {teamAuthServers[0].ownerEmail || "Unknown"}
                  </div>
                ) : (
                  <Select
                    value={selectedOwnerId}
                    onValueChange={setSelectedOwnerId}
                  >
                    <SelectTrigger id="select-owner">
                      <SelectValue placeholder="Select an admin's token" />
                    </SelectTrigger>
                    <SelectContent>
                      {teamAuthServers.map((srv) => (
                        <SelectItem
                          key={srv.id}
                          value={srv.ownerId || ""}
                          disabled={!srv.ownerId}
                        >
                          {srv.ownerEmail || "Unknown"} (
                          {new Date(srv.createdAt).toLocaleDateString()})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Team Selection Section */}
              <div className="space-y-2">
                <Label htmlFor="select-team">
                  Select Teams to Grant Access
                </Label>
                <div className="flex gap-2">
                  <Select value={currentTeamId} onValueChange={handleAddTeam}>
                    <SelectTrigger id="select-team">
                      <SelectValue placeholder="Select a team to grant access" />
                    </SelectTrigger>
                    <SelectContent>
                      {unassignedTeams.length === 0 ? (
                        <div className="px-2 py-1.5 text-sm text-muted-foreground">
                          All teams already have access
                        </div>
                      ) : (
                        unassignedTeams.map((team) => (
                          <SelectItem key={team.id} value={team.id}>
                            {team.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  {selectedTeamIds.length > 0 && (
                    <Button
                      onClick={handleGrantAccess}
                      disabled={grantAccessMutation.isPending}
                      size="default"
                    >
                      Grant Access to {selectedTeamIds.length}{" "}
                      {selectedTeamIds.length === 1 ? "Team" : "Teams"}
                    </Button>
                  )}
                </div>

                {/* Selected Teams for Granting Access */}
                {selectedTeamIds.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {selectedTeamIds.map((teamId) => {
                      const team = getTeamById(teamId);
                      return (
                        <Badge
                          key={teamId}
                          variant="secondary"
                          className="flex items-center gap-1 pr-1"
                        >
                          <span>{team?.name || teamId}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveSelectedTeam(teamId)}
                            className="h-auto p-0.5 ml-1 hover:bg-destructive/20"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Existing Teams Table */}
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
                        <TableHead>Token Owner</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead className="w-[120px]">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {teamDetails.map((team) => (
                        <TableRow key={team.teamId}>
                          <TableCell className="font-medium">
                            {team.name}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {getOwnerEmailByServerId(team.serverId) || "N/A"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {format(new Date(team.createdAt), "PPp")}
                          </TableCell>
                          <TableCell>
                            <Button
                              onClick={() =>
                                handleRevoke(team.teamId, team.serverId)
                              }
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
            </>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No team authentication is configured. Use the "Authorize teams"
              button to set up team access.
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
