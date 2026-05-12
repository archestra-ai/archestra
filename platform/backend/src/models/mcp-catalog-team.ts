import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

class McpCatalogTeamModel {
  /**
   * Get all catalog IDs that a user has access to.
   * Three sources of access:
   * 1. Org-scoped catalogs (visible to all)
   * 2. Author's own personal catalogs
   * 3. Team-scoped catalogs where user is a team member
   */
  static async getUserAccessibleCatalogIds(
    userId: string,
    isAdmin: boolean,
    organizationId: string,
  ): Promise<string[]> {
    if (isAdmin) {
      const allCatalogs = await db
        .select({ id: schema.internalMcpCatalogTable.id })
        .from(schema.internalMcpCatalogTable)
        .where(
          or(
            eq(schema.internalMcpCatalogTable.organizationId, organizationId),
            isNull(schema.internalMcpCatalogTable.organizationId),
          ),
        );
      return allCatalogs.map((c) => c.id);
    }

    // Mirrors the agent (profile) access control approach: org-visible + personal + team-based
    const result = await db.execute<{ id: string }>(sql`
      SELECT id FROM internal_mcp_catalog
        WHERE scope = 'org'
          AND (organization_id = ${organizationId} OR organization_id IS NULL)
      UNION
      SELECT id FROM internal_mcp_catalog
        WHERE author_id = ${userId}
          AND scope = 'personal'
          AND organization_id = ${organizationId}
      UNION
      SELECT ct.catalog_id AS id
        FROM mcp_catalog_team ct
        INNER JOIN internal_mcp_catalog c ON ct.catalog_id = c.id
        INNER JOIN team_member tm ON ct.team_id = tm.team_id
        WHERE tm.user_id = ${userId}
          AND c.scope = 'team'
          AND c.organization_id = ${organizationId}
    `);

    return result.rows.map((r) => r.id);
  }

  /**
   * Check if a user has access to a specific catalog item.
   */
  static async userHasCatalogAccess(
    userId: string,
    catalogId: string,
    isAdmin: boolean,
    organizationId: string,
  ): Promise<boolean> {
    const [catalog] = await db
      .select({
        scope: schema.internalMcpCatalogTable.scope,
        authorId: schema.internalMcpCatalogTable.authorId,
        organizationId: schema.internalMcpCatalogTable.organizationId,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalogId))
      .limit(1);

    if (!catalog) return false;
    if (catalog.organizationId && catalog.organizationId !== organizationId) {
      return false;
    }
    if (isAdmin) return true;

    if (catalog.scope === "org") return true;

    if (catalog.scope === "personal") {
      return catalog.authorId === userId;
    }

    if (catalog.scope === "team") {
      const userTeams = await db
        .select({ teamId: schema.teamMembersTable.teamId })
        .from(schema.teamMembersTable)
        .where(eq(schema.teamMembersTable.userId, userId));

      const teamIds = userTeams.map((t) => t.teamId);
      if (teamIds.length === 0) return false;

      const catalogTeam = await db
        .select()
        .from(schema.mcpCatalogTeamsTable)
        .where(
          and(
            eq(schema.mcpCatalogTeamsTable.catalogId, catalogId),
            inArray(schema.mcpCatalogTeamsTable.teamId, teamIds),
          ),
        )
        .limit(1);

      return catalogTeam.length > 0;
    }

    return false;
  }

  /**
   * Sync team assignments for a catalog item (replaces all existing assignments)
   */
  static async syncCatalogTeams(
    catalogId: string,
    teamIds: string[],
  ): Promise<number> {
    logger.debug(
      { catalogId, teamCount: teamIds.length },
      "McpCatalogTeamModel.syncCatalogTeams: syncing teams",
    );
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.mcpCatalogTeamsTable)
        .where(eq(schema.mcpCatalogTeamsTable.catalogId, catalogId));

      if (teamIds.length > 0) {
        await tx.insert(schema.mcpCatalogTeamsTable).values(
          teamIds.map((teamId) => ({
            catalogId,
            teamId,
          })),
        );
      }
    });

    return teamIds.length;
  }

  /**
   * Get team details (id and name) for a specific catalog item
   */
  static async getTeamDetailsForCatalog(
    catalogId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const catalogTeams = await db
      .select({
        teamId: schema.mcpCatalogTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.mcpCatalogTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.mcpCatalogTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.mcpCatalogTeamsTable.catalogId, catalogId));

    return catalogTeams.map((ct) => ({
      id: ct.teamId,
      name: ct.teamName,
    }));
  }

  /**
   * Get team details for multiple catalog items in one query to avoid N+1
   */
  static async getTeamDetailsForCatalogs(
    catalogIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    if (catalogIds.length === 0) return new Map();

    const catalogTeams = await db
      .select({
        catalogId: schema.mcpCatalogTeamsTable.catalogId,
        teamId: schema.mcpCatalogTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.mcpCatalogTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.mcpCatalogTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.mcpCatalogTeamsTable.catalogId, catalogIds));

    const teamsMap = new Map<string, Array<{ id: string; name: string }>>();

    for (const catalogId of catalogIds) {
      teamsMap.set(catalogId, []);
    }

    for (const { catalogId, teamId, teamName } of catalogTeams) {
      const teams = teamsMap.get(catalogId) || [];
      teams.push({ id: teamId, name: teamName });
      teamsMap.set(catalogId, teams);
    }

    return teamsMap;
  }
}

export default McpCatalogTeamModel;
