// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { and, eq, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/**
 * Read-side accessibility for apps, decided by grants on the app, plus the
 * loaders for the retired team and user assignments on its backing catalog
 * (`apps → mcp_server → internal_mcp_catalog`).
 */
class AppAccessModel {
  /**
   * IDs of (non-deleted) apps a user can see: a read grant on the app, or at
   * `*`, decides. A disabled app is author-only regardless of grants — an
   * administrator sees every *enabled* app plus only their own disabled ones,
   * never someone else's work-in-progress. `userId: undefined` (a principal
   * with no user of its own) sees no apps; no grant names such a caller.
   */
  static async getUserAccessibleAppIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    const { organizationId, userId } = params;
    if (userId === undefined) return [];
    const rows = await db
      .selectDistinct({ id: schema.appsTable.id })
      .from(schema.appsTable)
      // Only an app with its backing server is listed, as before.
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .innerJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          notDeleted(schema.appsTable),
          or(
            eq(schema.appsTable.enabled, true),
            eq(schema.appsTable.authorId, userId),
          ),
          ResourcePermissionPolicyModel.grantCondition({
            organizationId,
            userId,
            resource: "app",
            scopeColumn: schema.appsTable.id,
            action: "read",
          }),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Whether a user may view a specific app: a grant on the app (or at `*`)
   * decides. A disabled app is author-only regardless of grants.
   */
  static async userHasAppAccess(params: {
    organizationId: string;
    userId?: string;
    app: {
      id: string;
      organizationId: string;
      authorId: string | null;
      enabled: boolean;
    };
    action?: "read" | "use";
  }): Promise<boolean> {
    const { app, organizationId, userId } = params;
    if (app.organizationId !== organizationId) return false;
    if (!app.enabled && app.authorId !== userId) return false;
    if (!userId) return false;
    const [grant] = await db
      .select({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.id, app.id),
          ResourcePermissionPolicyModel.grantCondition({
            organizationId,
            userId,
            resource: "app",
            scopeColumn: schema.appsTable.id,
            action: params.action ?? "read",
          }),
        ),
      )
      .limit(1);
    return grant !== undefined;
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

  /**
   * Individually-granted user details for several apps in one query (no N+1).
   * The Users analogue of {@link getTeamDetailsForApps}: it backs the "shared
   * with" list in App settings, so the author can see who an app reaches by
   * name rather than only which teams it reaches.
   */
  static async getUserDetailsForApps(
    appIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; email: string }>>> {
    const map = new Map<
      string,
      Array<{ id: string; name: string; email: string }>
    >();
    for (const id of appIds) map.set(id, []);
    if (appIds.length === 0) return map;

    const rows = await db
      .select({
        appId: schema.appsTable.id,
        userId: schema.mcpCatalogUsersTable.userId,
        userName: schema.usersTable.name,
        userEmail: schema.usersTable.email,
      })
      .from(schema.appsTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .innerJoin(
        schema.mcpCatalogUsersTable,
        eq(
          schema.mcpServersTable.catalogId,
          schema.mcpCatalogUsersTable.catalogId,
        ),
      )
      .innerJoin(
        schema.usersTable,
        eq(schema.mcpCatalogUsersTable.userId, schema.usersTable.id),
      )
      .where(inArray(schema.appsTable.id, appIds));

    for (const { appId, userId, userName, userEmail } of rows) {
      map.get(appId)?.push({ id: userId, name: userName, email: userEmail });
    }
    return map;
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
