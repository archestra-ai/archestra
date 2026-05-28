import { and, eq, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import logger from "@/logging";
import type {
  CreateLimit,
  Limit,
  LimitCleanupInterval,
  LimitEntityType,
  LimitType,
  UpdateLimit,
} from "@/types";
import AgentTeamModel from "./agent-team";
import ModelModel from "./model";

type LimitsCleanupOptionsEntities = {
  [K in Exclude<LimitEntityType, "team">]?: string;
} & {
  [K in Extract<LimitEntityType, "team">]?: string[];
};

type LimitsCleanupOptions = {
  entities?: LimitsCleanupOptionsEntities;
  entityType?: LimitEntityType;
  entityId?: string;
  limitType?: LimitType;
  allForOrganizationId?: string;
};

type LimitsCleanupIntervalSqlLiteral =
  | "1 hour"
  | "12 hours"
  | "24 hours"
  | "1 week"
  | "1 month";

class LimitModel {
  // limitsCleanupIntervalSqlLiterals exists basically to compile-time check set of literals
  static readonly limitsCleanupIntervalSqlLiterals: Record<
    LimitCleanupInterval,
    LimitsCleanupIntervalSqlLiteral
  > = {
    "1h": "1 hour",
    "12h": "12 hours",
    "24h": "24 hours",
    "1w": "1 week",
    "1m": "1 month",
  };
  /**
   * Create a new limit
   */
  static async create(data: CreateLimit): Promise<Limit> {
    const [limit] = await db
      .insert(schema.limitsTable)
      .values(data)
      .returning();

    // For token_cost limits, initialize model usage records
    if (
      limit.limitType === "token_cost" &&
      limit.model &&
      Array.isArray(limit.model)
    ) {
      await LimitModel.initializeModelUsageRecords(limit.id, limit.model);
    }

    return limit;
  }

  /**
   * Initialize model usage records for a limit
   * Creates a record in limit_model_usage for each model in the limit
   */
  static async initializeModelUsageRecords(
    limitId: string,
    models: string[],
  ): Promise<void> {
    if (!models || models.length === 0) {
      return;
    }

    const records = models.map((model) => ({
      limitId,
      model,
      currentUsageTokensIn: 0,
      currentUsageTokensOut: 0,
    }));

    await db.insert(schema.limitModelUsageTable).values(records);

    logger.info(
      `[LimitModel] Initialized ${models.length} model usage records for limit ${limitId}`,
    );
  }

  /**
   * Find all limits, optionally filtered by entity type, entity ID, and/or limit type
   */
  static async findAll(
    entityType?: LimitEntityType,
    entityId?: string,
    limitType?: LimitType,
    organizationId?: string,
  ): Promise<Limit[]> {
    const whereConditions: SQL[] = [];

    if (organizationId) {
      whereConditions.push(
        buildOrganizationLimitScopeCondition(organizationId),
      );
    }

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
   * Get per-model usage breakdown for a token_cost limit
   * Returns the cost for each model in the limit
   */
  static async getModelUsageBreakdown(
    limitId: string,
  ): Promise<
    Array<{ model: string; tokensIn: number; tokensOut: number; cost: number }>
  > {
    // Get the model usage records
    const modelUsages = await db
      .select()
      .from(schema.limitModelUsageTable)
      .where(eq(schema.limitModelUsageTable.limitId, limitId));

    // Calculate cost for each model
    const breakdown = await Promise.all(
      modelUsages.map(async (usage) => {
        // Look up model by modelId only — limit usage records don't store provider
        const modelEntry = await ModelModel.findByModelIdOnly(usage.model);
        const pricing = ModelModel.getEffectivePricing(modelEntry, usage.model);

        const inputCost =
          (usage.currentUsageTokensIn *
            parseFloat(pricing.pricePerMillionInput)) /
          1_000_000;
        const outputCost =
          (usage.currentUsageTokensOut *
            parseFloat(pricing.pricePerMillionOutput)) /
          1_000_000;

        return {
          model: usage.model,
          tokensIn: usage.currentUsageTokensIn,
          tokensOut: usage.currentUsageTokensOut,
          cost: inputCost + outputCost,
        };
      }),
    );

    return breakdown;
  }

  /**
   * Get raw model usage records for a limit (primarily for testing)
   * Returns the raw database records from limitModelUsageTable
   */
  static async getRawModelUsage(limitId: string): Promise<
    Array<{
      model: string;
      currentUsageTokensIn: number;
      currentUsageTokensOut: number;
    }>
  > {
    logger.debug({ limitId }, "LimitModel.getRawModelUsage: fetching records");
    const records = await db
      .select()
      .from(schema.limitModelUsageTable)
      .where(eq(schema.limitModelUsageTable.limitId, limitId));

    logger.debug(
      { limitId, count: records.length },
      "LimitModel.getRawModelUsage: completed",
    );
    return records;
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
    // Normalize empty model array to null for consistent "all models" behavior
    const patchData = { ...data };
    if (
      patchData.model !== undefined &&
      (!patchData.model ||
        (Array.isArray(patchData.model) && patchData.model.length === 0))
    ) {
      patchData.model = null;
    }

    const [limit] = await db
      .update(schema.limitsTable)
      .set(patchData)
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
      .where(eq(schema.interactionsTable.profileId, agentId));

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
   * Update token usage for limits of a specific entity and model
   * Used by usage tracking service after interactions
   */
  static async updateTokenLimitUsage(
    entityType: LimitEntityType,
    entityId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    logger.debug(
      { entityType, entityId, model, inputTokens, outputTokens },
      "[LimitModel] Update token limit usage",
    );
    try {
      // Find all token_cost limits for this entity that include this model
      const limits = await db
        .select({ id: schema.limitsTable.id })
        .from(schema.limitsTable)
        .where(
          and(
            eq(schema.limitsTable.entityType, entityType),
            eq(schema.limitsTable.entityId, entityId),
            eq(schema.limitsTable.limitType, "token_cost"),
            or(
              sql`${schema.limitsTable.model} ? ${model}`,
              sql`${schema.limitsTable.model} IS NULL`,
            ),
          ),
        );

      if (limits.length === 0) {
        logger.debug(
          `[LimitModel] No limits found for ${entityType} ${entityId} with model ${model}`,
        );
        return;
      }

      // Update model usage for each limit
      for (const limit of limits) {
        await db
          .insert(schema.limitModelUsageTable)
          .values({
            limitId: limit.id,
            model,
            currentUsageTokensIn: inputTokens,
            currentUsageTokensOut: outputTokens,
          })
          .onConflictDoUpdate({
            target: [
              schema.limitModelUsageTable.limitId,
              schema.limitModelUsageTable.model,
            ],
            set: {
              currentUsageTokensIn: sql`${schema.limitModelUsageTable.currentUsageTokensIn} + ${inputTokens}`,
              currentUsageTokensOut: sql`${schema.limitModelUsageTable.currentUsageTokensOut} + ${outputTokens}`,
              updatedAt: new Date(),
            },
          });

        logger.debug(
          `[LimitModel] Updated model usage for limit ${limit.id}, model ${model}: +${inputTokens} in, +${outputTokens} out`,
        );
      }
    } catch (error) {
      logger.error(
        `Error updating ${entityType} token limit for ${entityId}, model ${model}: ${error}`,
      );
      // Don't throw - continue with other updates
    }
  }

  static async cleanupLimitsIfNeeded(
    options: LimitsCleanupOptions,
  ): Promise<void> {
    try {
      logger.info({ options }, `[LimitsCleanup] Starting cleanup check`);

      const limitIdsToReset = await LimitModel.findLimitIdsToReset(options);
      await LimitModel.resetLimitsUsage(limitIdsToReset);

      if (limitIdsToReset.length > 0) {
        logger.info(
          { options, cleanedLimitIds: limitIdsToReset },
          `[LimitsCleanup] Completed cleanup of ${limitIdsToReset.length} limits`,
        );
      } else {
        logger.info({ options }, `[LimitsCleanup] No limits need cleanup`);
      }
    } catch (error) {
      logger.error(
        { error, options },
        `[LimitsCleanup] Error cleaning up limits`,
      );
      // Don't throw - cleanup is best effort and shouldn't break the main flow
    }
  }

  static async findLimitIdsToReset(
    options: LimitsCleanupOptions,
  ): Promise<string[]> {
    const filterConditions: SQL[] = [];
    if (options.entityType !== undefined) {
      filterConditions.push(
        eq(schema.limitsTable.entityType, options.entityType) as SQL,
      );
    }
    if (options.entityId !== undefined) {
      filterConditions.push(
        eq(schema.limitsTable.entityId, options.entityId) as SQL,
      );
    }
    if (options.limitType !== undefined) {
      filterConditions.push(
        eq(schema.limitsTable.limitType, options.limitType) as SQL,
      );
    }

    const entityIdConditions: SQL[] = [];
    const entities = options.entities;
    if (entities !== undefined) {
      const entityTypes = Object.getOwnPropertyNames(
        entities,
      ) as LimitEntityType[];
      entityTypes.forEach((entityType) => {
        const entityIds = entities[entityType];
        if (entityIds !== undefined) {
          entityIdConditions.push(
            and(
              eq(schema.limitsTable.entityType, entityType),
              Array.isArray(entityIds)
                ? inArray(schema.limitsTable.entityId, entityIds)
                : eq(schema.limitsTable.entityId, entityIds),
            ) as SQL,
          );
        }
      });
    }

    const selectionConditions: SQL[] = [];

    if (filterConditions.length > 0) {
      selectionConditions.push(and(...filterConditions) as SQL);
    }
    if (entityIdConditions.length > 0) {
      selectionConditions.push(or(...entityIdConditions) as SQL);
    }

    const scopeConditions: SQL[] = [];
    if (options.allForOrganizationId !== undefined) {
      scopeConditions.push(
        buildOrganizationLimitScopeCondition(options.allForOrganizationId),
      );
    }
    if (selectionConditions.length > 0) {
      scopeConditions.push(or(...selectionConditions) as SQL);
    }

    if (scopeConditions.length === 0) {
      return [];
    }

    const limitsToReset = await db
      .select({ id: schema.limitsTable.id })
      .from(schema.limitsTable)
      .where(
        and(
          ...scopeConditions,
          or(
            sql`${schema.limitsTable.lastCleanup} IS NULL`,
            buildCleanupDueCondition(),
          ),
        ),
      );

    return limitsToReset.map((l) => l.id);
  }

  /**
   * Reset usage counters for multiple limits at once
   * Sets lastCleanup and resets per-model usage records for token_cost limits
   * Important to run in transaction to mitigate partial reset of token_cost limits usage
   * Partial reset would block requests at least until the next scheduled reset attempt
   */
  static async resetLimitsUsage(
    limitIds: string[],
    now = new Date(),
  ): Promise<void> {
    if (limitIds.length === 0) {
      return;
    }

    await withDbTransaction(async (tx) => {
      const limits = await tx
        .update(schema.limitsTable)
        .set({ lastCleanup: now, updatedAt: now })
        .where(inArray(schema.limitsTable.id, limitIds))
        .returning({
          id: schema.limitsTable.id,
          limitType: schema.limitsTable.limitType,
        });

      const tokenCostLimitIds = limits
        .filter((l) => l.limitType === "token_cost")
        .map((l) => l.id);

      if (tokenCostLimitIds.length === 0) {
        return;
      }

      // Reset model usage records for token_cost limits
      await tx
        .update(schema.limitModelUsageTable)
        .set({
          currentUsageTokensIn: 0,
          currentUsageTokensOut: 0,
          updatedAt: now,
        })
        .where(inArray(schema.limitModelUsageTable.limitId, tokenCostLimitIds));
    });
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

  // Org-scoped audit snapshot via the entity FK.  limitsTable has no
  // organizationId column of its own, so tenancy is resolved through the
  // entity that owns the limit (organization/team/agent/user/virtual_key).
  //
  // The route handler for PATCH/DELETE /api/limits/:id does not enforce this
  // predicate today, but the audit fetcher must — the preHandler runs before
  // route authz, so an unscoped fetch would write another tenant's limit row
  // into the caller's audit_logs even when the route ultimately rejects the
  // request.  Returns null whenever the limit does not belong to the caller's
  // organization.
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.limitsTable)
      .where(eq(schema.limitsTable.id, id))
      .limit(1);

    if (!row) return null;

    const inOrg = await LimitModel.isEntityInOrganization(
      row.entityType,
      row.entityId,
      organizationId,
    );
    if (!inOrg) return null;

    return {
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      limitType: row.limitType,
      limitValue: row.limitValue,
      mcpServerName: row.mcpServerName ?? null,
      toolName: row.toolName ?? null,
      model: row.model ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Verify that a limit's entity (the row identified by `entityType` and
   * `entityId`) belongs to `organizationId`.  Each entity type lives in a
   * different table, so the FK path differs per branch.  Used by the
   * snapshot-before-authz scope predicate in `findByIdForAudit`.
   */
  private static async isEntityInOrganization(
    entityType: LimitEntityType,
    entityId: string,
    organizationId: string,
  ): Promise<boolean> {
    switch (entityType) {
      case "organization":
        return entityId === organizationId;
      case "team": {
        const [hit] = await db
          .select({ id: schema.teamsTable.id })
          .from(schema.teamsTable)
          .where(
            and(
              eq(schema.teamsTable.id, entityId),
              eq(schema.teamsTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
      case "agent": {
        const [hit] = await db
          .select({ id: schema.agentsTable.id })
          .from(schema.agentsTable)
          .where(
            and(
              eq(schema.agentsTable.id, entityId),
              eq(schema.agentsTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
      case "user": {
        const [hit] = await db
          .select({ id: schema.membersTable.id })
          .from(schema.membersTable)
          .where(
            and(
              eq(schema.membersTable.userId, entityId),
              eq(schema.membersTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
      case "virtual_key": {
        const [hit] = await db
          .select({ id: schema.virtualApiKeysTable.id })
          .from(schema.virtualApiKeysTable)
          .where(
            and(
              eq(schema.virtualApiKeysTable.id, entityId),
              eq(schema.virtualApiKeysTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
    }
  }
}

/**
 * Service for validating if current usage has exceeded limits
 * Similar to tool invocation policies but for token cost limits
 */
export class LimitValidationService {
  /**
   * Check if current usage has already exceeded any token cost limits
   * Returns null if allowed, or [refusalMessage, contentMessage] if blocked
   */
  static async checkLimitsBeforeRequest(params: {
    agentId: string;
    userId?: string;
    virtualKeyId?: string;
  }): Promise<null | [string, string]> {
    const { agentId, userId, virtualKeyId } = params;

    try {
      logger.info(
        `[LimitValidation] Starting limit check for agent: ${agentId}`,
      );

      // Get agent's teams to cleanup and check team and organization limits
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);
      logger.info(
        `[LimitValidation] Agent ${agentId} belongs to teams: ${agentTeamIds.join(", ")}`,
      );

      // Get organization ID to cleanup and check organization limits (either from teams or fallback)
      let organizationId: string | null = null;
      if (agentTeamIds.length > 0) {
        const teams = await db
          .select()
          .from(schema.teamsTable)
          .where(inArray(schema.teamsTable.id, agentTeamIds));
        if (teams.length > 0 && teams[0].organizationId) {
          organizationId = teams[0].organizationId;
        }
      } else {
        const [agent] = await db
          .select({ organizationId: schema.agentsTable.organizationId })
          .from(schema.agentsTable)
          .where(eq(schema.agentsTable.id, agentId))
          .limit(1);
        if (agent?.organizationId) {
          organizationId = agent.organizationId;
        }
      }

      const entities: LimitsCleanupOptionsEntities = {
        agent: agentId,
      };
      if (virtualKeyId) {
        entities.virtual_key = virtualKeyId;
      }
      if (userId) {
        entities.user = userId;
      }
      if (agentTeamIds.length > 0) {
        entities.team = agentTeamIds;
      }
      if (organizationId) {
        entities.organization = organizationId;
      }

      logger.info({ entities }, `[LimitValidation] Running limits cleanup`);
      await LimitModel.cleanupLimitsIfNeeded({ entities });

      if (virtualKeyId) {
        logger.info(
          `[LimitValidation] Checking virtual-key-level limits for: ${virtualKeyId}`,
        );
        const vkLimitViolation = await LimitValidationService.checkEntityLimits(
          "virtual_key",
          virtualKeyId,
        );
        if (vkLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by virtual-key-level limit for: ${virtualKeyId}`,
          );
          return vkLimitViolation;
        }
        logger.info(
          `[LimitValidation] Virtual-key-level limits OK for: ${virtualKeyId}`,
        );
      }

      if (userId) {
        logger.info(
          `[LimitValidation] Checking user-level limits for: ${userId}`,
        );
        const userLimitViolation =
          await LimitValidationService.checkEntityLimits("user", userId);
        if (userLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by user-level limit for: ${userId}`,
          );
          return userLimitViolation;
        }
        if (organizationId) {
          const defaultUserLimitViolation =
            await LimitValidationService.checkDefaultUserLimit({
              organizationId,
              userId,
            });
          if (defaultUserLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by default user limit for: ${userId}`,
            );
            return defaultUserLimitViolation;
          }
        }
        logger.info(`[LimitValidation] User-level limits OK for: ${userId}`);
      }

      logger.info(
        `[LimitValidation] Checking agent-level limits for: ${agentId}`,
      );
      const agentLimitViolation =
        await LimitValidationService.checkEntityLimits("agent", agentId);
      if (agentLimitViolation) {
        logger.info(
          `[LimitValidation] BLOCKED by agent-level limit for: ${agentId}`,
        );
        return agentLimitViolation;
      }
      logger.info(`[LimitValidation] Agent-level limits OK for: ${agentId}`);

      // Check team-level limits
      if (agentTeamIds.length > 0) {
        logger.info(
          `[LimitValidation] Checking team-level limits for agent: ${agentId}`,
        );
        const teams = await db
          .select()
          .from(schema.teamsTable)
          .where(inArray(schema.teamsTable.id, agentTeamIds));
        logger.info(
          `[LimitValidation] Found ${teams.length} teams for agent ${agentId}: ${teams.map((t) => `${t.id}(org:${t.organizationId})`).join(", ")}`,
        );

        for (const team of teams) {
          logger.info(
            `[LimitValidation] Checking team limit for team: ${team.id}`,
          );
          const teamLimitViolation =
            await LimitValidationService.checkEntityLimits("team", team.id);
          if (teamLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by team-level limit for team: ${team.id}`,
            );
            return teamLimitViolation;
          }
          logger.info(
            `[LimitValidation] Team-level limits OK for team: ${team.id}`,
          );
        }

        // Check organization-level limits
        if (organizationId) {
          logger.info(
            `[LimitValidation] Checking organization-level limits for org: ${organizationId}`,
          );
          const orgLimitViolation =
            await LimitValidationService.checkEntityLimits(
              "organization",
              organizationId,
            );
          if (orgLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by organization-level limit for org: ${organizationId}`,
            );
            return orgLimitViolation;
          }
          logger.info(
            `[LimitValidation] Organization-level limits OK for org: ${organizationId}`,
          );
        }
      }

      logger.info(
        `[LimitValidation] All limits OK for agent: ${agentId} - ALLOWING request`,
      );
      return null; // No limits exceeded
    } catch (error) {
      logger.error(
        `[LimitValidation] Error checking limits before request: ${error}`,
      );
      // In case of error, allow the request to proceed
      return null;
    }
  }

  /**
   * Check if current token cost usage has exceeded limits for a specific entity
   */
  private static async checkEntityLimits(
    entityType: LimitEntityType,
    entityId: string,
  ): Promise<null | [string, string]> {
    try {
      logger.info(
        `[LimitValidation] Querying limits for ${entityType} ${entityId}`,
      );
      const limits = await LimitModel.findLimitsForValidation(
        entityType,
        entityId,
        "token_cost",
      );

      logger.info(
        `[LimitValidation] Found ${limits.length} token_cost limits for ${entityType} ${entityId}`,
      );

      if (limits.length === 0) {
        logger.info(
          `[LimitValidation] No token_cost limits found for ${entityType} ${entityId} - allowing`,
        );
        return null;
      }

      for (const limit of limits) {
        logger.info(
          `[LimitValidation] Checking limit ${limit.id} for ${entityType} ${entityId}`,
        );

        // For token_cost limits, convert tokens to actual cost using token prices
        let comparisonValue = 0;
        let limitDescription = "tokens";
        let totalTokensIn = 0;
        let totalTokensOut = 0;

        if (limit.limitType === "token_cost") {
          try {
            // Get per-model usage from limit_model_usage table
            const modelUsages = await db
              .select()
              .from(schema.limitModelUsageTable)
              .where(eq(schema.limitModelUsageTable.limitId, limit.id));

            if (modelUsages.length === 0) {
              logger.warn(
                `[LimitValidation] No model usage records found for limit ${limit.id}`,
              );
              comparisonValue = 0;
            } else {
              let totalCost = 0;

              for (const usage of modelUsages) {
                // Track total tokens for metadata
                totalTokensIn += usage.currentUsageTokensIn;
                totalTokensOut += usage.currentUsageTokensOut;

                // Look up model by modelId only — limit usage records don't store provider
                const modelEntry = await ModelModel.findByModelIdOnly(
                  usage.model,
                );
                const pricing = ModelModel.getEffectivePricing(
                  modelEntry,
                  usage.model,
                );

                const inputCost =
                  (usage.currentUsageTokensIn *
                    parseFloat(pricing.pricePerMillionInput)) /
                  1000000;
                const outputCost =
                  (usage.currentUsageTokensOut *
                    parseFloat(pricing.pricePerMillionOutput)) /
                  1000000;
                const modelCost = inputCost + outputCost;

                totalCost += modelCost;

                logger.debug(
                  `[LimitValidation] Model ${usage.model}: ${usage.currentUsageTokensIn} in + ${usage.currentUsageTokensOut} out = $${modelCost.toFixed(2)}`,
                );
              }

              comparisonValue = totalCost;
              limitDescription = "cost_dollars";

              logger.debug(
                `[LimitValidation] Total cost for limit ${limit.id}: $${totalCost.toFixed(2)} across ${modelUsages.length} models`,
              );
            }
          } catch (error) {
            logger.error(
              `[LimitValidation] Error calculating cost for limit ${limit.id}: ${error}`,
            );
          }
        }

        if (comparisonValue >= limit.limitValue) {
          logger.info(
            `[LimitValidation] LIMIT EXCEEDED for ${entityType} ${entityId}: ${comparisonValue} ${limitDescription} >= ${limit.limitValue}`,
          );

          // Calculate remaining based on the comparison type (tokens vs dollars)
          const remaining = Math.max(0, limit.limitValue - comparisonValue);
          const totalTokens = totalTokensIn + totalTokensOut;

          // For metadata, use token counts for programmatic access
          const archestraMetadata = `
<archestra-limit-type>token_cost</archestra-limit-type>
<archestra-limit-entity-type>${entityType}</archestra-limit-entity-type>
<archestra-limit-entity-id>${entityId}</archestra-limit-entity-id>
<archestra-limit-current-usage>${totalTokens}</archestra-limit-current-usage>
<archestra-limit-value>${limit.limitValue}</archestra-limit-value>
<archestra-limit-remaining>${Math.max(0, limit.limitValue - totalTokens)}</archestra-limit-remaining>`;

          // For user message, use appropriate units based on limit type
          let contentMessage: string;
          if (limitDescription === "cost_dollars") {
            contentMessage = `
I cannot process this request because the ${entityType}-level token cost limit has been exceeded.

Current usage: $${comparisonValue.toFixed(2)}
Limit: $${limit.limitValue.toFixed(2)}
Remaining: $${remaining.toFixed(2)}

Please contact your administrator to increase the limit or wait for the usage to reset.`;
          } else {
            contentMessage = `
I cannot process this request because the ${entityType}-level token cost limit has been exceeded.

Current usage: ${totalTokens.toLocaleString()} tokens
Limit: ${limit.limitValue.toLocaleString()} tokens
Remaining: ${Math.max(0, limit.limitValue - totalTokens).toLocaleString()} tokens

Please contact your administrator to increase the limit or wait for the usage to reset.`;
          }

          const refusalMessage = `${archestraMetadata}
${contentMessage}`;

          return [refusalMessage, contentMessage];
        } else {
          logger.info(
            `[LimitValidation] Limit OK for ${entityType} ${entityId}: ${comparisonValue} < ${limit.limitValue}`,
          );
        }
      }

      logger.info(
        `[LimitValidation] All ${limits.length} limits OK for ${entityType} ${entityId}`,
      );
      return null; // No limits exceeded for this entity
    } catch (error) {
      logger.error(
        `[LimitValidation] Error checking ${entityType} limits for ${entityId}: ${error}`,
      );
      return null; // Allow request on error
    }
  }

  private static async checkDefaultUserLimit(params: {
    organizationId: string;
    userId: string;
  }): Promise<null | [string, string]> {
    try {
      const [organization] = await db
        .select({
          defaultUserLimitValue:
            schema.organizationsTable.defaultUserLimitValue,
          defaultUserLimitModel:
            schema.organizationsTable.defaultUserLimitModel,
          defaultUserLimitCleanupInterval:
            schema.organizationsTable.defaultUserLimitCleanupInterval,
        })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, params.organizationId))
        .limit(1);

      if (!organization?.defaultUserLimitValue) {
        return null;
      }

      const customUserLimits = await LimitModel.findLimitsForValidation(
        "user",
        params.userId,
        "token_cost",
      );
      if (customUserLimits.length > 0) {
        logger.info(
          `[LimitValidation] Skipping default user limit for ${params.userId}: custom user limit exists`,
        );
        return null;
      }

      const usage = await getDefaultUserLimitUsage({
        organizationId: params.organizationId,
        userId: params.userId,
        models: normalizeLimitModels(organization.defaultUserLimitModel),
        cleanupInterval: organization.defaultUserLimitCleanupInterval ?? "1w",
      });

      if (usage.cost < organization.defaultUserLimitValue) {
        return null;
      }

      return buildLimitViolationResponse({
        entityType: "user",
        entityId: params.userId,
        limitValue: organization.defaultUserLimitValue,
        comparisonValue: usage.cost,
        limitDescription: "cost_dollars",
        totalTokensIn: usage.tokensIn,
        totalTokensOut: usage.tokensOut,
      });
    } catch (error) {
      logger.error(
        { error, params },
        "[LimitValidation] Error checking default user limit",
      );
      return null;
    }
  }
}

function buildOrganizationLimitScopeCondition(organizationId: string): SQL {
  return or(
    and(
      eq(schema.limitsTable.entityType, "organization"),
      eq(schema.limitsTable.entityId, organizationId),
    ),
    and(
      eq(schema.limitsTable.entityType, "team"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.teamsTable}
        WHERE ${schema.teamsTable.id} = ${schema.limitsTable.entityId}
          AND ${schema.teamsTable.organizationId} = ${organizationId}
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "agent"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.agentsTable}
        WHERE ${schema.agentsTable.id}::text = ${schema.limitsTable.entityId}
          AND ${schema.agentsTable.organizationId} = ${organizationId}
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "user"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.membersTable}
        WHERE ${schema.membersTable.userId} = ${schema.limitsTable.entityId}
          AND ${schema.membersTable.organizationId} = ${organizationId}
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "virtual_key"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.virtualApiKeysTable}
        WHERE ${schema.virtualApiKeysTable.id}::text = ${schema.limitsTable.entityId}
          AND ${schema.virtualApiKeysTable.organizationId} = ${organizationId}
      )`,
    ),
  ) as SQL;
}

function buildCleanupDueCondition(): SQL {
  const intervalConditions = Object.entries(
    LimitModel.limitsCleanupIntervalSqlLiterals,
  ).map(([cleanupInterval, sqlLiteral]) =>
    and(
      eq(
        schema.limitsTable.cleanupInterval,
        cleanupInterval as LimitCleanupInterval,
      ),
      lt(schema.limitsTable.lastCleanup, sql`now() - ${sqlLiteral}::interval`),
    ),
  );

  return or(...intervalConditions) as SQL;
}

async function getDefaultUserLimitUsage(params: {
  organizationId: string;
  userId: string;
  models: string[] | null;
  cleanupInterval: LimitCleanupInterval;
}) {
  const conditions: SQL[] = [
    eq(schema.interactionsTable.userId, params.userId),
    eq(schema.agentsTable.organizationId, params.organizationId),
    sql`${schema.interactionsTable.createdAt} >= now() - ${LimitModel.limitsCleanupIntervalSqlLiterals[params.cleanupInterval]}::interval`,
  ];

  if (params.models && params.models.length > 0) {
    conditions.push(
      inArray(schema.interactionsTable.model, params.models) as SQL,
    );
  }

  const interactions = await db
    .select({
      model: schema.interactionsTable.model,
      cost: schema.interactionsTable.cost,
      inputTokens: schema.interactionsTable.inputTokens,
      outputTokens: schema.interactionsTable.outputTokens,
    })
    .from(schema.interactionsTable)
    .innerJoin(
      schema.agentsTable,
      eq(schema.interactionsTable.profileId, schema.agentsTable.id),
    )
    .where(and(...conditions));

  const modelsMissingCost = Array.from(
    new Set(
      interactions
        .filter(
          (interaction) =>
            interaction.cost === null && interaction.model !== null,
        )
        .map((interaction) => interaction.model as string),
    ),
  );
  const modelEntriesByModelId =
    await ModelModel.findByModelIdsOnly(modelsMissingCost);

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const interaction of interactions) {
    const inputTokens = interaction.inputTokens ?? 0;
    const outputTokens = interaction.outputTokens ?? 0;
    tokensIn += inputTokens;
    tokensOut += outputTokens;

    if (interaction.cost !== null) {
      cost += Number(interaction.cost);
      continue;
    }

    if (!interaction.model) {
      continue;
    }

    const modelEntry = modelEntriesByModelId.get(interaction.model) ?? null;
    const pricing = ModelModel.getEffectivePricing(
      modelEntry,
      interaction.model,
    );
    cost +=
      (inputTokens * parseFloat(pricing.pricePerMillionInput)) / 1000000 +
      (outputTokens * parseFloat(pricing.pricePerMillionOutput)) / 1000000;
  }

  return { cost, tokensIn, tokensOut };
}

function buildLimitViolationResponse(params: {
  entityType: LimitEntityType;
  entityId: string;
  limitValue: number;
  comparisonValue: number;
  limitDescription: "tokens" | "cost_dollars";
  totalTokensIn: number;
  totalTokensOut: number;
}): [string, string] {
  const totalTokens = params.totalTokensIn + params.totalTokensOut;
  const remaining = Math.max(0, params.limitValue - params.comparisonValue);
  const archestraMetadata = `
<archestra-limit-type>token_cost</archestra-limit-type>
<archestra-limit-entity-type>${params.entityType}</archestra-limit-entity-type>
<archestra-limit-entity-id>${params.entityId}</archestra-limit-entity-id>
<archestra-limit-current-usage>${totalTokens}</archestra-limit-current-usage>
<archestra-limit-value>${params.limitValue}</archestra-limit-value>
<archestra-limit-remaining>${Math.max(0, params.limitValue - totalTokens)}</archestra-limit-remaining>`;

  const contentMessage =
    params.limitDescription === "cost_dollars"
      ? `
I cannot process this request because the ${params.entityType}-level token cost limit has been exceeded.

Current usage: $${params.comparisonValue.toFixed(2)}
Limit: $${params.limitValue.toFixed(2)}
Remaining: $${remaining.toFixed(2)}

Please contact your administrator to increase the limit or wait for the usage to reset.`
      : `
I cannot process this request because the ${params.entityType}-level token cost limit has been exceeded.

Current usage: ${totalTokens.toLocaleString()} tokens
Limit: ${params.limitValue.toLocaleString()} tokens
Remaining: ${Math.max(0, params.limitValue - totalTokens).toLocaleString()} tokens

Please contact your administrator to increase the limit or wait for the usage to reset.`;

  return [`${archestraMetadata}\n${contentMessage}`, contentMessage];
}

function normalizeLimitModels(models: string[] | null | undefined) {
  if (!models || models.length === 0) {
    return null;
  }

  return models;
}

export default LimitModel;
