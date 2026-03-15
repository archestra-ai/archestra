"use client";

import {
  type archestraApiTypes,
  type Permissions,
  type PredefinedRoleName,
  roleDescriptions,
} from "@shared";
import { allAvailableActions } from "@shared/access-control";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSetSettingsAction } from "@/app/settings/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { RoleTypeIcon } from "@/components/role-type-icon";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
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
import {
  useCreateRole,
  useDeleteRole,
  useRolesPaginated,
  useUpdateRole,
} from "@/lib/role.query";
import { useDataTableQueryParams } from "@/lib/use-data-table-query-params";
import { RolePermissionBuilder } from "./role-permission-builder.ee";

type Role = archestraApiTypes.GetRoleResponses["200"];

/**
 * Enterprise Edition roles list with custom role management.
 * Shows both predefined roles (read-only) and custom roles (CRUD).
 */
export function RolesList() {
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
  const { data: rolesResponse, isLoading } = useRolesPaginated({
    limit: pageSize,
    offset,
    name: nameFilter,
  });
  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const deleteMutation = useDeleteRole();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [viewPermissionsDialogOpen, setViewPermissionsDialogOpen] =
    useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [viewPermissionsRole, setViewPermissionsRole] = useState<Role | null>(
    null,
  );
  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);

  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [permission, setPermission] = useState<Permissions>({});

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ ac: ["create"] }}
        onClick={() => setCreateDialogOpen(true)}
      >
        <Plus className="mr-2 h-4 w-4" />
        Create Custom Role
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton]);

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
          setEditDialogOpen(false);
          setSelectedRole(null);
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
  }, [selectedRole, roleDescription, roleName, permission, updateMutation]);

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

  const openEditDialog = useCallback((role: Role) => {
    setSelectedRole(role);
    setRoleName(role.name);
    setRoleDescription(role.description ?? "");
    setPermission(role.permission);
    setEditDialogOpen(true);
  }, []);

  // Sort: predefined first, then custom
  const allRoles = [...(rolesResponse?.data ?? [])].sort((a, b) => {
    if (a.predefined && !b.predefined) return -1;
    if (!a.predefined && b.predefined) return 1;
    return 0;
  });
  const total = rolesResponse?.pagination.total ?? 0;

  const columns: ColumnDef<Role>[] = [
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
              onClick: () => {
                setViewPermissionsRole(role);
                setViewPermissionsDialogOpen(true);
              },
            },
          ];
          return <TableRowActions actions={actions} />;
        }

        const actions: TableRowAction[] = [
          {
            icon: <Pencil className="h-4 w-4" />,
            label: "Edit role",
            permissions: { ac: ["update"] },
            onClick: () => openEditDialog(role),
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
      <div className="space-y-6">
        <SearchInput
          objectNamePlural="roles"
          searchFields={["name"]}
          paramName="name"
        />

        <DataTable
          columns={columns}
          data={allRoles}
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
      </div>

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
                userPermissions={allAvailableActions}
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
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
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
                userPermissions={allAvailableActions}
              />
            </div>
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditDialogOpen(false);
                setSelectedRole(null);
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
        open={viewPermissionsDialogOpen}
        onOpenChange={(open) => {
          setViewPermissionsDialogOpen(open);
          if (!open) {
            setViewPermissionsRole(null);
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
            onClick={() => {
              setViewPermissionsDialogOpen(false);
              setViewPermissionsRole(null);
            }}
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
