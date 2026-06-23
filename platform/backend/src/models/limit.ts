import { and, eq, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import logger from "@/logging";
import type {
  CreateLimit,
  Limit,
  LimitCleanupInterval,
  LimitEntityType,
  LimitType,
  UpdateLimit,
} from "@/types";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import EnvironmentDefaultUserLimitModel from "./environment-default-user-limit";
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
type RollingLimitCleanupInterval = Extract<
  LimitCleanupInterval,
  "1h" | "12h" | "24h" | "1w" | "1m"
>;

type LimitModelUsageRecord = typeof schema.limitModelUsageTable.$inferSelect;
type LimitViolationResponse = [
  refusalMessage: string,
  contentMessage: string,
  metadata?: {
    entityType: LimitEntityType;
    limitType: "token_cost";
  },
];

const DEFAULT_LIMIT_CLEANUP_INTERVAL: LimitCleanupInterval = "calendar_month";

class LimitModel {
  // rollingCleanupIntervalSqlLiterals exists to compile-time check rolling literals.
  static readonly rollingCleanupIntervalSqlLiterals: Record<
    RollingLimitCleanupInterval,
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
      .values({
        ...data,
        cleanupInterval: data.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
      })
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
    const modelUsages = await db
      .select()
      .from(schema.limitModelUsageTable)
      .where(eq(schema.limitModelUsageTable.limitId, limitId));

    return (await calculateModelUsageCosts(modelUsages)).breakdown;
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

    const [limit] = await db.transaction(async (tx) => {
      const [existingLimit] = await tx
        .select()
        .from(schema.limitsTable)
        .where(eq(schema.limitsTable.id, id))
        .limit(1);

      if (!existingLimit) {
        return [];
      }

      const shouldResetUsage =
        patchData.cleanupInterval !== undefined &&
        patchData.cleanupInterval !== existingLimit.cleanupInterval;
      const limitPatchData = shouldResetUsage
        ? { ...patchData, lastCleanup: sql`now()` }
        : patchData;

      const updatedLimits = await tx
        .update(schema.limitsTable)
        .set(limitPatchData)
        .where(eq(schema.limitsTable.id, id))
        .returning();

      if (shouldResetUsage) {
        await tx
          .update(schema.limitModelUsageTable)
          .set({
            currentUsageTokensIn: 0,
            currentUsageTokensOut: 0,
          })
          .where(eq(schema.limitModelUsageTable.limitId, id));
      }

      return updatedLimits;
    });

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

  // Org-scoped fetch for PATCH/DELETE authorization.  limitsTable has no
  // organizationId column, so tenancy is resolved through the entity that owns
  // the limit.  Returns null when the limit does not belong to the caller's
  // organization (treated as 404 by routes).
  static async findByIdInOrganization(
    id: string,
    organizationId: string,
  ): Promise<Limit | null> {
    const limit = await LimitModel.findById(id);
    if (!limit) return null;

    const inOrg = await LimitModel.isEntityInOrganization(
      limit.entityType,
      limit.entityId,
      organizationId,
    );
    return inOrg ? limit : null;
  }

  /**
   * Verify that a limit's entity (the row identified by `entityType` and
   * `entityId`) belongs to `organizationId`.  Each entity type lives in a
   * different table, so the FK path differs per branch.  Used by the
   * snapshot-before-authz scope predicate in `findByIdForAudit`, by the
   * org-scoping guards on create/update/delete routes, and by
   * `findByIdInOrganization`.
   */
  static async isEntityInOrganization(
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
        return AgentModel.existsInOrganization({
          id: entityId,
          organizationId,
        });
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
      case "environment": {
        const [hit] = await db
          .select({ id: schema.environmentsTable.id })
          .from(schema.environmentsTable)
          .where(
            and(
              eq(schema.environmentsTable.id, entityId),
              eq(schema.environmentsTable.organizationId, organizationId),
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
   * Returns null if allowed, or a refusal tuple if blocked.
   */
  static async checkLimitsBeforeRequest(params: {
    agentId: string;
    userId?: string;
    virtualKeyId?: string;
  }): Promise<null | LimitViolationResponse> {
    const { agentId, userId, virtualKeyId } = params;

    try {
      logger.debug(
        `[LimitValidation] Starting limit check for agent: ${agentId}`,
      );

      // Get agent's teams to cleanup and check team and organization limits
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);
      logger.debug(
        `[LimitValidation] Agent ${agentId} belongs to teams: ${agentTeamIds.join(", ")}`,
      );

      // Get organization ID to cleanup and check organization limits (either from teams or fallback)
      let organizationId: string | null = null;
      let agentTeams: (typeof schema.teamsTable.$inferSelect)[] = [];
      if (agentTeamIds.length > 0) {
        agentTeams = await db
          .select()
          .from(schema.teamsTable)
          .where(inArray(schema.teamsTable.id, agentTeamIds));
        if (agentTeams.length > 0 && agentTeams[0].organizationId) {
          organizationId = agentTeams[0].organizationId;
        }
      } else {
        organizationId = await AgentModel.findOrganizationId(agentId);
      }

      // Resolve the agent's environment (nullable). Used for environment-scoped
      // limits and per-environment default-user limits.
      const environmentId = await AgentModel.findEnvironmentId(agentId);

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
      if (environmentId) {
        entities.environment = environmentId;
      }

      logger.debug({ entities }, `[LimitValidation] Running limits cleanup`);
      await LimitModel.cleanupLimitsIfNeeded({ entities });

      if (virtualKeyId) {
        logger.debug(
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
        logger.debug(
          `[LimitValidation] Virtual-key-level limits OK for: ${virtualKeyId}`,
        );
      }

      if (userId) {
        logger.debug(
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
              environmentId,
            });
          if (defaultUserLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by default user limit for: ${userId}`,
            );
            return defaultUserLimitViolation;
          }
        }
        logger.debug(`[LimitValidation] User-level limits OK for: ${userId}`);
      }

      logger.debug(
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
      logger.debug(`[LimitValidation] Agent-level limits OK for: ${agentId}`);

      // Check environment-level limits (total usage across all users in the
      // agent's environment).
      if (environmentId) {
        logger.debug(
          `[LimitValidation] Checking environment-level limits for: ${environmentId}`,
        );
        const environmentLimitViolation =
          await LimitValidationService.checkEntityLimits(
            "environment",
            environmentId,
          );
        if (environmentLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by environment-level limit for: ${environmentId}`,
          );
          return environmentLimitViolation;
        }
        logger.debug(
          `[LimitValidation] Environment-level limits OK for: ${environmentId}`,
        );
      }

      // Check team-level limits
      if (agentTeamIds.length > 0) {
        logger.debug(
          `[LimitValidation] Checking team-level limits for agent: ${agentId}`,
        );
        logger.debug(
          `[LimitValidation] Found ${agentTeams.length} teams for agent ${agentId}: ${agentTeams.map((t) => `${t.id}(org:${t.organizationId})`).join(", ")}`,
        );

        for (const team of agentTeams) {
          logger.debug(
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
          logger.debug(
            `[LimitValidation] Team-level limits OK for team: ${team.id}`,
          );
        }
      }

      // Check organization-level limits for any agent with a resolvable org.
      if (organizationId) {
        logger.debug(
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
        logger.debug(
          `[LimitValidation] Organization-level limits OK for org: ${organizationId}`,
        );
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
  ): Promise<null | LimitViolationResponse> {
    try {
      logger.debug(
        `[LimitValidation] Querying limits for ${entityType} ${entityId}`,
      );
      const limits = await LimitModel.findLimitsForValidation(
        entityType,
        entityId,
        "token_cost",
      );

      logger.debug(
        `[LimitValidation] Found ${limits.length} token_cost limits for ${entityType} ${entityId}`,
      );

      if (limits.length === 0) {
        logger.debug(
          `[LimitValidation] No token_cost limits found for ${entityType} ${entityId} - allowing`,
        );
        return null;
      }

      for (const limit of limits) {
        logger.debug(
          `[LimitValidation] Checking limit ${limit.id} for ${entityType} ${entityId}`,
        );

        // For token_cost limits, convert tokens to actual cost using token prices
        let comparisonValue = 0;
        let limitDescription: "tokens" | "cost_dollars" = "tokens";
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
              const usageCosts = await calculateModelUsageCosts(modelUsages);
              for (const usage of usageCosts.breakdown) {
                logger.debug(
                  `[LimitValidation] Model ${usage.model}: ${usage.tokensIn} in + ${usage.tokensOut} out = $${usage.cost.toFixed(2)}`,
                );
              }

              totalTokensIn = usageCosts.tokensIn;
              totalTokensOut = usageCosts.tokensOut;
              comparisonValue = usageCosts.cost;
              limitDescription = "cost_dollars";

              logger.debug(
                `[LimitValidation] Total cost for limit ${limit.id}: $${usageCosts.cost.toFixed(2)} across ${modelUsages.length} models`,
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

          return buildLimitViolationResponse({
            entityType,
            entityId,
            limitValue: limit.limitValue,
            comparisonValue,
            limitDescription,
            totalTokensIn,
            totalTokensOut,
          });
        } else {
          logger.debug(
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
    environmentId?: string | null;
  }): Promise<null | LimitViolationResponse> {
    try {
      // A custom per-user limit always wins and disables every default
      // (org-wide and per-environment) for that user.
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

      // A per-environment default overrides the org-wide default for requests in
      // that environment; environments without one fall back to the org-wide
      // default below.
      if (params.environmentId) {
        const envDefault =
          await EnvironmentDefaultUserLimitModel.findByEnvironmentId(
            params.environmentId,
          );
        if (envDefault) {
          const usage = await getDefaultUserLimitUsage({
            organizationId: params.organizationId,
            userId: params.userId,
            environmentId: params.environmentId,
            models: normalizeLimitModels(envDefault.model),
            cleanupInterval: envDefault.cleanupInterval,
          });

          if (usage.cost < envDefault.limitValue) {
            return null;
          }

          return buildLimitViolationResponse({
            entityType: "environment",
            entityId: params.environmentId,
            limitValue: envDefault.limitValue,
            comparisonValue: usage.cost,
            limitDescription: "cost_dollars",
            totalTokensIn: usage.tokensIn,
            totalTokensOut: usage.tokensOut,
          });
        }
      }

      // The organization-wide default is the NULL-environment row in the
      // unified default-user-limits store. Its usage spans the user's whole org
      // (no environment filter).
      const globalDefault = await EnvironmentDefaultUserLimitModel.findGlobal(
        params.organizationId,
      );
      if (!globalDefault) {
        return null;
      }

      const usage = await getDefaultUserLimitUsage({
        organizationId: params.organizationId,
        userId: params.userId,
        models: normalizeLimitModels(globalDefault.model),
        cleanupInterval: globalDefault.cleanupInterval,
      });

      if (usage.cost < globalDefault.limitValue) {
        return null;
      }

      return buildLimitViolationResponse({
        entityType: "user",
        entityId: params.userId,
        limitValue: globalDefault.limitValue,
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

const calendarCleanupIntervals = [
  "calendar_day",
  "calendar_week_sunday",
  "calendar_week_monday",
  "calendar_month",
] as const satisfies readonly LimitCleanupInterval[];

type CalendarLimitCleanupInterval = (typeof calendarCleanupIntervals)[number];

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
          AND ${schema.agentsTable.deletedAt} IS NULL
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
    and(
      eq(schema.limitsTable.entityType, "environment"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.environmentsTable}
        WHERE ${schema.environmentsTable.id}::text = ${schema.limitsTable.entityId}
          AND ${schema.environmentsTable.organizationId} = ${organizationId}
      )`,
    ),
  ) as SQL;
}

function buildCleanupDueCondition(): SQL {
  const intervalConditions = Object.entries(
    LimitModel.rollingCleanupIntervalSqlLiterals,
  ).map(([cleanupInterval, sqlLiteral]) =>
    and(
      eq(
        schema.limitsTable.cleanupInterval,
        cleanupInterval as LimitCleanupInterval,
      ),
      lt(schema.limitsTable.lastCleanup, sql`now() - ${sqlLiteral}::interval`),
    ),
  );

  intervalConditions.push(
    ...calendarCleanupIntervals.map((cleanupInterval) =>
      and(
        eq(schema.limitsTable.cleanupInterval, cleanupInterval),
        lt(
          schema.limitsTable.lastCleanup,
          getCalendarPeriodStartSql(cleanupInterval),
        ),
      ),
    ),
  );

  return or(...intervalConditions) as SQL;
}

function buildUsagePeriodStartCondition(
  cleanupInterval: LimitCleanupInterval,
): SQL {
  const rollingInterval =
    LimitModel.rollingCleanupIntervalSqlLiterals[
      cleanupInterval as RollingLimitCleanupInterval
    ];
  if (rollingInterval) {
    return sql`${schema.interactionsTable.createdAt} >= now() - ${rollingInterval}::interval`;
  }

  if (isCalendarCleanupInterval(cleanupInterval)) {
    return sql`${schema.interactionsTable.createdAt} >= ${getCalendarPeriodStartSql(cleanupInterval)}`;
  }

  throw new Error(`Unsupported cleanup interval: ${cleanupInterval}`);
}

function getCalendarPeriodStartSql(
  cleanupInterval: CalendarLimitCleanupInterval,
): SQL {
  switch (cleanupInterval) {
    case "calendar_day":
      return sql`date_trunc('day', now())`;
    case "calendar_week_sunday":
      return sql`date_trunc('day', now()) - (extract(dow from now()) * interval '1 day')`;
    case "calendar_week_monday":
      return sql`date_trunc('week', now())`;
    case "calendar_month":
      return sql`date_trunc('month', now())`;
  }
}

function isCalendarCleanupInterval(
  cleanupInterval: LimitCleanupInterval,
): cleanupInterval is CalendarLimitCleanupInterval {
  return calendarCleanupIntervals.includes(
    cleanupInterval as CalendarLimitCleanupInterval,
  );
}

async function calculateModelUsageCosts(modelUsages: LimitModelUsageRecord[]) {
  const modelEntriesByModelId = await ModelModel.findByModelIdsOnly(
    Array.from(new Set(modelUsages.map((usage) => usage.model))),
  );

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const breakdown = modelUsages.map((usage) => {
    tokensIn += usage.currentUsageTokensIn;
    tokensOut += usage.currentUsageTokensOut;

    const modelEntry = modelEntriesByModelId.get(usage.model) ?? null;
    const pricing = ModelModel.getEffectivePricing(modelEntry, usage.model);
    const modelCost =
      (usage.currentUsageTokensIn * parseFloat(pricing.pricePerMillionInput)) /
        1_000_000 +
      (usage.currentUsageTokensOut *
        parseFloat(pricing.pricePerMillionOutput)) /
        1_000_000;
    cost += modelCost;

    return {
      model: usage.model,
      tokensIn: usage.currentUsageTokensIn,
      tokensOut: usage.currentUsageTokensOut,
      cost: modelCost,
    };
  });

  return { breakdown, cost, tokensIn, tokensOut };
}

async function getDefaultUserLimitUsage(params: {
  organizationId: string;
  userId: string;
  models: string[] | null;
  cleanupInterval: LimitCleanupInterval;
  environmentId?: string | null;
}) {
  const conditions: SQL[] = [
    eq(schema.interactionsTable.userId, params.userId),
    buildUsagePeriodStartCondition(params.cleanupInterval),
  ];

  if (params.models && params.models.length > 0) {
    conditions.push(
      inArray(schema.interactionsTable.model, params.models) as SQL,
    );
  }

  const selection = {
    model: schema.interactionsTable.model,
    cost: schema.interactionsTable.cost,
    inputTokens: schema.interactionsTable.inputTokens,
    outputTokens: schema.interactionsTable.outputTokens,
  };

  // Environment-scoped usage filters on the environment snapshotted on the
  // interaction at request time. An environment belongs to exactly one org, so
  // this already scopes to the org without joining the agent — and, like the
  // incremental environment counter, it must count usage even after the
  // originating agent is deleted (no `notDeleted(agent)` join).
  const interactions = params.environmentId
    ? await db
        .select(selection)
        .from(schema.interactionsTable)
        .where(
          and(
            ...conditions,
            eq(schema.interactionsTable.environmentId, params.environmentId),
          ),
        )
    : await db
        .select(selection)
        .from(schema.interactionsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
        )
        .where(
          and(
            ...conditions,
            eq(schema.agentsTable.organizationId, params.organizationId),
            notDeleted(schema.agentsTable),
          ),
        );

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
}): LimitViolationResponse {
  const totalTokens = params.totalTokensIn + params.totalTokensOut;
  const remaining = Math.max(0, params.limitValue - params.comparisonValue);
  const archestraMetadata = `
<archestra-limit-type>token_cost</archestra-limit-type>
<archestra-limit-entity-type>${params.entityType}</archestra-limit-entity-type>
<archestra-limit-entity-id>${params.entityId}</archestra-limit-entity-id>
<archestra-limit-current-usage>${totalTokens}</archestra-limit-current-usage>
<archestra-limit-value>${params.limitValue}</archestra-limit-value>
<archestra-limit-remaining>${remaining}</archestra-limit-remaining>`;

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

  return [
    `${archestraMetadata}\n${contentMessage}`,
    contentMessage,
    { entityType: params.entityType, limitType: "token_cost" },
  ];
}

function normalizeLimitModels(models: string[] | null | undefined) {
  if (!models || models.length === 0) {
    return null;
  }

  return models;
}

export default LimitModel;
