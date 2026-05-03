"use client";
import { archestraApiSdk, type archestraApiTypes, E2eTestId } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Key, Link2, Plus, Trash2, Users, Vault } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetSettingsAction } from "@/app/settings/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { type TeamToken, useTokens } from "@/lib/teams/team-token.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { TeamMembersDialog } from "./team-members-dialog";
import { TokenManagerDialog } from "./token-manager-dialog";

const TeamVaultFolderDialog = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("./team-vault-folder-dialog.ee"),
);

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const { TeamExternalGroupsDialog } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: conditional EE component with SSO / external teams
    await import("./team-external-groups-dialog.ee")
  : {
      TeamExternalGroupsDialog: () => null,
    };

export function TeamsList() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const setActionButton = useSetSettingsAction();
  const queryClient = useQueryClient();
  const byosEnabled = useFeature("byosEnabled");
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

  const search = searchParams.get("search") || "";

  // Tokens query
  const { data: tokensData, isLoading: tokensLoading } = useTokens();
  const tokens = tokensData?.tokens;

  const { data: teams, isLoading } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams({
        query: { limit: 100, offset: 0 },
      });
      return data?.data ?? [];
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

  const filteredTeams = useMemo(
    () =>
      (teams ?? []).filter((team) => {
        if (!search) return true;
        return team.name.toLowerCase().includes(search.toLowerCase());
      }),
    [teams, search],
  );

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ team: ["create"] }}
        onClick={() => setCreateDialogOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Create Team
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton]);

  const columns: ColumnDef<Team>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      enableSorting: false,
      cell: ({ row }) => {
        const team = row.original;
        return (
          <div>
            <div className="font-medium">{team.name}</div>
            {team.description && (
              <div className="text-xs text-muted-foreground truncate max-w-md">
                {team.description}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "members",
      header: "Members",
      enableSorting: false,
      cell: ({ row }) => {
        const count = row.original.members?.length || 0;
        return (
          <div className="text-sm">
            {count} member{count !== 1 ? "s" : ""}
          </div>
        );
      },
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: "Created",
      enableSorting: false,
      cell: ({ row }) => {
        const createdAt = row.original.createdAt;
        if (!createdAt) return <span className="text-muted-foreground">-</span>;
        return (
          <div className="text-sm text-muted-foreground">
            {formatRelativeTimeFromNow(createdAt)}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => {
        const team = row.original;
        const actions: TableRowAction[] = [
          {
            icon: <Users className="h-4 w-4" />,
            label: "Manage Members",
            permissions: { team: ["update"] } as const,
            testId: `${E2eTestId.ManageMembersButton}-${team.name}`,
            onClick: () => {
              setSelectedTeam(team);
              setMembersDialogOpen(true);
            },
          },
          {
            icon: <Key className="h-4 w-4" />,
            label: "Manage MCP/A2A Gateway Token",
            permissions: { team: ["update"] } as const,
            disabled: tokensLoading,
            disabledTooltip: tokensLoading ? "Loading tokens..." : undefined,
            onClick: () => {
              const teamToken = tokens?.find((t) => t.team?.id === team.id);
              if (teamToken) {
                setSelectedToken(teamToken);
                setTokenDialogOpen(true);
              } else {
                toast.error("No token found for this team");
              }
            },
          },
          ...(byosEnabled
            ? [
                {
                  icon: <Vault className="h-4 w-4" />,
                  label: "Configure Vault Folder",
                  permissions: { team: ["update"] } as const,
                  testId: `${E2eTestId.ConfigureVaultFolderButton}-${team.name}`,
                  onClick: () => {
                    setSelectedTeam(team);
                    setVaultFolderDialogOpen(true);
                  },
                },
              ]
            : []),
          ...(config.enterpriseFeatures.core
            ? [
                {
                  icon: <Link2 className="h-4 w-4" />,
                  label: "Configure SSO Team Sync",
                  permissions: { team: ["update"] } as const,
                  testId: `${E2eTestId.ConfigureIdpTeamSyncButton}-${team.id}`,
                  onClick: () => {
                    setSelectedTeam(team);
                    setExternalGroupsDialogOpen(true);
                  },
                },
              ]
            : []),
          {
            icon: <Trash2 className="h-4 w-4" />,
            label: "Delete",
            permissions: { team: ["delete"] } as const,
            variant: "destructive" as const,
            onClick: () => {
              setTeamToDelete(team);
              setDeleteDialogOpen(true);
            },
          },
        ];

        return <TableRowActions actions={actions} />;
      },
    },
  ];

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <SearchInput objectNamePlural="teams" searchFields={["name"]} />
        </div>

        <DataTable
          columns={columns}
          data={filteredTeams}
          isLoading={isLoading}
          hasActiveFilters={Boolean(search)}
          onClearFilters={() => updateQueryParams({ search: null, page: "1" })}
          emptyIcon={<Users className="h-10 w-10" />}
          emptyMessage="No teams found"
          hideSelectedCount
        />
      </div>

      <FormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        title="Create New Team"
        description="Create a team to organize access to profiles and MCP servers"
        size="medium"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleCreateTeam}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
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
          <DialogStickyFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create Team"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setTeamToDelete(null);
          }
        }}
        title="Delete Team"
        description={`Are you sure you want to delete "${teamToDelete?.name ?? ""}"? This action cannot be undone.`}
        isPending={deleteMutation.isPending}
        onConfirm={handleDeleteTeam}
      />

      {selectedTeam && membersDialogOpen && (
        <TeamMembersDialog
          open={membersDialogOpen}
          onOpenChange={setMembersDialogOpen}
          team={selectedTeam}
        />
      )}

      {selectedTeam && externalGroupsDialogOpen && (
        <TeamExternalGroupsDialog
          open={externalGroupsDialogOpen}
          onOpenChange={setExternalGroupsDialogOpen}
          team={selectedTeam}
        />
      )}

      {selectedTeam && vaultFolderDialogOpen && (
        <Suspense fallback={null}>
          <TeamVaultFolderDialog
            open={vaultFolderDialogOpen}
            onOpenChange={setVaultFolderDialogOpen}
            team={selectedTeam}
          />
        </Suspense>
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
