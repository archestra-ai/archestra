"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
  type Permissions,
  type PredefinedRoleName,
  roleDescriptions,
} from "@shared";
import { allAvailableActions } from "@shared/access-control";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSetSettingsAction } from "@/app/settings/layout";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
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
  const { pageIndex, pageSize, offset, searchParams, setPagination } =
    useDataTableQueryParams();
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Shield
                className={`h-4 w-4 ${row.original.predefined ? "text-primary" : "text-muted-foreground"}`}
              />
            </TooltipTrigger>
            <TooltipContent>
              {row.original.predefined ? "Predefined" : "Custom"}
            </TooltipContent>
          </Tooltip>
        </div>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
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
          placeholder="Search roles by name..."
          paramName="name"
          className="relative max-w-sm"
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
        <DialogForm className="flex min-h-0 flex-1 flex-col" onSubmit={handleCreateRole}>
          <div className="min-h-0 flex-1 overflow-y-auto py-4 pr-2 -mr-2 space-y-4">
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
          </div>
          <DialogStickyFooter>
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
        <DialogForm className="flex min-h-0 flex-1 flex-col" onSubmit={handleEditRole}>
          <div className="min-h-0 flex-1 overflow-y-auto py-4 pr-2 -mr-2 space-y-4">
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
          </div>
          <DialogStickyFooter>
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

      {/* View Predefined Role Dialog (read-only) */}
      <Dialog
        open={viewPermissionsDialogOpen}
        onOpenChange={setViewPermissionsDialogOpen}
      >
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>View Predefined Role</DialogTitle>
            <DialogDescription>
              This is a predefined role. It cannot be modified.
            </DialogDescription>
          </DialogHeader>
          {viewPermissionsRole && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="view-name">Role Name</Label>
                <Input
                  id="view-name"
                  value={viewPermissionsRole.name}
                  readOnly
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
                  readOnly
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
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Role</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the role "{roleToDelete?.name}"?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleDeleteRole}>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDeleteDialogOpen(false);
                  setRoleToDelete(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete"}
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
