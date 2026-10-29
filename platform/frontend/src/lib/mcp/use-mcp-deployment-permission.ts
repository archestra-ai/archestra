"use client";
import { useScopedCapabilities } from "@/lib/auth/auth.query";

/** Whether the caller may view and change this entry's deployment settings. */
export function useMcpDeploymentPermission(catalogId?: string) {
  const query = useScopedCapabilities();
  return {
    ...query,
    data: !!query.data?.some(
      (grant) =>
        grant.resource === "mcpRegistry" &&
        grant.action === "configure-deployment-spec" &&
        (grant.scope === "*" || grant.scope === (catalogId ?? "*")),
    ),
  };
}
