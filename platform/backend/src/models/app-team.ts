import { and, eq, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { ResourceVisibilityScope } from "@/types/visibility";

/**
 * Team assignments + scope-based accessibility for apps. Mirrors
 * `SkillTeamModel`/`AgentTeamModel`. Writing assignments is done inside
 * `AppModel`'s transactions; this model owns the reads (accessibility queries
 * and the batch team loaders that avoid N+1 when listing apps).
 */
class AppTeamModel {
  /**
   * IDs of (non-deleted) apps a user can see, by scope: every `org` app, their
   * own `personal` apps, and `team` apps assigned to a team they belong to.
   * Pass `userId: undefined` for an org-context principal (org apps only).
   */
  static async getUserAccessibleAppIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    const { organizationId, userId } = params;
    const rows = await db
      .selectDistinct({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .leftJoin(
        schema.appTeamTable,
        eq(schema.appsTable.id, schema.appTeamTable.appId),
      )
      .leftJoin(
        schema.teamMembersTable,
        and(
          eq(schema.appTeamTable.teamId, schema.teamMembersTable.teamId),
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
            ? eq(schema.appsTable.scope, "org")
            : or(
                eq(schema.appsTable.scope, "org"),
                and(
                  eq(schema.appsTable.scope, "personal"),
                  eq(schema.appsTable.authorId, userId),
                ),
                and(
                  eq(schema.appsTable.scope, "team"),
                  eq(schema.teamMembersTable.userId, userId),
                ),
              ),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Whether a user may view a specific app. Org apps are visible to everyone in
   * the org; personal to the author; team to members of an assigned team. App
   * admins bypass scope. Fails closed for an out-of-union scope.
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
          .select({ teamId: schema.appTeamTable.teamId })
          .from(schema.appTeamTable)
          .innerJoin(
            schema.teamMembersTable,
            eq(schema.appTeamTable.teamId, schema.teamMembersTable.teamId),
          )
          .where(
            and(
              eq(schema.appTeamTable.appId, app.id),
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

  /** Team IDs assigned to one app. */
  static async getTeamsForApp(appId: string): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.appTeamTable.teamId })
      .from(schema.appTeamTable)
      .where(eq(schema.appTeamTable.appId, appId));
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
        appId: schema.appTeamTable.appId,
        teamId: schema.appTeamTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.appTeamTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.appTeamTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.appTeamTable.appId, appIds));

    for (const { appId, teamId, teamName } of rows) {
      map.get(appId)?.push({ id: teamId, name: teamName });
    }
    return map;
  }
}

export default AppTeamModel;
