"use client";

import { type Action, allAvailableActions, type Resource } from "@shared";
import { Plus, Shield, Trash2, Users } from "lucide-react";
import { useState } from "react";
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
import {
  useCreateRole,
  useDeleteRole,
  useRoles,
  useUpdateRole,
} from "@/lib/role.query";
import { RolePermissionBuilder } from "./role-permission-builder";

export function RolesList() {
  const { data: roles, isLoading } = useRoles();
  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const deleteMutation = useDeleteRole();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [selectedRole, setSelectedRole] = useState<any | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<any | null>(null);

  // Form state
  const [roleName, setRoleName] = useState("");
  const [permissions, setPermissions] = useState<
    Partial<Record<Resource, Action[]>>
  >({});

  const handleCreateRole = () => {
    if (!roleName.trim()) {
      toast.error("Role name is required");
      return;
    }

    if (Object.keys(permissions).length === 0) {
      toast.error("At least one permission must be granted");
      return;
    }

    createMutation.mutate(
      {
        name: roleName,
        permissions: permissions as Record<string, Action[]>,
      },
      {
        onSuccess: () => {
          setCreateDialogOpen(false);
          setRoleName("");
          setPermissions({});
          toast.success("Role created successfully");
        },
        onError: (error: Error) => {
          toast.error(error.message || "Failed to create role");
        },
      },
    );
  };

  const handleEditRole = () => {
    if (!selectedRole) return;

    if (!roleName.trim()) {
      toast.error("Role name is required");
      return;
    }

    if (Object.keys(permissions).length === 0) {
      toast.error("At least one permission must be granted");
      return;
    }

    updateMutation.mutate(
      {
        roleId: selectedRole.id,
        data: {
          name: roleName,
          permissions: permissions as Record<string, Action[]>,
        },
      },
      {
        onSuccess: () => {
          setEditDialogOpen(false);
          setSelectedRole(null);
          setRoleName("");
          setPermissions({});
          toast.success("Role updated successfully");
        },
        onError: (error: Error) => {
          toast.error(error.message || "Failed to update role");
        },
      },
    );
  };

  const handleDeleteRole = () => {
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
  };

  const openEditDialog = (role: any) => {
    setSelectedRole(role);
    setRoleName(role.name);
    setPermissions(role.permissions || {});
    setEditDialogOpen(true);
  };

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

  // Separate predefined and custom roles
  const predefinedRoles = roles?.filter((role) => !role.isCustom) || [];
  const customRoles = roles?.filter((role) => role.isCustom) || [];

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Roles & Permissions</CardTitle>
              <CardDescription>
                Manage roles and their permissions. Custom roles can be created
                with specific permission sets.
              </CardDescription>
            </div>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create Custom Role
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Predefined Roles */}
          {predefinedRoles.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
                Predefined Roles
              </h3>
              <div className="space-y-3">
                {predefinedRoles.map((role) => (
                  <div
                    key={role.id}
                    className="flex items-center justify-between rounded-lg border bg-muted/30 p-4"
                  >
                    <div className="flex items-center gap-3">
                      <Shield className="h-5 w-5 text-primary" />
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold capitalize">
                            {role.name}
                          </h4>
                          <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                            System
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <Users className="h-3 w-3" />
                          <span>
                            {role.memberCount} member
                            {role.memberCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Cannot be modified
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Custom Roles */}
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
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <Users className="h-3 w-3" />
                          <span>
                            {role.memberCount} member
                            {role.memberCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openEditDialog(role)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRoleToDelete(role);
                          setDeleteDialogOpen(true);
                        }}
                        disabled={role.memberCount > 0}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Create Role Dialog */}
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
                permissions={permissions}
                onChange={setPermissions}
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
                setPermissions({});
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

      {/* Edit Role Dialog */}
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
                permissions={permissions}
                onChange={setPermissions}
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
                setPermissions({});
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

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
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
