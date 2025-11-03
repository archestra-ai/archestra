"use client";

import type { archestraApiTypes } from "@shared";
import { Building2, Info, X } from "lucide-react";
import { useState } from "react";
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
import { useTeams } from "@/lib/team.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface NoAuthInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstall: (teams: string[]) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
  isAdmin: boolean;
}

export function NoAuthInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
  isAdmin,
}: NoAuthInstallDialogProps) {
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  const { data: teams } = useTeams();

  const handleAddTeam = (teamId: string) => {
    if (teamId && !assignedTeamIds.includes(teamId)) {
      setAssignedTeamIds([...assignedTeamIds, teamId]);
      setSelectedTeamId("");
    }
  };

  const handleRemoveTeam = (teamId: string) => {
    setAssignedTeamIds(assignedTeamIds.filter((id) => id !== teamId));
  };

  const unassignedTeams = !teams
    ? []
    : teams.filter((team) => !assignedTeamIds.includes(team.id));

  const getTeamById = (teamId: string) => {
    return teams?.find((team) => team.id === teamId);
  };

  const handleInstall = async () => {
    await onInstall(assignedTeamIds);
    setAssignedTeamIds([]);
    setSelectedTeamId("");
  };

  const handleClose = () => {
    setAssignedTeamIds([]);
    setSelectedTeamId("");
    onClose();
  };

  if (!catalogItem) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            <span>Install {catalogItem.name}</span>
          </DialogTitle>
          <DialogDescription>
            This MCP server doesn't require authentication.
            {isAdmin
              ? " You can optionally assign it to specific teams."
              : " Click Install to proceed."}
          </DialogDescription>
        </DialogHeader>

        {isAdmin && (
          <div className="grid gap-4 py-4">
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                You can assign this server to specific teams or leave it
                unassigned.
              </AlertDescription>
            </Alert>

            <div className="grid gap-2">
              <Label htmlFor="assign-team">Select Teams (Optional)</Label>
              <p className="text-sm text-muted-foreground">
                Choose which teams will have access to this server.
              </p>
              <Select value={selectedTeamId} onValueChange={handleAddTeam}>
                <SelectTrigger id="assign-team">
                  <SelectValue placeholder="Select a team to assign" />
                </SelectTrigger>
                <SelectContent>
                  {unassignedTeams.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      All teams are already assigned
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
              {assignedTeamIds.length > 0 && (
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
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button onClick={handleInstall} disabled={isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
