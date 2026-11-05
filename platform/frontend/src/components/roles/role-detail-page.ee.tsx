// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { type PredefinedRoleName, roleDescriptions } from "@archestra/shared";
import { Copy, Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { RoleTypeIcon } from "@/components/roles/role-type-icon";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/components/settings/settings-layout.context";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDeleteRole, useRole } from "@/lib/role.query";
import { PermissionList } from "./permission-list.ee";
import { downloadRoleAsJson } from "./role-export";
import { ROLE_PERMISSIONS_INTRO } from "./role-form.ee";
import { RoleUsage } from "./role-usage.ee";

/**
 * A role, read-only: its permissions, and who holds it. Editing is a page of
 * its own; a built-in role has none, so its Edit is disabled and the way to
 * change it is a new role started from it.
 */
export function RoleDetailPage({ roleId }: { roleId: string }) {
  const router = useRouter();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const { data: role, isPending, isLoadingError, refetch } = useRole(roleId);
  const deleteMutation = useDeleteRole();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { data: canCreate } = useHasPermissions({ ac: ["create"] });
  const { data: canDelete } = useHasPermissions({ ac: ["delete"] });
  const href = `/settings/roles/${roleId}`;

  useEffect(() => {
    setPageHeader({
      title: role ? (
        <span className="block min-w-0 truncate capitalize">{role.name}</span>
      ) : (
        "Role"
      ),
      documentTitle: role?.name ?? "Role",
      description: role
        ? role.description || roleDescriptions[role.name as PredefinedRoleName]
        : undefined,
      icon: role ? (
        <RoleTypeIcon predefined={role.predefined} withTooltip />
      ) : undefined,
      backLink: (
        <PageBackLink href="/settings/roles">Back to roles</PageBackLink>
      ),
    });
    return () => setPageHeader(null);
  }, [setPageHeader, role]);

  useEffect(() => {
    if (!role) {
      setActionButton(null);
      return;
    }
    setActionButton(
      <div className="flex shrink-0 items-center gap-2">
        {role.predefined ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button size="sm" disabled>
                  <Pencil className="size-4" />
                  <span className="max-sm:sr-only">Edit</span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Built-in roles can't be changed. Start a new role from this one
              instead.
            </TooltipContent>
          </Tooltip>
        ) : (
          <PermissionButton
            permissions={{ ac: ["update"] }}
            size="sm"
            onClick={() => router.push(`${href}/edit`)}
          >
            <Pencil className="size-4" />
            <span className="max-sm:sr-only">Edit</span>
          </PermissionButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-sm">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canCreate && (
              <DropdownMenuItem asChild>
                <Link href={`/settings/roles/new?from=${role.id}`}>
                  <Copy className="size-4" />
                  New role from this one
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => downloadRoleAsJson(role)}>
              <Download className="size-4" />
              Export as JSON
            </DropdownMenuItem>
            {!role.predefined && canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete role
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>,
    );
    return () => setActionButton(null);
  }, [setActionButton, role, router, href, canCreate, canDelete]);

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load the role"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!role) {
    return (
      <p className="text-sm text-muted-foreground">
        This role doesn't exist, or was deleted.
      </p>
    );
  }
  return (
    <>
      <SettingsSectionGroup>
        <SettingsSection
          title="Usage"
          description="Who holds this role. Assign it from a user's row in Users, a team's inherited roles, or a service account."
        >
          <RoleUsage role={role} />
        </SettingsSection>
        <SettingsSection
          title="Permissions"
          description={ROLE_PERMISSIONS_INTRO}
          stickyLabel
        >
          <PermissionList permissions={role.permission} />
        </SettingsSection>
      </SettingsSectionGroup>
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete role"
        description={`Delete "${role.name}"? Members holding it fall back to the default role.`}
        isPending={deleteMutation.isPending}
        onConfirm={() =>
          deleteMutation.mutate(role.id, {
            onSuccess: (deleted) => {
              if (deleted) router.push("/settings/roles");
            },
          })
        }
      />
    </>
  );
}
