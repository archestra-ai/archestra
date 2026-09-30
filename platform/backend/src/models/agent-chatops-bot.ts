import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ChatOpsProviderType } from "@/types";

/**
 * The bots an agent speaks through (the cards on its Messaging tab).
 *
 * Writes happen inside ChatOpsChannelBindingModel's assignment paths so a card
 * and the channels under it always change together; this model answers the
 * read side.
 */
class AgentChatOpsBotModel {
  static async findBotIdsByAgent(agentId: string): Promise<string[]> {
    const rows = await db
      .select({ botId: schema.agentChatopsBotsTable.botId })
      .from(schema.agentChatopsBotsTable)
      .where(eq(schema.agentChatopsBotsTable.agentId, agentId));
    return rows.map((row) => row.botId);
  }

  /**
   * Agents that use each bot: those with a card for it, plus any agent that
   * still holds a channel under it (cards and channels are kept in step, so the
   * union only matters for rows written before cards existed).
   */
  static async findAgentsByBotIds(
    botIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const result = new Map<string, Array<{ id: string; name: string }>>(
      botIds.map((botId) => [botId, []]),
    );
    if (botIds.length === 0) return result;

    const [cardRows, bindingRows] = await Promise.all([
      db
        .select({
          botId: schema.agentChatopsBotsTable.botId,
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        })
        .from(schema.agentChatopsBotsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.agentChatopsBotsTable.agentId, schema.agentsTable.id),
        )
        .where(inArray(schema.agentChatopsBotsTable.botId, botIds)),
      db
        .selectDistinct({
          botId: schema.chatopsChannelBindingsTable.botId,
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        })
        .from(schema.chatopsChannelBindingsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.chatopsChannelBindingsTable.agentId, schema.agentsTable.id),
        )
        .where(
          and(
            inArray(schema.chatopsChannelBindingsTable.botId, botIds),
            isNotNull(schema.chatopsChannelBindingsTable.agentId),
          ),
        ),
    ]);

    for (const row of [...cardRows, ...bindingRows]) {
      const agents = result.get(row.botId);
      if (agents && !agents.some((agent) => agent.id === row.id)) {
        agents.push({ id: row.id, name: row.name });
      }
    }
    for (const agents of result.values()) {
      agents.sort((a, b) => a.name.localeCompare(b.name));
    }
    return result;
  }

  static async findAgentsByBot(
    botId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return (
      (await AgentChatOpsBotModel.findAgentsByBotIds([botId])).get(botId) ?? []
    );
  }

  /**
   * The bot of the same provider this agent already uses, if it is a different
   * bot than the one being claimed. An agent uses one bot per provider.
   */
  static async findConflictingCard(params: {
    agentId: string;
    botId: string;
    provider: ChatOpsProviderType;
  }): Promise<{ botId: string; name: string } | null> {
    const [row] = await db
      .select({
        botId: schema.chatopsBotsTable.id,
        name: schema.chatopsBotsTable.name,
      })
      .from(schema.agentChatopsBotsTable)
      .innerJoin(
        schema.chatopsBotsTable,
        eq(schema.agentChatopsBotsTable.botId, schema.chatopsBotsTable.id),
      )
      .where(
        and(
          eq(schema.agentChatopsBotsTable.agentId, params.agentId),
          eq(schema.chatopsBotsTable.provider, params.provider),
          ne(schema.chatopsBotsTable.id, params.botId),
        ),
      )
      .orderBy(asc(schema.chatopsBotsTable.createdAt))
      .limit(1);
    return row ?? null;
  }
}

export default AgentChatOpsBotModel;
