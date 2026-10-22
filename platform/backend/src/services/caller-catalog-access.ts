import { isBuiltInCatalogId } from "@archestra/shared";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import { isServiceAccountUserId } from "@/auth/service-account-user-id";
import { userHasPermission } from "@/auth/utils";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import type { PrincipalSource } from "@/models/resource-permission-subject";
import { SRE_CATALOG_ID } from "@/services/sre-agent/definition";

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
 * `accessible` holds the catalog ids a real user may reach (all of them for
 * registry admins, matching the catalog list), or is `null` when the caller is
 * not a user: team and organization tokens, the internal `system` user, and
 * service accounts are configured by an administrator and keep the agent's full
 * assigned tool set.
 *
 * The SRE catalog is reached by the `sre:read` role permission alone, which
 * only a user or service account can hold: without it the catalog is in
 * `denied`, which overrides `accessible`.
 */
export async function getCallerAccessibleCatalogIds(
  caller: CatalogAccessCaller,
  /** The catalogs about to be checked; `sre:read` is looked up only for SRE's. */
  catalogIds: Iterable<string | null>,
): Promise<CallerCatalogAccess> {
  const { userId, organizationId, lookups } = caller;
  const canUseSre =
    new Set(catalogIds).has(SRE_CATALOG_ID) &&
    !!userId &&
    !!organizationId &&
    userId !== "system" &&
    (await userHasPermission(userId, organizationId, "sre", "read"));
  const denied: ReadonlySet<string> = new Set(
    canUseSre ? [] : [SRE_CATALOG_ID],
  );
  if (
    !userId ||
    !organizationId ||
    userId === "system" ||
    isServiceAccountUserId(userId)
  ) {
    return { accessible: null, denied };
  }
  const isAdmin = await isMcpInstallationAdmin({
    userId,
    organizationId,
    lookups,
  });
  const accessible = new Set(
    await McpCatalogTeamModel.getAccessibleCatalogIds({
      userId,
      isAdmin,
      organizationId,
      lookups,
    }),
  );
  if (canUseSre) accessible.add(SRE_CATALOG_ID);
  return { accessible, denied };
}

interface CallerCatalogAccess {
  /** `null`: every catalog, for a caller that is not scoped by catalog grants. */
  accessible: ReadonlySet<string> | null;
  /** Refused whatever `accessible` says. */
  denied: ReadonlySet<string>;
}

/**
 * Whether a tool row is within the caller's catalog access. Rows without a
 * catalog (delegations, proxy-discovered tools) and the built-in catalogs are
 * governed elsewhere and always pass; so does every row outside `denied` when
 * `accessible` is `null` (a caller {@link getCallerAccessibleCatalogIds} does
 * not scope).
 */
export function isToolCatalogAccessible(
  tool: { catalogId: string | null },
  { accessible, denied }: CallerCatalogAccess,
): boolean {
  if (tool.catalogId === null) return true;
  if (denied.has(tool.catalogId)) return false;
  return (
    accessible === null ||
    isBuiltInCatalogId(tool.catalogId) ||
    accessible.has(tool.catalogId)
  );
}

/** Drop the rows outside the caller's catalog access. */
export async function filterToolsByCallerCatalogAccess<
  T extends { catalogId: string | null },
>(tools: T[], caller: CatalogAccessCaller): Promise<T[]> {
  const access = await getCallerAccessibleCatalogIds(
    caller,
    tools.map(({ catalogId }) => catalogId),
  );
  return tools.filter((tool) => isToolCatalogAccessible(tool, access));
}
