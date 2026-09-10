import { eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";

class A2aRemoteAgentTeamModel {
  static async sync(
    remoteAgentId: string,
    teamIds: string[],
    tx?: Transaction,
  ): Promise<void> {
    const run = async (database: Transaction) => {
      await database
        .delete(schema.a2aRemoteAgentTeamsTable)
        .where(
          eq(schema.a2aRemoteAgentTeamsTable.remoteAgentId, remoteAgentId),
        );
      if (teamIds.length > 0) {
        await database
          .insert(schema.a2aRemoteAgentTeamsTable)
          .values(
            [...new Set(teamIds)].map((teamId) => ({ remoteAgentId, teamId })),
          );
      }
    };

    if (tx) await run(tx);
    else await withDbTransaction(run);
  }

  static async getDetailsForRemoteAgents(
    remoteAgentIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const result = new Map<string, Array<{ id: string; name: string }>>();
    for (const id of remoteAgentIds) result.set(id, []);
    if (remoteAgentIds.length === 0) return result;

    const rows = await db
      .select({
        remoteAgentId: schema.a2aRemoteAgentTeamsTable.remoteAgentId,
        id: schema.teamsTable.id,
        name: schema.teamsTable.name,
      })
      .from(schema.a2aRemoteAgentTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.a2aRemoteAgentTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(
        inArray(schema.a2aRemoteAgentTeamsTable.remoteAgentId, remoteAgentIds),
      );

    for (const row of rows) {
      result.get(row.remoteAgentId)?.push({ id: row.id, name: row.name });
    }
    return result;
  }
}

export default A2aRemoteAgentTeamModel;
