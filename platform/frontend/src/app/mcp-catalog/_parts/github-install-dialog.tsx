"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useCallback, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GetInternalMcpCatalogResponses } from "@/lib/clients/api";
import { getTeams } from "@/lib/clients/api/sdk.gen";

interface GitHubInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstall: (
    catalogItem: GetInternalMcpCatalogResponses["200"][number],
    metadata: Record<string, unknown>,
    teams: string[],
  ) => Promise<void>;
  catalogItem: GetInternalMcpCatalogResponses["200"][number] | null;
  isInstalling: boolean;
}

export function GitHubInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
}: GitHubInstallDialogProps) {
  const [githubToken, setGithubToken] = useState("");
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await getTeams();
      return response.data || [];
    },
  });

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

  const getTeamById = useCallback(
    (teamId: string) => {
      return teams?.find((team) => team.id === teamId);
    },
    [teams],
  );

  const getUnassignedTeams = useCallback(() => {
    if (!teams) return [];
    return teams.filter((team) => !assignedTeamIds.includes(team.id));
  }, [teams, assignedTeamIds]);

  const handleInstall = useCallback(async () => {
    if (!catalogItem || !githubToken.trim()) {
      return;
    }

    try {
      await onInstall(
        catalogItem,
        { githubToken: githubToken.trim() },
        assignedTeamIds,
      );
      setGithubToken("");
      setAssignedTeamIds([]);
      setSelectedTeamId("");
      onClose();
    } catch (_error) {
      // Error handling is done in the parent component
    }
  }, [catalogItem, githubToken, assignedTeamIds, onInstall, onClose]);

  const handleClose = useCallback(() => {
    setGithubToken("");
    setAssignedTeamIds([]);
    setSelectedTeamId("");
    onClose();
  }, [onClose]);

  if (!catalogItem) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Install {catalogItem.name}</DialogTitle>
          <DialogDescription>
            This MCP server requires a GitHub Personal Access Token to access
            repositories.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="github-token">GitHub Personal Access Token</Label>
            <Input
              id="github-token"
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              className="col-span-3"
            />
            <p className="text-sm text-muted-foreground">
              You can create a Personal Access Token in your GitHub settings.
              Make sure it has appropriate repository permissions for the
              repositories you want to access.
            </p>
          </div>

          <div className="rounded-md bg-muted p-4">
            <h4 className="text-sm font-medium mb-2">Required Permissions:</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Repository access (read/write)</li>
              <li>• Issues and pull requests</li>
              <li>• Repository contents</li>
            </ul>
          </div>

          <div className="grid gap-2">
            <Label>Team Access (Optional)</Label>
            <p className="text-sm text-muted-foreground">
              Assign teams to grant their members access to this MCP server.
            </p>
            <Select value={selectedTeamId} onValueChange={handleAddTeam}>
              <SelectTrigger>
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
                      <button
                        type="button"
                        onClick={() => handleRemoveTeam(teamId)}
                        className="ml-1 hover:bg-destructive/20 rounded-full p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button
            onClick={handleInstall}
            disabled={!githubToken.trim() || isInstalling}
          >
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
