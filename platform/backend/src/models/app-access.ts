import { and, eq, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { ResourceVisibilityScope } from "@/types/visibility";

/**
 * Read-side accessibility + team loaders for apps. An app's visibility (scope +
 * teams) lives on its backing catalog (serverType "app"), so these resolve
 * through `apps → mcp_server → internal_mcp_catalog` and the `mcp_catalog_team`
 * junction — the same model the MCP server registry uses.
 */
class AppAccessModel {
  /**
   * IDs of (non-deleted) apps a user can see, by the backing catalog's scope:
   * every `org` app, their own `personal` apps, and `team` apps whose backing
   * catalog is assigned to a team they belong to. `userId: undefined` → an
   * org-context principal (org apps only).
   */
  static async getUserAccessibleAppIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    const { organizationId, userId } = params;
    const rows = await db
      .selectDistinct({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .innerJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .leftJoin(
        schema.mcpCatalogTeamsTable,
        eq(
          schema.internalMcpCatalogTable.id,
          schema.mcpCatalogTeamsTable.catalogId,
        ),
      )
      .leftJoin(
        schema.teamMembersTable,
        and(
          eq(
            schema.mcpCatalogTeamsTable.teamId,
            schema.teamMembersTable.teamId,
          ),
          userId === undefined
            ? undefined
            : eq(schema.teamMembersTable.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          notDeleted(schema.appsTable),
          userId === undefined
            ? eq(schema.internalMcpCatalogTable.scope, "org")
            : or(
                eq(schema.internalMcpCatalogTable.scope, "org"),
                and(
                  eq(schema.internalMcpCatalogTable.scope, "personal"),
                  eq(schema.appsTable.authorId, userId),
                ),
                and(
                  eq(schema.internalMcpCatalogTable.scope, "team"),
                  eq(schema.teamMembersTable.userId, userId),
                ),
              ),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Whether a user may view a specific app, by its backing catalog's scope. Org
   * apps are visible org-wide; personal to the author; team to members of a team
   * the backing catalog is assigned to. App admins bypass scope.
   */
  static async userHasAppAccess(params: {
    organizationId: string;
    userId?: string;
    app: {
      id: string;
      organizationId: string;
      scope: ResourceVisibilityScope;
      authorId: string | null;
    };
    isAppAdmin: boolean;
  }): Promise<boolean> {
    const { app, organizationId, userId } = params;
    if (app.organizationId !== organizationId) return false;
    if (params.isAppAdmin) return true;

    switch (app.scope) {
      case "org":
        return true;
      case "personal":
        return userId !== undefined && app.authorId === userId;
      case "team": {
        if (userId === undefined) return false;
        const [match] = await db
          .select({ teamId: schema.mcpCatalogTeamsTable.teamId })
          .from(schema.appsTable)
          .innerJoin(
            schema.mcpServersTable,
            eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
          )
          .innerJoin(
            schema.mcpCatalogTeamsTable,
            eq(
              schema.mcpServersTable.catalogId,
              schema.mcpCatalogTeamsTable.catalogId,
            ),
          )
          .innerJoin(
            schema.teamMembersTable,
            eq(
              schema.mcpCatalogTeamsTable.teamId,
              schema.teamMembersTable.teamId,
            ),
          )
          .where(
            and(
              eq(schema.appsTable.id, app.id),
              eq(schema.teamMembersTable.userId, userId),
            ),
          )
          .limit(1);
        return match !== undefined;
      }
      default:
        return false;
    }
  }

  /** Team IDs assigned to one app (via its backing catalog). */
  static async getTeamsForApp(appId: string): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.mcpCatalogTeamsTable.teamId })
      .from(schema.appsTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .innerJoin(
        schema.mcpCatalogTeamsTable,
        eq(
          schema.mcpServersTable.catalogId,
          schema.mcpCatalogTeamsTable.catalogId,
        ),
      )
      .where(eq(schema.appsTable.id, appId));
    return rows.map((r) => r.teamId);
  }

  /** Team details (id + name) for several apps in one query (no N+1). */
  static async getTeamDetailsForApps(
    appIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const map = new Map<string, Array<{ id: string; name: string }>>();
    for (const id of appIds) map.set(id, []);
    if (appIds.length === 0) return map;

    const rows = await db
      .select({
        appId: schema.appsTable.id,
        teamId: schema.mcpCatalogTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.appsTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .innerJoin(
        schema.mcpCatalogTeamsTable,
        eq(
          schema.mcpServersTable.catalogId,
          schema.mcpCatalogTeamsTable.catalogId,
        ),
      )
      .innerJoin(
        schema.teamsTable,
        eq(schema.mcpCatalogTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.appsTable.id, appIds));

    for (const { appId, teamId, teamName } of rows) {
      map.get(appId)?.push({ id: teamId, name: teamName });
    }
    return map;
  }
}

export default AppAccessModel;
