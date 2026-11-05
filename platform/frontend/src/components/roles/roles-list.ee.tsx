"use client";

import {
  type archestraApiTypes,
  type PredefinedRoleName,
  roleDescriptions,
} from "@archestra/shared";

import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { RoleTypeIcon } from "@/components/roles/role-type-icon";
import { SearchInput } from "@/components/search-input";
import { useSetSettingsAction } from "@/components/settings/settings-layout.context";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useAllMatchingRoles,
  useBulkDeleteRoles,
  useDeleteRole,
  useRolesPaginated,
} from "@/lib/role.query";
import { downloadRoleAsJson } from "./role-export";

type Role = archestraApiTypes.GetRoleResponses["200"];

/**
 * Enterprise Edition roles list. Every role opens on its own page; custom
 * roles are created, edited and deleted there, predefined ones are read-only.
 */
export function RolesList({ headerAction }: { headerAction?: ReactNode }) {
  const router = useRouter();
  const setActionButton = useSetSettingsAction();
  const {
    pageIndex,
    pageSize,
    offset,
    searchParams,
    setPagination,
    updateQueryParams,
  } = useDataTableQueryParams();
  const nameFilter = searchParams.get("name") || undefined;
  const {
    data: rolesResponse,
    isFetching: isLoading,
    isLoadingError,
    refetch,
  } = useRolesPaginated({
    limit: pageSize,
    offset,
    name: nameFilter,
  });
  const deleteMutation = useDeleteRole();
  const bulkDelete = useBulkDeleteRoles();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setEscalatedFor(null);
  }, []);

  const filterSignature = nameFilter ?? "";
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;
  const { data: allMatchingRoles, isFetching: isFetchingAllMatching } =
    useAllMatchingRoles(
      { search: nameFilter || undefined },
      { enabled: allMatchingSelected },
    );

  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ ac: ["create"] }}
        size="sm"
        onClick={() => router.push("/settings/roles/new")}
      >
        <Plus className="h-4 w-4" />
        Create Custom Role
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton, router]);

  // Sort: predefined first, then custom
  const allRoles = [...(rolesResponse?.data ?? [])].sort((a, b) => {
    if (a.predefined && !b.predefined) return -1;
    if (!a.predefined && b.predefined) return 1;
    return 0;
  });
  const total = rolesResponse?.pagination.total ?? 0;

  // Predefined roles never enter a selection, so the counts and the offer are
  // both about the custom ones alone.
  const selectableOnPage = allRoles.filter((role) => !role.predefined);
  const { effectiveRowSelection, onRowSelectionChange } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: allRoles,
      getRowId: (row) => row.id,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
      canSelect: (row) => !row.predefined,
    });
  const selectedOnPage = selectableOnPage.filter(
    (role) => effectiveRowSelection[role.id],
  );
  const selectedRoles =
    allMatchingSelected && allMatchingRoles
      ? allMatchingRoles.filter((role) => !role.predefined)
      : selectedOnPage;
  const customRoleTotal = allMatchingRoles
    ? allMatchingRoles.filter((role) => !role.predefined).length
    : Math.max(total - (allRoles.length - selectableOnPage.length), 0);

  const columns: ColumnDef<Role>[] = [
    createSelectColumn<Role>({
      rowLabel: (role) => `Select ${role.name}`,
      allLabel: "Select all roles on this page",
      // Predefined roles are immutable — there is nothing a bulk action could
      // do to them.
      canSelect: (role) => !role.predefined,
      disabledReason: () => "Predefined roles cannot be deleted",
    }),
    {
      id: "icon",
      size: 24,
      enableSorting: false,
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <RoleTypeIcon predefined={row.original.predefined} withTooltip />
        </div>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      size: 520,
      enableSorting: false,
      cell: ({ row }) => {
        const role = row.original;
        const predefinedDescription = role.predefined
          ? roleDescriptions[role.name as PredefinedRoleName]
          : null;
        const description = role.description || predefinedDescription;
        return (
          <div>
            <RowClickShield className="contents">
              <Link
                href={`/settings/roles/${role.id}`}
                className="font-medium capitalize"
              >
                {role.name}
              </Link>
            </RowClickShield>
            {description && (
              <div className="text-xs text-muted-foreground">{description}</div>
            )}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => {
        const role = row.original;
        const exportRole: TableRowAction = {
          icon: <Download className="h-4 w-4" />,
          label: "Export role",
          onClick: () => downloadRoleAsJson(role),
        };
        // The row itself opens the role, so there is no View here; Edit and
        // Delete exist only for custom roles.
        const actions: TableRowAction[] = role.predefined
          ? [exportRole]
          : [
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit role",
                permissions: { ac: ["update"] },
                onClick: () => router.push(`/settings/roles/${role.id}/edit`),
              },
              exportRole,
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete role",
                permissions: { ac: ["delete"] },
                variant: "destructive",
                onClick: () => setRoleToDelete(role),
              },
            ];
        return <TableRowActions actions={actions} itemName={role.name} />;
      },
    },
  ];

  return (
    <>
      <BulkActionsScope>
        <CollectionFilters>
          <FilterBar
            onClearFilters={
              nameFilter
                ? () => updateQueryParams({ name: null, page: "1" })
                : undefined
            }
            actions={headerAction}
            search={
              <SearchInput
                isLoading={isLoading}
                objectNamePlural="roles"
                searchFields={["name"]}
                paramName="name"
                className={filterSearchClass}
              />
            }
          />
        </CollectionFilters>

        {isLoadingError ? (
          <QueryLoadError
            title="Couldn't load your roles"
            onRetry={() => refetch()}
          />
        ) : (
          <>
            <BulkActions
              count={selectedRoles.length}
              noun="role"
              onClear={clearSelection}
              busy={bulkDelete.isPending || isFetchingAllMatching}
              selectAllMatching={{
                total: customRoleTotal,
                pageFullySelected:
                  selectableOnPage.length > 0 &&
                  selectedOnPage.length === selectableOnPage.length,
                active: allMatchingSelected,
                onSelectAll: () => setEscalatedFor(filterSignature),
                matchDescription: nameFilter
                  ? "match this search query"
                  : "can be deleted",
              }}
            >
              <PermissionButton
                permissions={{ ac: ["delete"] }}
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
              data={allRoles}
              onRowClick={(role, event) =>
                openRowOnPlainClick(event, () =>
                  router.push(`/settings/roles/${role.id}`),
                )
              }
              getRowId={(row) => row.id}
              rowSelection={effectiveRowSelection}
              onRowSelectionChange={onRowSelectionChange}
              isLoading={isLoading}
              manualPagination
              pagination={{
                pageIndex,
                pageSize,
                total,
              }}
              onPaginationChange={setPagination}
              hasActiveFilters={Boolean(nameFilter)}
              onClearFilters={() =>
                updateQueryParams({
                  name: null,
                  page: "1",
                })
              }
              emptyMessage="No roles found"
              hideSelectedCount
            />

            {bulkDeleteOpen && (
              <DeleteConfirmDialog
                open={bulkDeleteOpen}
                onOpenChange={setBulkDeleteOpen}
                title="Delete roles"
                description={`Delete ${selectedRoles.length} ${
                  selectedRoles.length === 1 ? "role" : "roles"
                }? Members holding them fall back to the default role.`}
                isPending={bulkDelete.isPending}
                onConfirm={() => {
                  bulkDelete.mutate(selectedRoles, {
                    onSuccess: (outcome) => {
                      reportBulkOutcome({
                        outcome,
                        verb: "Deleted",
                        failureVerb: "delete",
                        noun: "role",
                      });
                      setBulkDeleteOpen(false);
                      if (outcome.failed.length === 0) clearSelection();
                    },
                  });
                }}
                confirmLabel="Delete roles"
                pendingLabel="Deleting..."
              />
            )}
          </>
        )}
      </BulkActionsScope>

      <DeleteConfirmDialog
        open={!!roleToDelete}
        onOpenChange={(open) => {
          if (!open) setRoleToDelete(null);
        }}
        title="Delete Role"
        description={`Are you sure you want to delete the role "${roleToDelete?.name ?? ""}"? This action cannot be undone.`}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!roleToDelete) return;
          deleteMutation.mutate(roleToDelete.id, {
            onSuccess: (deleted) => {
              if (deleted) setRoleToDelete(null);
            },
          });
        }}
      />
    </>
  );
}
