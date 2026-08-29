"use client";

import {
  type archestraApiTypes,
  type Permissions,
  type PredefinedRoleName,
  roleDescriptions,
} from "@archestra/shared";

import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { Copy, Download, Eye, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSetSettingsAction } from "@/app/settings/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { RoleTypeIcon } from "@/components/role-type-icon";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  useAllMatchingRoles,
  useBulkDeleteRoles,
  useCreateRole,
  useDeleteRole,
  useRole,
  useRolesPaginated,
  useUpdateRole,
} from "@/lib/role.query";
import { downloadRoleAsJson } from "./role-export";
import { RolePermissionBuilder } from "./role-permission-builder.ee";

type Role = archestraApiTypes.GetRoleResponses["200"];

/**
 * Enterprise Edition roles list with custom role management.
 * Shows both predefined roles (read-only) and custom roles (CRUD).
 */
export function RolesList({ headerAction }: { headerAction?: ReactNode }) {
  // The permission builder disables what the author cannot grant — the same
  // subset rule the server enforces on create/update.
  const { data: authorPermissions } = useAllPermissions();
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
  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
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

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const editRoleId = searchParams.get("edit");
  const { data: editRoleFromUrl } = useRole(editRoleId ?? undefined);
  const {
    entity: selectedRole,
    open: openEditRole,
    close: closeEditDialog,
  } = useDialogUrlParam<Role>({
    paramName: "edit",
    entityFromUrl: editRoleFromUrl ?? null,
  });

  const viewRoleId = searchParams.get("view");
  const { data: viewRoleFromUrl } = useRole(viewRoleId ?? undefined);
  const {
    entity: viewPermissionsRole,
    open: openViewPermissionsDialog,
    close: closeViewPermissionsDialog,
  } = useDialogUrlParam<Role>({
    paramName: "view",
    entityFromUrl: viewRoleFromUrl ?? null,
  });

  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);

  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [permission, setPermission] = useState<Permissions>({});

  // Seed the edit form whenever a role's edit dialog opens, whether from a
  // row click or a deep-linked URL.
  useEffect(() => {
    if (selectedRole) {
      setRoleName(selectedRole.name);
      setRoleDescription(selectedRole.description ?? "");
      setPermission(selectedRole.permission);
    }
  }, [selectedRole]);

  // Cancel any pending `?edit=<id>` deep link before opening create, or the
  // by-id fetch could land and overwrite the shared create form state.
  const handleCreateOpen = useCallback(() => {
    closeEditDialog();
    setCreateDialogOpen(true);
  }, [closeEditDialog]);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ ac: ["create"] }}
        onClick={handleCreateOpen}
      >
        <Plus className="h-4 w-4" />
        Create Custom Role
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton, handleCreateOpen]);

  const handleCreateRole = useCallback(() => {
    if (!roleName.trim()) {
      toast.error("Role name is required");
      return;
    }

    if (Object.keys(permission).length === 0) {
      toast.error("At least one permission must be granted");
      return;
    }

    createMutation.mutate(
      // Cast needed: shared Permissions type includes "team-admin" before API types are regenerated
      {
        name: roleName,
        description: roleDescription || undefined,
        permission,
      } as Parameters<typeof createMutation.mutate>[0],
      {
        onSuccess: () => {
          setCreateDialogOpen(false);
          setRoleName("");
          setRoleDescription("");
          setPermission({});
          toast.success("Role created successfully");
        },
        onError: (error: Error) => {
          toast.error(error.message || "Failed to create role");
        },
      },
    );
  }, [roleDescription, roleName, permission, createMutation]);

  const handleEditRole = useCallback(() => {
    if (!selectedRole) return;

    if (!roleName.trim()) {
      toast.error("Role name is required");
      return;
    }

    if (Object.keys(permission).length === 0) {
      toast.error("At least one permission must be granted");
      return;
    }

    updateMutation.mutate(
      // Cast needed: shared Permissions type includes "team-admin" before API types are regenerated
      {
        roleId: selectedRole.id,
        data: {
          name: roleName,
          description: roleDescription || undefined,
          permission,
        },
      } as Parameters<typeof updateMutation.mutate>[0],
      {
        onSuccess: () => {
          closeEditDialog();
          setRoleName("");
          setRoleDescription("");
          setPermission({});
          toast.success("Role updated successfully");
        },
        onError: (error: Error) => {
          toast.error(error.message || "Failed to update role");
        },
      },
    );
  }, [
    selectedRole,
    roleDescription,
    roleName,
    permission,
    updateMutation,
    closeEditDialog,
  ]);

  const handleDeleteRole = useCallback(() => {
    if (roleToDelete) {
      deleteMutation.mutate(roleToDelete.id, {
        onSuccess: () => {
          setDeleteDialogOpen(false);
          setRoleToDelete(null);
          toast.success("Role deleted successfully");
        },
        onError: (error: Error) => {
          toast.error(error.message || "Failed to delete role");
        },
      });
    }
  }, [roleToDelete, deleteMutation]);

  const openDuplicateDialog = useCallback(
    (role: Role) => {
      // Cancel a pending deep-linked edit so its by-id fetch can't overwrite
      // the duplicate form state once it resolves.
      closeEditDialog();
      // Role names must be lowercase letters, numbers, and underscores only
      // (validated by better-auth at create time). Make sure the suggested
      // copy name follows the same rule.
      const sanitized = role.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      setRoleName(`${sanitized}_copy`);
      setRoleDescription(
        role.description ??
          (role.predefined
            ? (roleDescriptions[role.name as PredefinedRoleName] ?? "")
            : ""),
      );
      setPermission(role.permission);
      setCreateDialogOpen(true);
    },
    [closeEditDialog],
  );

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
            <div className="font-medium capitalize">{role.name}</div>
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

        if (role.predefined) {
          const actions: TableRowAction[] = [
            {
              icon: <Eye className="h-4 w-4" />,
              label: "View permissions",
              onClick: () => openViewPermissionsDialog(role),
            },
            {
              icon: <Download className="h-4 w-4" />,
              label: "Export role",
              onClick: () => downloadRoleAsJson(role),
            },
            {
              icon: <Copy className="h-4 w-4" />,
              label: "Duplicate as custom role",
              permissions: { ac: ["create"] },
              onClick: () => openDuplicateDialog(role),
            },
          ];
          return <TableRowActions actions={actions} />;
        }

        const actions: TableRowAction[] = [
          {
            icon: <Pencil className="h-4 w-4" />,
            label: "Edit role",
            permissions: { ac: ["update"] },
            onClick: () => openEditRole(role),
          },
          {
            icon: <Download className="h-4 w-4" />,
            label: "Export role",
            onClick: () => downloadRoleAsJson(role),
          },
          {
            icon: <Copy className="h-4 w-4" />,
            label: "Duplicate role",
            permissions: { ac: ["create"] },
            onClick: () => openDuplicateDialog(role),
          },
          {
            icon: <Trash2 className="h-4 w-4" />,
            label: "Delete role",
            permissions: { ac: ["delete"] },
            variant: "destructive",
            onClick: () => {
              setRoleToDelete(role);
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
          <FilterBar
            onClearFilters={
              nameFilter
                ? () => updateQueryParams({ name: null, page: "1" })
                : undefined
            }
            actions={headerAction}
          >
            <SearchInput
              isLoading={isLoading}
              objectNamePlural="roles"
              searchFields={["name"]}
              paramName="name"
              className={filterSearchClass}
            />
          </FilterBar>
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

      {/* Create Role Dialog */}
      <FormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        title="Create Custom Role"
        description="Create a new custom role with specific permissions. Users with this role will only have access to the selected resources and actions."
        size="large"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleCreateRole}
        >
          <DialogBody className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label htmlFor="name">Role Name *</Label>
              <Input
                id="name"
                placeholder="e.g., Developer, Viewer, Editor"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="What this role is used for"
                value={roleDescription}
                onChange={(e) => setRoleDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Permissions *</Label>
              <RolePermissionBuilder
                permission={permission}
                onChange={setPermission}
                userPermissions={authorPermissions ?? {}}
              />
            </div>
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreateDialogOpen(false);
                setRoleName("");
                setRoleDescription("");
                setPermission({});
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create Role"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      {/* Edit Role Dialog */}
      <FormDialog
        open={!!selectedRole}
        onOpenChange={(open) => {
          if (!open) {
            closeEditDialog();
          }
        }}
        title="Edit Role"
        description="Modify the role name and permissions. Changes will affect all users with this role."
        size="large"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleEditRole}
        >
          <DialogBody className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Role Name *</Label>
              <Input
                id="edit-name"
                placeholder="e.g., Developer, Viewer, Editor"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                placeholder="What this role is used for"
                value={roleDescription}
                onChange={(e) => setRoleDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Permissions *</Label>
              <RolePermissionBuilder
                permission={permission}
                onChange={setPermission}
                userPermissions={authorPermissions ?? {}}
              />
            </div>
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                closeEditDialog();
                setRoleName("");
                setRoleDescription("");
                setPermission({});
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <FormDialog
        open={!!viewPermissionsRole}
        onOpenChange={(open) => {
          if (!open) {
            closeViewPermissionsDialog();
          }
        }}
        title="View Predefined Role"
        description="This is a predefined role. It cannot be modified."
        size="large"
      >
        {viewPermissionsRole && (
          <DialogBody className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label htmlFor="view-name">Role Name</Label>
              <Input
                id="view-name"
                value={viewPermissionsRole.name}
                disabled
                className="capitalize"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="view-description">Description</Label>
              <Textarea
                id="view-description"
                value={
                  viewPermissionsRole.description ||
                  roleDescriptions[
                    viewPermissionsRole.name as PredefinedRoleName
                  ] ||
                  ""
                }
                disabled
              />
            </div>
            <div className="space-y-2">
              <Label>Permissions</Label>
              <RolePermissionBuilder
                permission={viewPermissionsRole.permission}
                onChange={() => {}}
                userPermissions={viewPermissionsRole.permission}
                readOnly
                readOnlyTooltip="This is a predefined role. Permissions cannot be modified."
              />
            </div>
          </DialogBody>
        )}
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={closeViewPermissionsDialog}
          >
            Close
          </Button>
        </DialogStickyFooter>
      </FormDialog>

      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setRoleToDelete(null);
          }
        }}
        title="Delete Role"
        description={`Are you sure you want to delete the role "${roleToDelete?.name ?? ""}"? This action cannot be undone.`}
        isPending={deleteMutation.isPending}
        onConfirm={handleDeleteRole}
      />
    </>
  );
}
