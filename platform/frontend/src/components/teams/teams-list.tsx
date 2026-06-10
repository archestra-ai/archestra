"use client";
import {
  archestraApiSdk,
  type archestraApiTypes,
  E2eTestId,
} from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetSettingsAction } from "@/app/settings/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useTeams } from "@/lib/teams/team.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { TeamManagementDialog } from "./team-management-dialog";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

export function TeamsList() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const setActionButton = useSetSettingsAction();
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [managementDialogOpen, setManagementDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [teamToDelete, setTeamToDelete] = useState<Team | null>(null);

  const search = searchParams.get("search") || "";

  const { data: teams, isLoading } = useTeams();
  const { data: session } = useSession();
  const { data: canUpdateTeams = false } = useHasPermissions({
    team: ["update"],
  });
  const currentUserId = session?.user.id;

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
        const isTeamAdmin = team.members?.some(
          (member) =>
            member.userId === currentUserId && member.role === "admin",
        );
        const canEditTeam = canUpdateTeams || isTeamAdmin;
        const actions: TableRowAction[] = [
          {
            icon: <Pencil className="h-4 w-4" />,
            label: "Edit",
            disabled: !canEditTeam,
            disabledTooltip: "You must be a team admin to manage this team",
            testId: `${E2eTestId.ManageMembersButton}-${team.name}`,
            onClick: () => {
              setSelectedTeam(team);
              setManagementDialogOpen(true);
            },
          },
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

      <TeamManagementDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

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

      {selectedTeam && managementDialogOpen && (
        <TeamManagementDialog
          open={managementDialogOpen}
          onOpenChange={setManagementDialogOpen}
          team={selectedTeam}
        />
      )}
    </>
  );
}
