// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { and, eq, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import TeamModel from "./team";

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
   * org-context principal (org apps only). `isAppAdmin: true` bypasses scope
   * and returns every app in the org — mirroring `userHasAppAccess`, so an app
   * admin's list matches what they can already view one-by-one.
   *
   * A disabled app is author-only regardless of its scope, and this overrides
   * the app:admin bypass — an admin sees every *enabled* app plus only their
   * own disabled ones, never someone else's work-in-progress.
   */
  static async getUserAccessibleAppIds(params: {
    organizationId: string;
    userId?: string;
    isAppAdmin?: boolean;
    onlyExplicitGrants?: boolean;
  }): Promise<string[]> {
    const { organizationId, userId, isAppAdmin } = params;
    const isEnabled = eq(schema.appsTable.enabled, true);
    // Visibility of an *enabled* app: scope-based, with the admin bypass.
    const enabledVisibility = isAppAdmin
      ? isEnabled
      : userId === undefined
        ? and(isEnabled, eq(schema.internalMcpCatalogTable.scope, "org"))
        : and(
            isEnabled,
            or(
              eq(schema.internalMcpCatalogTable.scope, "org"),
              // A personal app reaches its author, and anyone it has been
              // shared with individually. The grant sits alongside the scope
              // rather than replacing it: "personal + named grants" is how an
              // app follows a chat shared with specific people, without
              // widening the app to a whole team or organization.
              and(
                eq(schema.internalMcpCatalogTable.scope, "personal"),
                or(
                  eq(schema.appsTable.authorId, userId),
                  eq(schema.mcpCatalogUsersTable.userId, userId),
                ),
              ),
              and(
                eq(schema.internalMcpCatalogTable.scope, "team"),
                TeamModel.effectiveMembershipCondition({
                  userId,
                  teamIdColumn: schema.mcpCatalogTeamsTable.teamId,
                }),
              ),
            ),
          );
    // A disabled app is visible only to its author (no admin/scope path reaches it).
    const disabledVisibility =
      userId === undefined
        ? undefined
        : and(
            eq(schema.appsTable.enabled, false),
            eq(schema.appsTable.authorId, userId),
          );
    const scopeCondition = disabledVisibility
      ? or(enabledVisibility, disabledVisibility)
      : enabledVisibility;
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
        schema.mcpCatalogUsersTable,
        and(
          eq(
            schema.internalMcpCatalogTable.id,
            schema.mcpCatalogUsersTable.catalogId,
          ),
          userId === undefined
            ? undefined
            : eq(schema.mcpCatalogUsersTable.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          notDeleted(schema.appsTable),
          or(
            params.onlyExplicitGrants
              ? undefined
              : and(
                  scopeCondition,
                  ResourcePermissionPolicyModel.legacySharingCondition({
                    organizationId,
                    resource: "app",
                    scopeColumn: schema.appsTable.id,
                  }),
                ),
            userId
              ? and(
                  or(isEnabled, disabledVisibility),
                  ResourcePermissionPolicyModel.grantCondition({
                    organizationId,
                    userId,
                    resource: "app",
                    scopeColumn: schema.appsTable.id,
                    action: "read",
                  }),
                )
              : undefined,
          ),
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
