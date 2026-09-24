// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ARCHESTRA_MCP_CATALOG_ID,
  isBuiltInCatalogId,
  PLAYWRIGHT_MCP_CATALOG_ID,
  type ResourcePermissionAction,
} from "@archestra/shared";
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  type CatalogTeamAccessLevel,
  type CatalogTeamInput,
  DEFAULT_CATALOG_TEAM_ACCESS_LEVEL,
  normalizeCatalogTeamInput,
} from "@/types/catalog-team-level";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

interface CatalogTeamDetail {
  id: string;
  name: string;
  level: CatalogTeamAccessLevel;
}

class McpCatalogTeamModel {
  /**
   * Catalog IDs a user can see in the registry: every catalog in the
   * organization for an administrator, otherwise the ones
   * {@link McpCatalogTeamModel.readCondition} admits.
   */
  static async getUserAccessibleCatalogIds(
    userId: string,
    isAdmin: boolean,
    organizationId: string,
  ): Promise<string[]> {
    const catalog = schema.internalMcpCatalogTable;
    const rows = await db
      .select({ id: catalog.id })
      .from(catalog)
      .where(
        and(
          or(
            eq(catalog.organizationId, organizationId),
            isNull(catalog.organizationId),
          ),
          isAdmin
            ? undefined
            : McpCatalogTeamModel.readCondition({ organizationId, userId }),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Whether a user can see a catalog row in a registry list, as SQL over
   * `internal_mcp_catalog`. Grants decide, with three kinds of row that have
   * no policy of their own:
   *
   * - The two built-in catalogs ship with the platform. Every member has
   *   always seen them in the registry, and they carry no per-object policy,
   *   so they stay visible to any member.
   * - A hidden runtime variant is part of its parent, so it follows the
   *   parent's grants.
   * - An app's backing catalog is the app's own, so it follows the app's
   *   grants rather than a registry policy it never had. A registry-wide grant
   *   still reaches it, as it did before.
   */
  static readCondition(params: { organizationId: string; userId: string }) {
    const catalog = schema.internalMcpCatalogTable;
    const { organizationId, userId } = params;
    return or(
      and(
        inArray(catalog.id, [
          ARCHESTRA_MCP_CATALOG_ID,
          PLAYWRIGHT_MCP_CATALOG_ID,
        ]),
        sql`EXISTS (SELECT 1 FROM member builtin_member WHERE builtin_member.organization_id = ${organizationId} AND builtin_member.user_id = ${userId})`,
      ),
      and(
        sql`${catalog.serverType} <> 'app'`,
        ResourcePermissionPolicyModel.grantCondition({
          organizationId,
          userId,
          resource: "mcpRegistry",
          scopeColumn: sql`coalesce(${catalog.parentCatalogItemId}, ${catalog.id})`,
          action: "read",
        }),
      ),
      and(
        eq(catalog.serverType, "app"),
        or(
          // Whoever manages the whole registry reaches app backing catalogs
          // as before; they held that reach through the registry, not the app.
          ResourcePermissionPolicyModel.grantCondition({
            organizationId,
            userId,
            resource: "mcpRegistry",
            scopeColumn: catalog.id,
            action: "read",
          }),
          sql`EXISTS (
          SELECT 1 FROM apps backing_app
          JOIN mcp_server backing_server ON backing_server.id = backing_app.mcp_server_id
          WHERE backing_server.catalog_id = ${catalog.id}
            AND backing_app.organization_id = ${organizationId}
            AND backing_app.deleted_at IS NULL
            AND ${ResourcePermissionPolicyModel.grantCondition({
              organizationId,
              userId,
              resource: "app",
              scopeColumn: sql`backing_app.id`,
              action: "read",
            })}
          )`,
        ),
      ),
    ) as SQL;
  }

  /**
   * Whether a catalog item is in front of the whole organization: a built-in
   * catalog always is, and any other item is when its own grants reach the
   * organization or a role (a runtime variant answers for its parent). A
   * shared installation of an item that is not makes the installer's
   * connection something other members resolve through, which is a write on
   * the item.
   */
  static async isPublishedToOrganization(params: {
    organizationId: string;
    catalog: { id: string; parentCatalogItemId?: string | null };
  }): Promise<boolean> {
    const { catalog } = params;
    if (isBuiltInCatalogId(catalog.id)) return true;
    const { audience } = await ResourcePermissionPolicyModel.findAudience({
      organizationId: params.organizationId,
      resource: "mcpRegistry",
      scope: catalog.parentCatalogItemId ?? catalog.id,
    });
    return audience === "org";
  }

  /**
   * Check if a user has access to a specific catalog item: a grant on the item
   * (or at `*`) decides. The action asked for, or `read` alongside it.
   */
  static async userHasCatalogAccess(params: {
    userId: string;
    catalogId: string;
    organizationId: string;
    action?: ResourcePermissionAction;
  }): Promise<boolean> {
    const { userId, catalogId, organizationId } = params;
    const [catalog] = await db
      .select({
        organizationId: schema.internalMcpCatalogTable.organizationId,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalogId))
      .limit(1);

    if (!catalog) return false;
    if (catalog.organizationId && catalog.organizationId !== organizationId) {
      return false;
    }
    // Opening an item follows the same rule as listing it, so a built-in or
    // an app backing catalog that a list shows also opens.
    if (!params.action || params.action === "read") {
      const [readable] = await db
        .select({ id: schema.internalMcpCatalogTable.id })
        .from(schema.internalMcpCatalogTable)
        .where(
          and(
            eq(schema.internalMcpCatalogTable.id, catalogId),
            McpCatalogTeamModel.readCondition({ organizationId, userId }),
          ),
        )
        .limit(1);
      return readable !== undefined;
    }
    // A runtime variant answers with its parent's grants, as the read rule does.
    const grantScope = sql`coalesce(${schema.internalMcpCatalogTable.parentCatalogItemId}, ${schema.internalMcpCatalogTable.id})`;
    const [grant] = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(schema.internalMcpCatalogTable.id, catalogId),
          or(
            eq(schema.internalMcpCatalogTable.organizationId, organizationId),
            isNull(schema.internalMcpCatalogTable.organizationId),
          ),
          or(
            ResourcePermissionPolicyModel.grantCondition({
              organizationId,
              userId,
              resource: "mcpRegistry",
              scopeColumn: grantScope,
              action: params.action,
            }),
            // A reader finds the item, so the caller's own check answers 403.
            ResourcePermissionPolicyModel.grantCondition({
              organizationId,
              userId,
              resource: "mcpRegistry",
              scopeColumn: grantScope,
              action: "read",
            }),
          ),
        ),
      )
      .limit(1);
    return grant !== undefined;
  }

  /**
   * Replace a catalog item's team assignments.
   *
   * An entry without a `level` keeps the level already stored for that team, so
   * an id-only caller (the agent-callable edit tools, a legacy API client)
   * cannot silently promote a `use` team to `write`. A team assigned for the
   * first time without a level takes the default, `write`.
   */
  static async syncCatalogTeams(
    catalogId: string,
    teams: CatalogTeamInput[],
    tx?: Transaction,
  ): Promise<number> {
    const assignments = normalizeCatalogTeamInput(teams);
    logger.debug(
      { catalogId, teamCount: assignments.length },
      "McpCatalogTeamModel.syncCatalogTeams: syncing teams",
    );
    const run = async (t: Transaction) => {
      const existing = await t
        .select({
          teamId: schema.mcpCatalogTeamsTable.teamId,
          level: schema.mcpCatalogTeamsTable.level,
        })
        .from(schema.mcpCatalogTeamsTable)
        .where(eq(schema.mcpCatalogTeamsTable.catalogId, catalogId));
      const storedLevels = new Map(
        existing.map((row) => [row.teamId, row.level]),
      );

      await t
        .delete(schema.mcpCatalogTeamsTable)
        .where(eq(schema.mcpCatalogTeamsTable.catalogId, catalogId));

      if (assignments.length > 0) {
        await t.insert(schema.mcpCatalogTeamsTable).values(
          assignments.map(({ id, level }) => ({
            catalogId,
            teamId: id,
            level:
              level ??
              storedLevels.get(id) ??
              DEFAULT_CATALOG_TEAM_ACCESS_LEVEL,
          })),
        );
      }
    };
    if (tx) {
      await run(tx);
    } else {
      await withDbTransaction(run);
    }

    return assignments.length;
  }

  /**
   * The teams a catalog item's own policy grants read to. A team that may
   * also update the item holds the `write` level; any other holds `use`.
   */
  static async getTeamDetailsForCatalog(
    catalogId: string,
  ): Promise<CatalogTeamDetail[]> {
    return (
      (await McpCatalogTeamModel.getTeamDetailsForCatalogs([catalogId])).get(
        catalogId,
      ) ?? []
    );
  }

  /** {@link getTeamDetailsForCatalog} for several catalog items at once. */
  static async getTeamDetailsForCatalogs(
    catalogIds: string[],
  ): Promise<Map<string, CatalogTeamDetail[]>> {
    const details =
      await ResourcePermissionPolicyModel.findReadRecipientDetails({
        resources: ["mcpRegistry"],
        scopes: catalogIds,
      });
    return new Map(
      catalogIds.map((id) => [
        id,
        (details.get(id)?.teams ?? []).map((team) => ({
          id: team.id,
          name: team.name,
          level: team.actions.includes("update")
            ? ("write" as const)
            : ("use" as const),
        })),
      ]),
    );
  }
}

export default McpCatalogTeamModel;
