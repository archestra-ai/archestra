"use client";

import type { archestraApiTypes, Permissions } from "@shared";
import { allAvailableActions } from "@shared/access-control";
import { Plus, Shield, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { PredefinedRoles } from "@/components/roles/predefined-roles";
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
import {
  useCreateRole,
  useDeleteRole,
  useRoles,
  useUpdateRole,
} from "@/lib/role.query";
import { RolePermissionBuilder } from "./role-permission-builder.ee";

type Role = archestraApiTypes.GetRoleResponses["200"];

/**
 * Enterprise Edition roles list with custom role management.
 * Shows both predefined roles (read-only) and custom roles (CRUD).
 */
export function RolesList() {
  const { data: roles, isLoading } = useRoles();
  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const deleteMutation = useDeleteRole();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);

  const [roleName, setRoleName] = useState("");
  const [permission, setPermission] = useState<Permissions>({});

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
      { name: roleName, permission },
      {
        onSuccess: () => {
          setCreateDialogOpen(false);
          setRoleName("");
          setPermission({});
          toast.success("Role created successfully");
        },
        onError: (error: Error) => {
          toast.error(error.message || "Failed to create role");
        },
      },
    );
  }, [roleName, permission, createMutation]);

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
      {
        roleId: selectedRole.id,
        data: { name: roleName, permission },
      },
      {
        onSuccess: () => {
          setEditDialogOpen(false);
          setSelectedRole(null);
          setRoleName("");
          setPermission({});
          toast.success("Role updated successfully");
        },
        onError: (error: Error) => {
          toast.error(error.message || "Failed to update role");
        },
      },
    );
  }, [selectedRole, roleName, permission, updateMutation]);

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
    setPermission(role.permission);
    setEditDialogOpen(true);
  }, []);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>Loading roles...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const predefinedRoles = roles?.filter((role) => role.predefined) || [];
  const customRoles = roles?.filter((role) => !role.predefined) || [];

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Roles & Permissions</CardTitle>
              <CardDescription className="pt-2">
                Manage roles and their permissions. Custom roles can be created
                with specific permission sets.
                <br />
                See documentation{" "}
                <a
                  href="https://archestra.ai/docs/platform-access-control"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline inline-flex items-center gap-1 block"
                >
                  here
                </a>{" "}
                for more information, including a complete list of available
                permissions.
              </CardDescription>
            </div>
            <PermissionButton
              permissions={{ ac: ["create"] }}
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create Custom Role
            </PermissionButton>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <PredefinedRoles predefinedRoles={predefinedRoles} />
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
              Custom Roles
            </h3>
            {customRoles.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
                <Shield className="mb-4 h-12 w-12 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No custom roles yet. Create your first custom role to get
                  started.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {customRoles.map((role) => (
                  <div
                    key={role.id}
                    className="flex items-center justify-between rounded-lg border p-4"
                  >
                    <div className="flex items-center gap-3">
                      <Shield className="h-5 w-5" />
                      <div>
                        <h4 className="font-semibold">{role.name}</h4>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <PermissionButton
                        permissions={{ ac: ["update"] }}
                        variant="outline"
                        size="sm"
                        onClick={() => openEditDialog(role)}
                      >
                        Edit
                      </PermissionButton>
                      <PermissionButton
                        permissions={{ ac: ["delete"] }}
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRoleToDelete(role);
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
          </div>
        </CardContent>
      </Card>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Custom Role</DialogTitle>
            <DialogDescription>
              Create a new custom role with specific permissions. Users with
              this role will only have access to the selected resources and
              actions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
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
              <Label>Permissions *</Label>
              <RolePermissionBuilder
                permission={permission}
                onChange={setPermission}
                userPermissions={allAvailableActions}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateDialogOpen(false);
                setRoleName("");
                setPermission({});
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateRole}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create Role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Role</DialogTitle>
            <DialogDescription>
              Modify the role name and permissions. Changes will affect all
              users with this role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
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
              <Label>Permissions *</Label>
              <RolePermissionBuilder
                permission={permission}
                onChange={setPermission}
                userPermissions={allAvailableActions}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditDialogOpen(false);
                setSelectedRole(null);
                setRoleName("");
                setPermission({});
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEditRole}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Role</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the role "{roleToDelete?.name}"?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setRoleToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteRole}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
