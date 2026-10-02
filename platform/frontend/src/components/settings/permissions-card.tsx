// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { resourceCategories } from "@archestra/shared";
import { PermissionExplorer } from "@/components/permission-explorer";
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { usePermissionSources } from "@/lib/auth/permission-sources.query";
import { formatRoleName } from "@/lib/utils/role";

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
  const groups = Object.entries(resourceCategories)
    .map(([category, resources]) => ({
      category,
      resources: resources.filter(
        (resource) => (permissions?.[resource]?.length ?? 0) > 0,
      ),
    }))
    .filter((group) => group.resources.length);
  const total = groups.reduce((sum, group) => sum + group.resources.length, 0);
  const roles = [
    ...new Set(sources.map((source) => formatRoleName(source.role))),
  ];
  return (
    <SettingsBlock
      title="Your permissions"
      description={`Permissions from your direct roles and team memberships. ${total} ${total === 1 ? "resource" : "resources"} across ${groups.length} ${groups.length === 1 ? "category" : "categories"}.`}
    >
      {total ? (
        <div className="space-y-4">
          {roles.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>From</span>
              {roles.map((role) => (
                <span
                  key={role}
                  className="rounded bg-muted px-2 py-1 text-foreground"
                >
                  {role}
                </span>
              ))}
              <span>Focus a permission to see its source.</span>
            </div>
          )}
          <PermissionExplorer
            permissions={permissions ?? {}}
            sources={sources}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your roles and teams do not provide access to any resources.
        </p>
      )}
    </SettingsBlock>
  );
}
