import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import { isForeignKeyConstraintError } from "@/utils/db";

/**
 * Internal MCP catalog RBAC helpers. Catalog items follow the 3-tier scope
 * model (`personal`/`team`/`org`), refined by a per-team access level: a scoped
 * team holds either `use` (discover, self-install, resolve through shared
 * installs) or `write` (`use` plus modifying the definition).
 *
 * The catalog's full-admin bypass is `update` on every registry entry — a
 * grant at `*` — which is what the retired `mcpServerInstallation:admin` role
 * action became. A `write` team grants modification to its members. Team
 * membership roles govern team administration, not access to the resources
 * shared with it.
 */
interface McpCatalogPermissionChecker {
  /** Holds `update` on every registry entry — bypasses scope restrictions. */
  isAdmin: boolean;
}

/** Fetch the user's catalog-relevant permissions once for a request. */
export async function getMcpCatalogPermissionChecker(params: {
  userId: string;
  organizationId: string;
}): Promise<McpCatalogPermissionChecker> {
  return { isAdmin: await isMcpInstallationAdmin(params) };
}

/**
 * Whether the caller administers every MCP installation and registry entry:
 * `update` on the registry at `*`. The upgrade converted each holder of the
 * retired `mcpServerInstallation:admin` role action into exactly this grant.
 */
export async function isMcpInstallationAdmin(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return ResourcePermissions.allows({
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "mcpRegistry",
    scope: "*",
    action: "update",
  });
}

/**
 * Run a catalog write, converting an `mcp_catalog_team` foreign-key violation —
 * a team deleted between {@link assertMcpCatalogTeams} and the insert — into a
 * clean 400.
 */
export async function withCatalogTeamFkErrorMapped<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      throw new ApiError(
        400,
        "One or more of the selected teams no longer exist",
      );
    }
    throw error;
  }
}
