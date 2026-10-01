import { userHasPermission } from "@/auth/utils";
import { ApiError } from "@/types";

/**
 * A self-hosted MCP server's custom deployment YAML sets its whole pod spec —
 * service account, security context, volumes — so writing it needs
 * `mcpAdvancedSettings:update` on top of the registry permission that gates
 * the rest of the catalog item.
 *
 * @param params.current - The stored YAML. When the requested value matches it,
 *   nothing changes and no permission is needed.
 */
export async function assertCanWriteMcpDeploymentYaml(params: {
  userId: string;
  organizationId: string;
  requested: string | null | undefined;
  current?: string | null;
}): Promise<void> {
  if (params.requested === undefined) return;
  if ((params.requested || null) === (params.current || null)) return;

  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "mcpAdvancedSettings",
    "update",
  );
  if (!allowed) {
    throw new ApiError(
      403,
      "Changing the Kubernetes deployment YAML requires the mcpAdvancedSettings:update permission.",
    );
  }
}
