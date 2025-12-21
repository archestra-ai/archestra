"use client";
import { archestraApiSdk, type archestraApiTypes, E2eTestId } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Key, Link2, Plus, Settings, Trash2, Users, Vault } from "lucide-react";

import { lazy, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import config from "@/lib/config";
import { useFeatureFlag } from "@/lib/features.hook";
import { type TeamToken, useTokens } from "@/lib/team-token.query";
import { WithPermissions } from "../roles/with-permissions";
import { TeamMembersDialog } from "./team-members-dialog";
import { TokenManagerDialog } from "./token-manager-dialog";

const TeamVaultFolderDialog = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("./team-vault-folder-dialog.ee"),
);

type Team = archestraApiTypes.GetTeamsResponses["200"][number];

const { TeamExternalGroupsDialog } = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: conditional EE component with SSO / external teams
    await import("./team-external-groups-dialog.ee")
  : {
      TeamExternalGroupsDialog: () => null,
    };

export function TeamsList() {
  const queryClient = useQueryClient();
  const byosEnabled = useFeatureFlag("byosEnabled");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const [externalGroupsDialogOpen, setExternalGroupsDialogOpen] =
    useState(false);
  const [vaultFolderDialogOpen, setVaultFolderDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [teamToDelete, setTeamToDelete] = useState<Team | null>(null);

  // Token management state
  const [selectedToken, setSelectedToken] = useState<TeamToken | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  // Form state
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");

  // Tokens query
  const { data: tokens, isLoading: tokensLoading } = useTokens();

  const { data: teams, isLoading } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams();
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      return await archestraApiSdk.createTeam({
        body: data,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      setCreateDialogOpen(false);
      setTeamName("");
      setTeamDescription("");
      toast.success("Team created successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create team");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (teamId: string) => {
      return await archestraApiSdk.deleteTeam({
        path: { id: teamId },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      setDeleteDialogOpen(false);
      setTeamToDelete(null);
      toast.success("Team deleted successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete team");
    },
  });

  const handleCreateTeam = () => {
    if (!teamName.trim()) {
      toast.error("Team name is required");
      return;
    }

    createMutation.mutate({
      name: teamName,
      description: teamDescription || undefined,
    });
  };

  const handleDeleteTeam = () => {
    if (teamToDelete) {
      deleteMutation.mutate(teamToDelete.id);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
          <CardDescription>Loading teams...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Teams</CardTitle>
              <CardDescription>
                Manage teams to organize access to profiles and MCP servers
              </CardDescription>
            </div>
            <PermissionButton
              permissions={{ team: ["create"] }}
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create Team
            </PermissionButton>
          </div>
        </CardHeader>
        <CardContent>
          {!teams || teams.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Users className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No teams yet. Create your first team to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {teams.map((team) => (
                <div
                  key={team.id}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div className="flex-1">
                    <h3 className="font-semibold">{team.name}</h3>
                    {team.description && (
                      <p className="text-sm text-muted-foreground">
                        {team.description}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {team.members?.length || 0} member
                      {(team.members?.length || 0) !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <PermissionButton
                      permissions={{ team: ["update"] }}
                      variant="outline"
                      size="sm"
                      disabled={tokensLoading}
                      onClick={() => {
                        const teamToken = tokens?.find(
                          (t) => t.team?.id === team.id,
                        );
                        if (teamToken) {
                          setSelectedToken(teamToken);
                          setTokenDialogOpen(true);
                        } else {
                          toast.error("No token found for this team");
                        }
                      }}
                    >
                      <Key className="mr-2 h-4 w-4" />
                      Manage Token
                    </PermissionButton>
                    <PermissionButton
                      permissions={{ team: ["update"] }}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSelectedTeam(team);
                        setMembersDialogOpen(true);
                      }}
                      data-testid={`${E2eTestId.ManageMembersButton}-${team.name}`}
                    >
                      <Settings className="mr-2 h-4 w-4" />
                      Manage Members
                    </PermissionButton>
                    {byosEnabled && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <PermissionButton
                            permissions={{ team: ["update"] }}
                            variant="outline"
                            size="sm"
                            data-testid={`${E2eTestId.ConfigureVaultFolderButton}-${team.name}`}
                            onClick={() => {
                              setSelectedTeam(team);
                              setVaultFolderDialogOpen(true);
                            }}
                          >
                            <Vault className="h-4 w-4" />
                          </PermissionButton>
                        </TooltipTrigger>
                        <TooltipContent>Configure Vault Folder</TooltipContent>
                      </Tooltip>
                    )}
                    {config.enterpriseLicenseActivated && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <PermissionButton
                            permissions={{ team: ["update"] }}
                            variant="outline"
                            size="sm"
                            data-testid={`${E2eTestId.ConfigureSsoTeamSyncButton}-${team.id}`}
                            onClick={() => {
                              setSelectedTeam(team);
                              setExternalGroupsDialogOpen(true);
                            }}
                          >
                            <Link2 className="h-4 w-4" />
                          </PermissionButton>
                        </TooltipTrigger>
                        <TooltipContent>Configure SSO Team Sync</TooltipContent>
                      </Tooltip>
                    )}
                    <PermissionButton
                      permissions={{ team: ["delete"] }}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setTeamToDelete(team);
                        setDeleteDialogOpen(true);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </PermissionButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Organization Token Section */}
      <WithPermissions
        permissions={{ team: ["update"] }}
        noPermissionHandle="hide"
      >
        <Card className="mt-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Organization Token</CardTitle>
                <CardDescription>
                  Organization-wide authentication token for MCP Gateway access
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {tokensLoading ? (
              <p className="text-sm text-muted-foreground">Loading token...</p>
            ) : (
              (() => {
                const orgToken = tokens?.find((t) => t.isOrganizationToken);
                if (!orgToken) {
                  return (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <Key className="mb-4 h-12 w-12 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        No organization token available. It will be
                        automatically created.
                      </p>
                    </div>
                  );
                }
                return (
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="flex-1">
                      <p className="font-mono text-sm text-muted-foreground">
                        {orgToken.tokenStart}...
                      </p>
                    </div>
                    <PermissionButton
                      permissions={{ team: ["update"] }}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSelectedToken(orgToken);
                        setTokenDialogOpen(true);
                      }}
                    >
                      <Key className="mr-2 h-4 w-4" />
                      Manage Token
                    </PermissionButton>
                  </div>
                );
              })()
            )}
          </CardContent>
        </Card>
      </WithPermissions>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Create New Team</DialogTitle>
            <DialogDescription>
              Create a team to organize access to profiles and MCP servers
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Team Name *</Label>
              <Input
                id="name"
                placeholder="Engineering Team"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Team for engineering staff..."
                value={teamDescription}
                onChange={(e) => setTeamDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateTeam}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create Team"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Delete Team</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{teamToDelete?.name}"? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteTeam}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedTeam && (
        <>
          <TeamMembersDialog
            open={membersDialogOpen}
            onOpenChange={setMembersDialogOpen}
            team={selectedTeam}
          />
          <TeamExternalGroupsDialog
            open={externalGroupsDialogOpen}
            onOpenChange={setExternalGroupsDialogOpen}
            team={selectedTeam}
          />
          <TeamVaultFolderDialog
            open={vaultFolderDialogOpen}
            onOpenChange={setVaultFolderDialogOpen}
            team={selectedTeam}
          />
        </>
      )}

      {selectedToken && (
        <TokenManagerDialog
          open={tokenDialogOpen}
          onOpenChange={setTokenDialogOpen}
          token={selectedToken}
        />
      )}
    </>
  );
}
