import { eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";

class A2aRemoteAgentUserModel {
  static async sync(
    remoteAgentId: string,
    userIds: string[],
    tx?: Transaction,
  ): Promise<void> {
    const run = async (database: Transaction) => {
      await database
        .delete(schema.a2aRemoteAgentUsersTable)
        .where(
          eq(schema.a2aRemoteAgentUsersTable.remoteAgentId, remoteAgentId),
        );
      if (userIds.length > 0) {
        await database
          .insert(schema.a2aRemoteAgentUsersTable)
          .values(
            [...new Set(userIds)].map((userId) => ({ remoteAgentId, userId })),
          );
      }
    };

    if (tx) await run(tx);
    else await withDbTransaction(run);
  }

  static async getDetailsForRemoteAgents(
    remoteAgentIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; email: string }>>> {
    const result = new Map<
      string,
      Array<{ id: string; name: string; email: string }>
    >();
    for (const id of remoteAgentIds) result.set(id, []);
    if (remoteAgentIds.length === 0) return result;

    const rows = await db
      .select({
        remoteAgentId: schema.a2aRemoteAgentUsersTable.remoteAgentId,
        id: schema.usersTable.id,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
      })
      .from(schema.a2aRemoteAgentUsersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.a2aRemoteAgentUsersTable.userId, schema.usersTable.id),
      )
      .where(
        inArray(schema.a2aRemoteAgentUsersTable.remoteAgentId, remoteAgentIds),
      );

    for (const row of rows) {
      result.get(row.remoteAgentId)?.push({
        id: row.id,
        name: row.name,
        email: row.email,
      });
    }
    return result;
  }
}

export default A2aRemoteAgentUserModel;
