"use client";

import type { archestraApiTypes } from "@shared";
import { Building2, Info, ShieldCheck, User, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { useMcpServers } from "@/lib/mcp-server.query";
import { useTeams } from "@/lib/team.query";

interface OAuthConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  onConfirm: (teams: string[]) => void;
  onCancel: () => void;
  isTeamMode?: boolean;
  catalogId?: string;
  installedServers?: archestraApiTypes.GetMcpServersResponses["200"];
}

export function OAuthConfirmationDialog({
  open,
  onOpenChange,
  serverName,
  onConfirm,
  onCancel,
  isTeamMode = false,
  catalogId,
  installedServers,
}: OAuthConfirmationDialogProps) {
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  const { data: teams } = useTeams();
  const { data: allServers } = useMcpServers();

  // Get teams that already have access to this catalog
  const teamsWithExistingAccess = useMemo(() => {
    if (!catalogId) return new Set<string>();

    const serversToCheck = installedServers || allServers || [];
    const serversForCatalog = serversToCheck.filter(
      (s) => s.catalogId === catalogId,
    );

    const teamIds = new Set<string>();
    for (const server of serversForCatalog) {
      if (server.teams) {
        for (const teamId of server.teams) {
          teamIds.add(teamId);
        }
      }
    }
    return teamIds;
  }, [catalogId, installedServers, allServers]);

  const handleAddTeam = useCallback(
    (teamId: string) => {
      if (teamId && !assignedTeamIds.includes(teamId)) {
        setAssignedTeamIds([...assignedTeamIds, teamId]);
        setSelectedTeamId("");
      }
    },
    [assignedTeamIds],
  );

  const handleRemoveTeam = useCallback(
    (teamId: string) => {
      setAssignedTeamIds(assignedTeamIds.filter((id) => id !== teamId));
    },
    [assignedTeamIds],
  );

  const getUnassignedTeams = useCallback(() => {
    if (!teams) return [];
    return teams.filter(
      (team) =>
        !assignedTeamIds.includes(team.id) &&
        !teamsWithExistingAccess.has(team.id),
    );
  }, [teams, assignedTeamIds, teamsWithExistingAccess]);

  const getTeamById = useCallback(
    (teamId: string) => {
      return teams?.find((team) => team.id === teamId);
    },
    [teams],
  );

  const handleConfirm = useCallback(() => {
    onConfirm(assignedTeamIds);
    setAssignedTeamIds([]);
    setSelectedTeamId("");
    onOpenChange(false);
  }, [assignedTeamIds, onConfirm, onOpenChange]);

  const handleCancel = useCallback(() => {
    setAssignedTeamIds([]);
    setSelectedTeamId("");
    onCancel();
    onOpenChange(false);
  }, [onCancel, onOpenChange]);

  const isValid = !isTeamMode || assignedTeamIds.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {isTeamMode ? (
                <Building2 className="h-5 w-5" />
              ) : (
                <User className="h-5 w-5" />
              )}
              <span>
                {isTeamMode ? "Authorize teams" : "Authenticated users"}
              </span>
              <Badge
                variant="secondary"
                className="flex items-center gap-1 ml-2"
              >
                <ShieldCheck className="h-3 w-3" />
                OAuth
              </Badge>
              <span className="text-muted-foreground ml-2 font-normal">
                {serverName}
              </span>
            </div>
          </DialogTitle>
          <DialogDescription className="pt-4 space-y-3 text-sm">
            You'll be redirected to {serverName}'s authorization page to grant
            access. After authentication, you'll be brought back here and the
            server will be installed with your credentials.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {isTeamMode && (
            <>
              <Alert className="mb-4">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  Admin only: You are configuring shared credentials
                </AlertDescription>
              </Alert>

              <div className="grid gap-2">
                <Label htmlFor="assign-team">
                  Select Teams <span className="text-destructive">*</span>
                </Label>
                <p className="text-sm text-muted-foreground">
                  Choose which teams will have access to this authentication.
                </p>
                <Select value={selectedTeamId} onValueChange={handleAddTeam}>
                  <SelectTrigger id="assign-team">
                    <SelectValue placeholder="Select a team to assign" />
                  </SelectTrigger>
                  <SelectContent>
                    {getUnassignedTeams().length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        All teams are already assigned
                      </div>
                    ) : (
                      getUnassignedTeams().map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {assignedTeamIds.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {assignedTeamIds.map((teamId) => {
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
                            onClick={() => handleRemoveTeam(teamId)}
                            className="h-auto p-0.5 ml-1 hover:bg-destructive/20"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </Badge>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-3 sm:gap-3">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!isValid}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue to Authorization...
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
