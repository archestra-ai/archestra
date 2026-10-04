"use client";
import { resourcePermissionPresets } from "@archestra/shared";
import { useScopedCapabilities } from "@/lib/auth/auth.query";
export function useMcpDeploymentPermission(catalogId?: string) {
  const query = useScopedCapabilities();
  return {
    ...query,
    data: resourcePermissionPresets.manage.actions.every((action) =>
      query.data?.some(
        (grant) =>
          grant.resource === "mcpRegistry" &&
          grant.action === action &&
          (grant.scope === "*" || grant.scope === (catalogId ?? "*")),
      ),
    ),
  };
}
