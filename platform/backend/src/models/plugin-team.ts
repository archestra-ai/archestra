import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { Plugin } from "@/types";
import PluginUserModel from "./plugin-user";

class PluginTeamModel {
  static async getUserAccessiblePluginIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    if (!params.userId) {
      const result = await db.execute<{ id: string }>(sql`
        SELECT id FROM plugins
        WHERE scope = 'org' AND organization_id = ${params.organizationId}
          AND deleted_at IS NULL
      `);
      return result.rows.map((row) => row.id);
    }
    const result = await db.execute<{ id: string }>(sql`
      SELECT id FROM plugins
        WHERE scope = 'org' AND organization_id = ${params.organizationId}
          AND deleted_at IS NULL
      UNION
      SELECT id FROM plugins
        WHERE author_id = ${params.userId} AND scope = 'personal'
          AND organization_id = ${params.organizationId} AND deleted_at IS NULL
      UNION
      SELECT pu.plugin_id AS id FROM plugin_user pu
        INNER JOIN plugins p ON pu.plugin_id = p.id
        WHERE pu.user_id = ${params.userId}
          AND p.organization_id = ${params.organizationId} AND p.deleted_at IS NULL
      UNION
      SELECT pt.plugin_id AS id FROM plugin_team pt
        INNER JOIN plugins p ON pt.plugin_id = p.id
        INNER JOIN team_member tm ON pt.team_id = tm.team_id
        WHERE tm.user_id = ${params.userId} AND p.scope = 'team'
          AND p.organization_id = ${params.organizationId} AND p.deleted_at IS NULL
    `);
    return result.rows.map((row) => row.id);
  }

  static async userHasPluginAccess(params: {
    organizationId: string;
    userId?: string;
    plugin: Pick<Plugin, "id" | "organizationId" | "scope" | "authorId">;
    isAdmin: boolean;
  }): Promise<boolean> {
    if (params.plugin.organizationId !== params.organizationId) return false;
    if (params.isAdmin) return true;
    if (params.plugin.scope === "org") return true;
    if (!params.userId) return false;
    if (params.plugin.scope === "personal") {
      return (
        params.plugin.authorId === params.userId ||
        (await PluginUserModel.userHasGrant(params.plugin.id, params.userId))
      );
    }
    const [match] = await db
      .select({ teamId: schema.pluginTeamsTable.teamId })
      .from(schema.pluginTeamsTable)
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.pluginTeamsTable.teamId, schema.teamMembersTable.teamId),
      )
      .where(
        and(
          eq(schema.pluginTeamsTable.pluginId, params.plugin.id),
          eq(schema.teamMembersTable.userId, params.userId),
        ),
      )
      .limit(1);
    return match !== undefined;
  }

  static async syncPluginTeams(
    pluginId: string,
    teamIds: string[],
    tx: Transaction,
  ): Promise<void> {
    await tx
      .delete(schema.pluginTeamsTable)
      .where(eq(schema.pluginTeamsTable.pluginId, pluginId));
    if (teamIds.length > 0) {
      await tx
        .insert(schema.pluginTeamsTable)
        .values(
          Array.from(new Set(teamIds)).map((teamId) => ({ pluginId, teamId })),
        );
    }
  }

  static async getTeamDetailsForPlugins(
    pluginIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const result = new Map<string, Array<{ id: string; name: string }>>(
      pluginIds.map((id) => [id, []]),
    );
    if (pluginIds.length === 0) return result;
    const rows = await db
      .select({
        pluginId: schema.pluginTeamsTable.pluginId,
        teamId: schema.pluginTeamsTable.teamId,
        name: schema.teamsTable.name,
      })
      .from(schema.pluginTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.pluginTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.pluginTeamsTable.pluginId, pluginIds));
    for (const row of rows) {
      result.get(row.pluginId)?.push({ id: row.teamId, name: row.name });
    }
    return result;
  }
}

export default PluginTeamModel;
