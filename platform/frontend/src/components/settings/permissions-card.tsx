// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { resourceCategories } from "@archestra/shared";
import { PermissionExplorer } from "@/components/permission-explorer";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { usePermissionSources } from "@/lib/auth/permission-sources.query";

export function PermissionsCard() {
  const {
    data: permissions,
    isLoading,
    isError,
    refetch,
  } = useAllPermissions();
  const { data: sources = [] } = usePermissionSources();
  if (isLoading)
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (isError)
    return (
      <QueryLoadError
        title="Couldn't load your permissions"
        onRetry={() => {
          void refetch();
        }}
      />
    );
  const hasPermissions = Object.values(resourceCategories)
    .flat()
    .some((resource) => (permissions?.[resource]?.length ?? 0) > 0);
  return hasPermissions ? (
    <PermissionExplorer permissions={permissions ?? {}} sources={sources} />
  ) : (
    <p className="text-sm text-muted-foreground">
      Your roles and teams do not provide access to any resources.
    </p>
  );
}
