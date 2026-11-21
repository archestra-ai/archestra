import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import db, { schema } from "@/database";
import { interactionBelongsToOrganization } from "@/models/log-organization";

/**
 * Reads the Logs page's unified feed needs that no other model serves: a lean
 * page of the newest LLM Proxy requests, without payloads or totals, and the
 * names of the users and agents the other types' records refer to.
 */
class LogFeedModel {
  /** The newest requests in the window, at most `limit`, newest first. */
  static async findInteractions(params: {
    organizationId: string;
    /** Only this user's requests; every user's when left out. */
    userId?: string;
    from: Date;
    to: Date;
    limit: number;
  }) {
    const interactions = schema.interactionsTable;
    return db
      .select({
        id: interactions.id,
        createdAt: interactions.createdAt,
        sessionId: interactions.sessionId,
        userId: interactions.userId,
        userName: schema.usersTable.name,
        userEmail: schema.usersTable.email,
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        externalAgentId: interactions.externalAgentId,
        source: interactions.source,
        type: interactions.type,
        model: interactions.model,
        inputTokens: interactions.inputTokens,
        outputTokens: interactions.outputTokens,
        cacheReadTokens: interactions.cacheReadTokens,
        cost: interactions.cost,
        billingMode: interactions.billingMode,
        durationMs: interactions.durationMs,
        failed: interactions.failed,
      })
      .from(interactions)
      .leftJoin(
        schema.usersTable,
        eq(interactions.userId, schema.usersTable.id),
      )
      .leftJoin(
        schema.agentsTable,
        eq(interactions.profileId, schema.agentsTable.id),
      )
      .where(
        and(
          interactionBelongsToOrganization(params.organizationId),
          gte(interactions.createdAt, params.from),
          lte(interactions.createdAt, params.to),
          params.userId ? eq(interactions.userId, params.userId) : undefined,
        ),
      )
      .orderBy(desc(interactions.createdAt), desc(interactions.id))
      .limit(params.limit);
  }

  static async findUserNames(
    ids: string[],
  ): Promise<Map<string, { name: string; email: string }>> {
    if (!ids.length) return new Map();
    const rows = await db
      .select({
        id: schema.usersTable.id,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
      })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, ids));
    return new Map(rows.map(({ id, ...user }) => [id, user]));
  }

  static async findAgentNames(
    ids: string[],
  ): Promise<Map<string, { name: string; agentType: string }>> {
    if (!ids.length) return new Map();
    const rows = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
      })
      .from(schema.agentsTable)
      .where(inArray(schema.agentsTable.id, ids));
    return new Map(rows.map(({ id, ...agent }) => [id, agent]));
  }
}

export default LogFeedModel;
