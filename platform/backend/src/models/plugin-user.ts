import { and, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";

class PluginUserModel {
  static async syncPluginUsers(
    pluginId: string,
    userIds: string[],
    tx: Transaction,
  ): Promise<void> {
    await tx
      .delete(schema.pluginUsersTable)
      .where(eq(schema.pluginUsersTable.pluginId, pluginId));
    if (userIds.length > 0) {
      await tx
        .insert(schema.pluginUsersTable)
        .values(
          Array.from(new Set(userIds)).map((userId) => ({ pluginId, userId })),
        );
    }
  }

  static async userHasGrant(
    pluginId: string,
    userId: string,
  ): Promise<boolean> {
    const [match] = await db
      .select({ userId: schema.pluginUsersTable.userId })
      .from(schema.pluginUsersTable)
      .where(
        and(
          eq(schema.pluginUsersTable.pluginId, pluginId),
          eq(schema.pluginUsersTable.userId, userId),
        ),
      )
      .limit(1);
    return match !== undefined;
  }

  static async getUserDetailsForPlugins(
    pluginIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; email: string }>>> {
    const result = new Map<
      string,
      Array<{ id: string; name: string; email: string }>
    >(pluginIds.map((id) => [id, []]));
    if (pluginIds.length === 0) return result;
    const rows = await db
      .select({
        pluginId: schema.pluginUsersTable.pluginId,
        userId: schema.pluginUsersTable.userId,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
      })
      .from(schema.pluginUsersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.pluginUsersTable.userId, schema.usersTable.id),
      )
      .where(inArray(schema.pluginUsersTable.pluginId, pluginIds));
    for (const row of rows) {
      result.get(row.pluginId)?.push({
        id: row.userId,
        name: row.name,
        email: row.email,
      });
    }
    return result;
  }
}

export default PluginUserModel;
