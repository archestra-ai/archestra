import { count, countDistinct } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { AgentType, InstanceEntityCounts } from "@/types";

class InstanceUsageModel {
  /**
   * Instance-wide entity counts reported with analytics heartbeats.
   */
  static async getEntityCounts(): Promise<InstanceEntityCounts> {
    const [
      [users],
      [teams],
      agentRows,
      [llmProviders],
      [virtualApiKeys],
      [mcpServers],
      [conversations],
      [skills],
      [apps],
      [knowledgeBases],
    ] = await Promise.all([
      db.select({ total: count() }).from(schema.usersTable),
      db.select({ total: count() }).from(schema.teamsTable),
      db
        .select({ agentType: schema.agentsTable.agentType, total: count() })
        .from(schema.agentsTable)
        .where(notDeleted(schema.agentsTable))
        .groupBy(schema.agentsTable.agentType),
      db
        .select({
          total: countDistinct(schema.llmProviderApiKeysTable.provider),
        })
        .from(schema.llmProviderApiKeysTable),
      db.select({ total: count() }).from(schema.virtualApiKeysTable),
      db.select({ total: count() }).from(schema.mcpServersTable),
      db.select({ total: count() }).from(schema.conversationsTable),
      db.select({ total: count() }).from(schema.skillsTable),
      db
        .select({ total: count() })
        .from(schema.appsTable)
        .where(notDeleted(schema.appsTable)),
      db.select({ total: count() }).from(schema.knowledgeBasesTable),
    ]);

    const agentCountsByType: Record<AgentType, number> = {
      profile: 0,
      mcp_gateway: 0,
      llm_proxy: 0,
      agent: 0,
    };
    for (const row of agentRows) {
      agentCountsByType[row.agentType] = row.total;
    }

    return {
      users: users?.total ?? 0,
      teams: teams?.total ?? 0,
      agents: agentCountsByType.agent,
      profiles: agentCountsByType.profile,
      mcpGateways: agentCountsByType.mcp_gateway,
      llmProxies: agentCountsByType.llm_proxy,
      llmProviders: llmProviders?.total ?? 0,
      virtualApiKeys: virtualApiKeys?.total ?? 0,
      mcpServers: mcpServers?.total ?? 0,
      conversations: conversations?.total ?? 0,
      skills: skills?.total ?? 0,
      apps: apps?.total ?? 0,
      knowledgeBases: knowledgeBases?.total ?? 0,
    };
  }
}

export default InstanceUsageModel;
