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
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Plus, Shield, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
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
import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";
import { RolePermissionBuilder } from "./role-permission-builder.ee";

type RoleData = archestraApiTypes.GetRolesResponses["200"]["data"][number];

/**
 * Enterprise Edition roles list with DataTable, search, and custom role management.
 */
export function RolesList() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // URL-driven state
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFilter = searchParams.get("search") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "createdAt"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  const sortBy = sortByFromUrl || "createdAt";
  const sortDirection = sortDirectionFromUrl || "desc";

  const { data: rolesResponse, isPending } = useRolesPaginated({
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    search: searchFilter || undefined,
  });

  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const deleteMutation = useDeleteRole();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [selectedRole, setSelectedRole] = useState<RoleData | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<RoleData | null>(null);

  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [permission, setPermission] = useState<Permissions>({});

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);

      const params = new URLSearchParams(searchParams.toString());
      if (newSorting.length > 0) {
        params.set("sortBy", newSorting[0].id);
        params.set("sortDirection", newSorting[0].desc ? "desc" : "asc");
      } else {
        params.delete("sortBy");
        params.delete("sortDirection");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [sorting, searchParams, router, pathname],
  );

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

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
        description: roleDescription.trim() || null,
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
  }, [roleName, roleDescription, permission, createMutation]);

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
          description: roleDescription.trim() || null,
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
  }, [selectedRole, roleName, roleDescription, permission, updateMutation]);

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

  const openEditDialog = useCallback((role: RoleData) => {
    setSelectedRole(role);
    setRoleName(role.name);
    setRoleDescription(role.description || "");
    setPermission(role.permission);
    setEditDialogOpen(true);
  }, []);

  const roles = rolesResponse?.data || [];
  const pagination = rolesResponse?.pagination;

  const columns: ColumnDef<RoleData>[] = [
    {
      id: "name",
      accessorKey: "name",
      size: 200,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const role = row.original;
        return (
          <div className="flex items-center gap-2">
            {role.predefined && (
              <Shield className="h-4 w-4 text-primary shrink-0" />
            )}
            <span className="font-medium capitalize">{role.name}</span>
          </div>
        );
      },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      size: 300,
      cell: ({ row }) => {
        const role = row.original;
        const description = role.predefined
          ? roleDescriptions[role.name as PredefinedRoleName] ||
            role.description
          : role.description;
        return (
          <span className="text-sm text-muted-foreground">
            {description || "-"}
          </span>
        );
      },
    },
    {
      id: "type",
      header: "Type",
      size: 120,
      cell: ({ row }) => {
        const role = row.original;
        return role.predefined ? (
          <Badge variant="secondary">Predefined</Badge>
        ) : (
          <Badge variant="outline">Custom</Badge>
        );
      },
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Created
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 120,
      enableHiding: false,
      cell: ({ row }) => {
        const role = row.original;
        if (role.predefined) {
          return <span className="text-xs text-muted-foreground">-</span>;
        }
        return (
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
        );
      },
    },
  ];

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title="Roles & Permissions"
        description={
          <p className="text-sm text-muted-foreground">
            Manage roles and their permissions. Custom roles can be created with
            specific permission sets.{" "}
            <a
              href={getDocsUrl(DocsPage.PlatformAccessControl)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Read more in the docs
            </a>
          </p>
        }
        actionButton={
          <PermissionButton
            permissions={{ ac: ["create"] }}
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Custom Role
          </PermissionButton>
        }
      >
        <div>
          <div className="mb-6">
            <SearchInput
              placeholder="Search roles by name or description..."
              paramName="search"
              className="relative max-w-md"
            />
          </div>

          {!roles || roles.length === 0 ? (
            <div className="text-muted-foreground">
              {searchFilter
                ? "No roles found matching your search"
                : "No roles found"}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={roles}
              sorting={sorting}
              onSortingChange={handleSortingChange}
              manualSorting={true}
              manualPagination={true}
              pagination={{
                pageIndex,
                pageSize,
                total: pagination?.total || 0,
              }}
              onPaginationChange={handlePaginationChange}
            />
          )}
        </div>

        {/* Create Dialog */}
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Custom Role</DialogTitle>
              <DialogDescription>
                Create a new custom role with specific permissions. Users with
                this role will only have access to the selected resources and
                actions.
              </DialogDescription>
            </DialogHeader>
            <DialogForm onSubmit={handleCreateRole}>
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
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="Describe what this role is for..."
                    value={roleDescription}
                    onChange={(e) => setRoleDescription(e.target.value)}
                    maxLength={500}
                    rows={2}
                  />
                  <p className="text-xs text-muted-foreground">
                    {roleDescription.length}/500 characters
                  </p>
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
              </DialogFooter>
            </DialogForm>
          </DialogContent>
        </Dialog>

        {/* Edit Dialog */}
        <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Role</DialogTitle>
              <DialogDescription>
                Modify the role name, description, and permissions. Changes will
                affect all users with this role.
              </DialogDescription>
            </DialogHeader>
            <DialogForm onSubmit={handleEditRole}>
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
                  <Label htmlFor="edit-description">Description</Label>
                  <Textarea
                    id="edit-description"
                    placeholder="Describe what this role is for..."
                    value={roleDescription}
                    onChange={(e) => setRoleDescription(e.target.value)}
                    maxLength={500}
                    rows={2}
                  />
                  <p className="text-xs text-muted-foreground">
                    {roleDescription.length}/500 characters
                  </p>
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
              </DialogFooter>
            </DialogForm>
          </DialogContent>
        </Dialog>

        {/* Delete Dialog */}
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
      </PageLayout>
    </LoadingWrapper>
  );
}

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}
