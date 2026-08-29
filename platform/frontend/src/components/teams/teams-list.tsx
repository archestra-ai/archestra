"use client";
import {
  archestraApiSdk,
  type archestraApiTypes,
  E2eTestId,
} from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Pencil, Plus, Trash2, Users } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetSettingsAction } from "@/app/settings/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import { LabelTags } from "@/components/label-tags";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { reportBulkOutcome, toBulkOutcome } from "@/lib/bulk-action";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  useTeam,
  useTeamLabelKeys,
  useTeamLabelValues,
  useTeams,
} from "@/lib/teams/team.query";
import { throwOnApiError } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { TeamManagementDialog } from "./team-management-dialog";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

export function TeamsList() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const router = useRouter();
  const pathname = usePathname();
  const setActionButton = useSetSettingsAction();
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const sectionParam = searchParams.get("section");
  const teamId = searchParams.get("team");
  const { data: teamFromUrl } = useTeam(teamId ?? undefined);
  const {
    entity: managedTeam,
    open: openManagementDialog,
    close: closeManagementDialog,
    openedFromUrl,
  } = useDialogUrlParam<Team>({
    paramName: "team",
    entityFromUrl: teamFromUrl ?? null,
    alsoClearOnClose: ["section"],
  });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [teamToDelete, setTeamToDelete] = useState<Team | null>(null);

  const search = searchParams.get("search") || "";
  const labelsParam = searchParams.get("labels");
  const parsedLabels = useMemo(
    () => parseLabelsParam(labelsParam),
    [labelsParam],
  );
  const hasLabelFilters =
    !!parsedLabels && Object.keys(parsedLabels).length > 0;

  const { data: teams, isFetching: isLoading } = useTeams({
    name: search,
    labels: labelsParam ?? undefined,
  });
  const { data: labelKeys } = useTeamLabelKeys();
  const { data: session } = useSession();
  const { data: canUpdateTeams = false } = useHasPermissions({
    team: ["update"],
  });
  // Identity-provider readers may view a team's external group sync mappings
  // without being able to manage the team.
  const { data: canReadIdentityProviders = false } = useHasPermissions({
    identityProvider: ["read"],
  });
  const currentUserId = session?.user.id;
  const isTeamAdminOf = useCallback(
    (team: Team) =>
      team.members?.some(
        (member) => member.userId === currentUserId && member.role === "admin",
      ) ?? false,
    [currentUserId],
  );

  const handleRemoveLabel = useCallback(
    (key: string, value: string) => {
      if (!parsedLabels) return;
      const updated = { ...parsedLabels };
      updated[key] = (updated[key] ?? []).filter((v) => v !== value);
      if (updated[key].length === 0) {
        delete updated[key];
      }
      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeLabels(updated);
      if (serialized) {
        params.set("labels", serialized);
      } else {
        params.delete("labels");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [parsedLabels, searchParams, router, pathname],
  );

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

  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedTeams,
    selectAllMatching,
  } = useBulkSelection({
    rows: teams ?? [],
    getId: (team) => team.id,
    filterSignature: JSON.stringify({ search, hasLabelFilters }),
    matchDescription: search || hasLabelFilters ? "match the filters" : "exist",
  });

  // Fans out over the single-item route. Deliberately separate from
  // `deleteMutation` above, which toasts per call — for a selection that would
  // be one toast per row instead of one for the batch.
  const bulkDelete = useMutation({
    mutationFn: async (selection: readonly Team[]) =>
      archestraApiSdk
        .bulkDeleteTeams({ body: { ids: selection.map((team) => team.id) } })
        .then(({ data, error }) => {
          throwOnApiError(error, { toastOnError: false });
          return toBulkOutcome(data ?? { succeeded: [], failed: [] });
        }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });

  const handleDeleteTeam = () => {
    if (teamToDelete) {
      deleteMutation.mutate(teamToDelete.id);
    }
  };

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
    createSelectColumn<Team>({
      rowLabel: (team) => `Select ${team.name}`,
      allLabel: "Select all teams on this page",
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      enableSorting: false,
      cell: ({ row }) => {
        const team = row.original;
        return (
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{team.name}</span>
              {team.labels && team.labels.length > 0 && (
                <LabelTags labels={team.labels} />
              )}
            </div>
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
            {count} member{count !== 1 ? <span>s</span> : null}
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
        const canEditTeam = canUpdateTeams || isTeamAdminOf(team);
        // Identity-provider readers who can't manage the team still get a
        // view-only entry into the External Group Sync section.
        const viewOnlyGroupSync = !canEditTeam && canReadIdentityProviders;
        const actions: TableRowAction[] = [
          {
            icon: viewOnlyGroupSync ? (
              <Eye className="h-4 w-4" />
            ) : (
              <Pencil className="h-4 w-4" />
            ),
            label: viewOnlyGroupSync ? "View group sync" : "Edit",
            disabled: !canEditTeam && !viewOnlyGroupSync,
            disabledTooltip: "You must be a team admin to manage this team",
            testId: `${E2eTestId.ManageMembersButton}-${team.name}`,
            onClick: () => openManagementDialog(team),
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
      <BulkActionsScope>
        <CollectionFilters>
          <FilterBar>
            <SearchInput
              isLoading={isLoading}
              objectNamePlural="teams"
              searchFields={["name"]}
              className={filterSearchClass}
            />
            <LabelSelect
              labelKeys={labelKeys}
              LabelKeyRowComponent={TeamLabelKeyRow}
              className={filterControlClass({ active: hasLabelFilters })}
            />
          </FilterBar>

          {hasLabelFilters && (
            <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />
          )}
        </CollectionFilters>

        <BulkActions
          count={selectedTeams.length}
          noun="team"
          onClear={clearSelection}
          selectAllMatching={selectAllMatching}
          busy={bulkDelete.isPending}
        >
          <PermissionButton
            permissions={{ team: ["delete"] }}
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            <span>Delete</span>
          </PermissionButton>
        </BulkActions>

        <DataTable
          columns={columns}
          data={teams ?? []}
          getRowId={(row) => row.id}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onPageRowIdsChange={onPageRowIdsChange}
          isLoading={isLoading}
          hasActiveFilters={Boolean(search) || hasLabelFilters}
          onClearFilters={() =>
            updateQueryParams({ search: null, labels: null, page: "1" })
          }
          emptyIcon={Users}
          emptyMessage="No teams found"
          hideSelectedCount
        />
      </BulkActionsScope>

      <TeamManagementDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete teams"
          description={`Delete ${selectedTeams.length} ${
            selectedTeams.length === 1 ? "team" : "teams"
          }? Members stay in the organization; only the teams go.`}
          isPending={bulkDelete.isPending}
          onConfirm={() => {
            bulkDelete.mutate(selectedTeams, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,

                  verb: "Deleted",

                  failureVerb: "delete",

                  noun: "team",
                });

                setBulkDeleteOpen(false);

                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Delete teams"
          pendingLabel="Deleting..."
        />
      )}

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

      {managedTeam && (
        <TeamManagementDialog
          open={!!managedTeam}
          onOpenChange={(open) => !open && closeManagementDialog()}
          team={managedTeam}
          initialSection={
            openedFromUrl && sectionParam === "token" ? "token" : undefined
          }
          readOnly={!canUpdateTeams && !isTeamAdminOf(managedTeam)}
        />
      )}
    </>
  );
}

function TeamLabelKeyRow({
  labelKey,
  selectedValues,
  onToggleValue,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: values } = useTeamLabelValues({
    key: open ? labelKey : undefined,
  });
  return (
    <LabelKeyRowBase
      labelKey={labelKey}
      selectedValues={selectedValues}
      onToggleValue={onToggleValue}
      values={values}
      onOpenChange={setOpen}
    />
  );
}
