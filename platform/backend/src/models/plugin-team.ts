import { and, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

class PluginTeamModel {
  /**
   * Plugin IDs a caller can read: a read grant on the plugin, or at `*`.
   * Without a `userId` (a principal with no user of its own) only a plugin
   * published to the organization at large counts.
   */
  static async getUserAccessiblePluginIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    const context = {
      organizationId: params.organizationId,
      resource: "plugin" as const,
      scopeColumn: schema.pluginsTable.id,
      action: "read" as const,
    };
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const rows = await db
      .select({ id: schema.pluginsTable.id })
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          notDeleted(schema.pluginsTable),
          params.userId
            ? ResourcePermissionPolicyModel.grantCondition({
                ...context,
                userId: params.userId,
              })
            : ResourcePermissionPolicyModel.organizationAccessCondition(
                context,
              ),
        ),
      );
    // SPDX-SnippetEnd
    return rows.map((row) => row.id);
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
