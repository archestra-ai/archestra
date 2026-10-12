import { isBuiltInCatalogId } from "@archestra/shared";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import { isServiceAccountUserId } from "@/auth/service-account-user-id";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import type { PrincipalSource } from "@/models/resource-permission-subject";

/** The identity an agent's tools are listed to or run for. */
export interface CatalogAccessCaller {
  userId?: string | null;
  organizationId?: string | null;
  /** The request's memoized principal, so the lookup adds no role queries. */
  lookups?: PrincipalSource;
}

/**
 * Catalog access for the caller of an agent's tools.
 *
 * Assigning a tool to an agent does not share the tool's MCP server: a caller
 * who can use the agent reaches an assigned tool only when they can also see
 * its catalog item. Without this, sharing an agent with the organization would
 * hand every member the tools — and the shared or pinned credentials — of a
 * server scoped to one team.
 *
 * Returns the catalog ids a real user may reach (all of them for registry
 * admins, matching the catalog list), or `null` when the caller is not a user:
 * team and organization tokens, the internal `system` user, and service
 * accounts are configured by an administrator and keep the agent's full
 * assigned tool set.
 */
export async function getCallerAccessibleCatalogIds(
  caller: CatalogAccessCaller,
): Promise<ReadonlySet<string> | null> {
  const { userId, organizationId, lookups } = caller;
  if (
    !userId ||
    !organizationId ||
    userId === "system" ||
    isServiceAccountUserId(userId)
  ) {
    return null;
  }
  const isAdmin = await isMcpInstallationAdmin({
    userId,
    organizationId,
    lookups,
  });
  return new Set(
    await McpCatalogTeamModel.getAccessibleCatalogIds({
      userId,
      isAdmin,
      organizationId,
      lookups,
    }),
  );
}

/**
 * Whether a tool row is within the caller's catalog access. Rows without a
 * catalog (delegations, proxy-discovered tools) and the built-in catalogs are
 * governed elsewhere and always pass; so does every row when `accessible` is
 * `null` (a caller {@link getCallerAccessibleCatalogIds} does not scope).
 */
export function isToolCatalogAccessible(
  tool: { catalogId: string | null },
  accessible: ReadonlySet<string> | null,
): boolean {
  return (
    accessible === null ||
    tool.catalogId === null ||
    isBuiltInCatalogId(tool.catalogId) ||
    accessible.has(tool.catalogId)
  );
}

/** Drop the rows outside the caller's catalog access. */
export async function filterToolsByCallerCatalogAccess<
  T extends { catalogId: string | null },
>(tools: T[], caller: CatalogAccessCaller): Promise<T[]> {
  const accessible = await getCallerAccessibleCatalogIds(caller);
  return accessible === null
    ? tools
    : tools.filter((tool) => isToolCatalogAccessible(tool, accessible));
}
