import { and, eq, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  CreateLimit,
  Limit,
  LimitEntityType,
  LimitType,
  UpdateLimit,
} from "@/types";

class LimitModel {
  /**
   * Create a new limit
   */
  static async create(data: CreateLimit): Promise<Limit> {
    const [limit] = await db
      .insert(schema.limitsTable)
      .values(data)
      .returning();

    return limit;
  }

  /**
   * Find all limits, optionally filtered by entity type, entity ID, and/or limit type
   */
  static async findAll(
    entityType?: LimitEntityType,
    entityId?: string,
    limitType?: LimitType,
  ): Promise<Limit[]> {
    const whereConditions: SQL[] = [];

    if (entityType) {
      whereConditions.push(eq(schema.limitsTable.entityType, entityType));
    }

    if (entityId) {
      whereConditions.push(eq(schema.limitsTable.entityId, entityId));
    }

    if (limitType) {
      whereConditions.push(eq(schema.limitsTable.limitType, limitType));
    }

    const whereClause =
      whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(whereClause);

    return limits;
  }

  /**
   * Find a limit by ID
   */
  static async findById(id: string): Promise<Limit | null> {
    const [limit] = await db
      .select()
      .from(schema.limitsTable)
      .where(eq(schema.limitsTable.id, id));

    return limit || null;
  }

  /**
   * Patch a limit
   */
  static async patch(
    id: string,
    data: Partial<UpdateLimit>,
  ): Promise<Limit | null> {
    const [limit] = await db
      .update(schema.limitsTable)
      .set(data)
      .where(eq(schema.limitsTable.id, id))
      .returning();

    return limit || null;
  }

  /**
   * Delete a limit
   */
  static async delete(id: string): Promise<boolean> {
    // First check if the limit exists
    const existing = await LimitModel.findById(id);
    if (!existing) {
      return false;
    }

    await db.delete(schema.limitsTable).where(eq(schema.limitsTable.id, id));

    return true;
  }

  /**
   * Get token usage for a specific agent
   * Returns the sum of input and output tokens from all interactions
   */
  static async getAgentTokenUsage(agentId: string): Promise<{
    agentId: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  }> {
    const result = await db
      .select({
        totalInputTokens: sql<number>`COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0)`,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.agentId, agentId));

    const totalInputTokens = Number(result[0]?.totalInputTokens || 0);
    const totalOutputTokens = Number(result[0]?.totalOutputTokens || 0);

    return {
      agentId,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
    };
  }

  /**
   * Update token usage for limits of a specific entity
   * Used by usage tracking service after interactions
   */
  static async updateTokenLimitUsage(
    entityType: LimitEntityType,
    entityId: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    try {
      // Update currentUsageTokensIn and currentUsageTokensOut by incrementing with the token usage
      await db
        .update(schema.limitsTable)
        .set({
          currentUsageTokensIn: sql`${schema.limitsTable.currentUsageTokensIn} + ${inputTokens}`,
          currentUsageTokensOut: sql`${schema.limitsTable.currentUsageTokensOut} + ${outputTokens}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.limitsTable.entityType, entityType),
            eq(schema.limitsTable.entityId, entityId),
            eq(schema.limitsTable.limitType, "token_cost"),
          ),
        );
    } catch (error) {
      logger.error(
        `Error updating ${entityType} token limit for ${entityId}: ${error}`,
      );
      // Don't throw - continue with other updates
    }
  }

  /**
   * Find limits that need cleanup based on organization's cleanup interval
   * Returns limits where lastCleanup is null or older than the cutoff time
   */
  static async findLimitsNeedingCleanup(
    organizationId: string,
    cutoffTime: Date,
  ): Promise<Limit[]> {
    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.entityType, "organization"),
          eq(schema.limitsTable.entityId, organizationId),
          // Either never cleaned up OR last cleanup was before cutoff
          or(
            isNull(schema.limitsTable.lastCleanup),
            lt(schema.limitsTable.lastCleanup, cutoffTime),
          ),
        ),
      );

    return limits;
  }

  /**
   * Reset usage counters for a specific limit
   * Updates currentUsageTokensIn and currentUsageTokensOut to 0 and sets lastCleanup
   */
  static async resetLimitUsage(id: string): Promise<Limit | null> {
    const now = new Date();

    const [limit] = await db
      .update(schema.limitsTable)
      .set({
        currentUsageTokensIn: 0,
        currentUsageTokensOut: 0,
        lastCleanup: now,
        updatedAt: now,
      })
      .where(eq(schema.limitsTable.id, id))
      .returning();

    return limit || null;
  }

  /**
   * Get limits for entity validation checks
   * Used by limit validation service to check if limits are exceeded
   */
  static async findLimitsForValidation(
    entityType: LimitEntityType,
    entityId: string,
    limitType: LimitType = "token_cost",
  ): Promise<Limit[]> {
    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.entityType, entityType),
          eq(schema.limitsTable.entityId, entityId),
          eq(schema.limitsTable.limitType, limitType),
        ),
      );

    return limits;
  }
}

export default LimitModel;
