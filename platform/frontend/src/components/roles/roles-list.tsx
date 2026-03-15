"use client";

import {
  type archestraApiTypes,
  type Permissions,
  type PredefinedRoleName,
  type Resource,
  resourceCategories,
  resourceLabels,
  roleDescriptions,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRolesPaginated } from "@/lib/role.query";
import { useDataTableQueryParams } from "@/lib/use-data-table-query-params";
import { useSetSettingsAction } from "@/app/settings/layout";

type Role = archestraApiTypes.GetRoleResponses["200"];

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
  const [viewPermissionsRole, setViewPermissionsRole] = useState<Role | null>(
    null,
  );

  useEffect(() => {
    setActionButton(null);
    return () => setActionButton(null);
  }, [setActionButton]);

  const allRoles = rolesResponse?.data ?? [];
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
              <Shield className="h-4 w-4 text-muted-foreground" />
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
              <div className="text-xs text-muted-foreground">
                {description}
              </div>
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
        const actions: TableRowAction[] = [
          {
            icon: <Eye className="h-4 w-4" />,
            label: "View permissions",
            onClick: () => setViewPermissionsRole(role),
          },
        ];
        return <TableRowActions actions={actions} />;
      },
    },
  ];

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <SearchInput
          placeholder="Search roles by name..."
          paramName="name"
          className="relative max-w-sm flex-1"
        />
      </div>

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

      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
          Custom Roles
        </h3>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
          <EnterpriseLicenseRequired featureName="Custom Roles" />
        </div>
      </div>

      <ViewPermissionsDialog
        role={viewPermissionsRole}
        open={!!viewPermissionsRole}
        onOpenChange={(open) => !open && setViewPermissionsRole(null)}
      />
    </>
  );
}

function ViewPermissionsDialog({
  role,
  open,
  onOpenChange,
}: {
  role: Role | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!role) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="capitalize">
            {role.name} Permissions
          </DialogTitle>
          <DialogDescription>
            {role.predefined
              ? "This is a predefined role. Permissions cannot be modified."
              : "Viewing permissions for this role."}
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <ReadOnlyPermissions permission={role.permission} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlyPermissions({ permission }: { permission: Permissions }) {
  const permissionEntries = Object.entries(permission) as [
    Resource,
    string[],
  ][];

  if (permissionEntries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No permissions configured.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {Object.entries(resourceCategories).map(([category, resources]) => {
        const categoryResources = resources.filter((r) => permission[r]);
        if (categoryResources.length === 0) return null;

        return (
          <div key={category} className="rounded-lg border p-4">
            <h4 className="font-semibold text-sm mb-3">{category}</h4>
            <div className="space-y-2">
              {categoryResources.map((resource) => {
                const actions = permission[resource] || [];
                return (
                  <div
                    key={resource}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-muted-foreground">
                      {resourceLabels[resource] || resource}
                    </span>
                    <div className="flex gap-1">
                      {actions.map((action) => (
                        <Badge
                          key={action}
                          variant="secondary"
                          className="text-xs capitalize"
                        >
                          {action}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
