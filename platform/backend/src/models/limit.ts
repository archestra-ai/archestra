import { ALL_MODELS_SENTINEL } from "@shared";
import { and, eq, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { metrics } from "@/observability";
import type {
  CreateLimit,
  Limit,
  LimitEntityType,
  LimitType,
  UpdateLimit,
} from "@/types";
import AgentTeamModel from "./agent-team";
import ModelModel from "./model";

class LimitModel {
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
   * Seed one `limit_model_usage` row per concrete model. For `["*"]` limits
   * we skip seeding — rows are created lazily on first use via upsert.
   */
  static async initializeModelUsageRecords(
    limitId: string,
    models: string[],
  ): Promise<void> {
    if (!models || models.length === 0) {
      return;
    }
    if (models.includes(ALL_MODELS_SENTINEL)) {
      // ["*"] covers every model; lazy-create usage rows at first use instead.
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
   * List limits for one org. `organizationId` is required to prevent
   * cross-org listing via the polymorphic `entity_id` column.
   */
  static async findAll(params: {
    organizationId: string;
    entityType?: LimitEntityType;
    entityId?: string;
    limitType?: LimitType;
  }): Promise<Limit[]> {
    const { organizationId, entityType, entityId, limitType } = params;
    const whereConditions: SQL[] = [
      eq(schema.limitsTable.organizationId, organizationId),
    ];

    if (entityType) {
      whereConditions.push(eq(schema.limitsTable.entityType, entityType));
    }

    if (entityId) {
      whereConditions.push(eq(schema.limitsTable.entityId, entityId));
    }

    if (limitType) {
      whereConditions.push(eq(schema.limitsTable.limitType, limitType));
    }

    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(and(...whereConditions));

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
   * Read a limit by id. Pass `organizationId` from routes to block cross-org
   * reads; leave it undefined for internal cross-org lookups (cleanup, tests).
   */
  static async findById(
    id: string,
    organizationId?: string,
  ): Promise<Limit | null> {
    const conditions: SQL[] = [eq(schema.limitsTable.id, id)];
    if (organizationId) {
      conditions.push(eq(schema.limitsTable.organizationId, organizationId));
    }

    const [limit] = await db
      .select()
      .from(schema.limitsTable)
      .where(and(...conditions));

    return limit || null;
  }

  /** Update a limit. `organizationId` scopes the write; returns null on cross-org id. */
  static async patch(params: {
    id: string;
    data: Partial<UpdateLimit>;
    organizationId?: string;
  }): Promise<Limit | null> {
    const { id, data, organizationId } = params;
    const conditions: SQL[] = [eq(schema.limitsTable.id, id)];
    if (organizationId) {
      conditions.push(eq(schema.limitsTable.organizationId, organizationId));
    }

    const [limit] = await db
      .update(schema.limitsTable)
      .set(data)
      .where(and(...conditions))
      .returning();

    return limit || null;
  }

  /** Delete a limit. `organizationId` scopes the write; returns false on cross-org id. */
  static async delete(id: string, organizationId?: string): Promise<boolean> {
    const conditions: SQL[] = [eq(schema.limitsTable.id, id)];
    if (organizationId) {
      conditions.push(eq(schema.limitsTable.organizationId, organizationId));
    }

    const deleted = await db
      .delete(schema.limitsTable)
      .where(and(...conditions))
      .returning({ id: schema.limitsTable.id });

    return deleted.length > 0;
  }

  /** Manual cascade: `entity_id` is polymorphic text with no FK, so callers delete limits when the target is removed. */
  static async deleteByEntity(
    entityType: LimitEntityType,
    entityId: string,
  ): Promise<number> {
    const deleted = await db
      .delete(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.entityType, entityType),
          eq(schema.limitsTable.entityId, entityId),
        ),
      )
      .returning({ id: schema.limitsTable.id });

    if (deleted.length > 0) {
      logger.info(
        { entityType, entityId, deleted: deleted.length },
        "LimitModel.deleteByEntity: removed orphaned limits",
      );
    }

    return deleted.length;
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
   * Credit tokens to any limit in `organizationId` whose `model[]` covers the
   * incoming model or contains `["*"]`. Usage rows are keyed by model name.
   * `organizationId` is required so a user present in multiple orgs does not
   * leak usage across them.
   */
  static async updateTokenLimitUsage(
    entityType: LimitEntityType,
    entityId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    organizationId: string,
  ): Promise<void> {
    logger.debug(
      {
        entityType,
        entityId,
        organizationId,
        model,
        inputTokens,
        outputTokens,
      },
      "[LimitModel] Update token limit usage",
    );
    try {
      // Match either `model @> [incoming]` or `model @> ["*"]`.
      const limits = await db
        .select({ id: schema.limitsTable.id })
        .from(schema.limitsTable)
        .where(
          and(
            eq(schema.limitsTable.organizationId, organizationId),
            eq(schema.limitsTable.entityType, entityType),
            eq(schema.limitsTable.entityId, entityId),
            eq(schema.limitsTable.limitType, "token_cost"),
            or(
              sql`${schema.limitsTable.model} @> ${JSON.stringify([model])}::jsonb`,
              sql`${schema.limitsTable.model} @> ${JSON.stringify([ALL_MODELS_SENTINEL])}::jsonb`,
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

  /** Find org limits whose `lastCleanup` is NULL or older than `cutoffTime`. */
  static async findLimitsNeedingCleanup(
    organizationId: string,
    cutoffTime: Date,
  ): Promise<Limit[]> {
    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.organizationId, organizationId),
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
   * Sets lastCleanup and resets per-model usage records for token_cost limits
   */
  static async resetLimitUsage(id: string): Promise<Limit | null> {
    const now = new Date();

    const [limit] = await db
      .update(schema.limitsTable)
      .set({
        lastCleanup: now,
        updatedAt: now,
      })
      .where(eq(schema.limitsTable.id, id))
      .returning();

    // Reset model usage records for token_cost limits
    if (limit && limit.limitType === "token_cost") {
      await db
        .update(schema.limitModelUsageTable)
        .set({
          currentUsageTokensIn: 0,
          currentUsageTokensOut: 0,
          updatedAt: now,
        })
        .where(eq(schema.limitModelUsageTable.limitId, id));
    }

    return limit || null;
  }

  /**
   * Limits in `organizationId` matching the given entity. `organizationId` is
   * required so a multi-org user cannot leak enforcement across orgs.
   */
  static async findLimitsForValidation(
    entityType: LimitEntityType,
    entityId: string,
    organizationId: string,
    limitType: LimitType = "token_cost",
  ): Promise<Limit[]> {
    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.organizationId, organizationId),
          eq(schema.limitsTable.entityType, entityType),
          eq(schema.limitsTable.entityId, entityId),
          eq(schema.limitsTable.limitType, limitType),
        ),
      );

    return limits;
  }

  static async cleanupLimitsIfNeeded(organizationId: string): Promise<void> {
    try {
      logger.info(
        `[LimitsCleanup] Starting cleanup check for organization: ${organizationId}`,
      );

      // Get the organization's cleanup interval
      const [organization] = await db
        .select()
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, organizationId));

      // Use default cleanup interval if not set
      const cleanupInterval = organization?.limitCleanupInterval || "1h";

      if (!organization) {
        logger.warn(
          `[LimitsCleanup] Organization not found: ${organizationId}, using default interval: ${cleanupInterval}`,
        );
      } else if (!organization.limitCleanupInterval) {
        logger.info(
          `[LimitsCleanup] No cleanup interval set for organization: ${organizationId}, using default: ${cleanupInterval}`,
        );
      } else {
        logger.info(
          `[LimitsCleanup] Using cleanup interval: ${cleanupInterval} for organization: ${organizationId}`,
        );
      }

      // Parse the interval and calculate the cutoff time
      const interval = cleanupInterval;
      const now = new Date();
      let cutoffTime: Date;

      switch (interval) {
        case "1h":
          cutoffTime = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case "12h":
          cutoffTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
          break;
        case "24h":
          cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case "1w":
          cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case "1m":
          cutoffTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          logger.warn(
            `[LimitsCleanup] Unknown cleanup interval: ${interval}, skipping cleanup`,
          );
          return;
      }

      logger.info(
        `[LimitsCleanup] Calculated cutoff time: ${cutoffTime.toISOString()} (interval: ${interval})`,
      );

      // Find limits that need cleanup (last_cleanup is null or older than cutoff)
      const limitsToCleanup = await LimitModel.findLimitsNeedingCleanup(
        organizationId,
        cutoffTime,
      );

      logger.info(
        `[LimitsCleanup] Found ${limitsToCleanup.length} limits that need cleanup for organization: ${organizationId}`,
      );

      if (limitsToCleanup.length > 0) {
        logger.info(
          `[LimitsCleanup] Limits to cleanup: ${limitsToCleanup.map((l) => `${l.id}(${l.limitType}:${l.lastCleanup ? l.lastCleanup.toISOString() : "never"})`).join(", ")}`,
        );
      }

      // Reset current usage and update last cleanup for eligible limits
      if (limitsToCleanup.length > 0) {
        for (const limit of limitsToCleanup) {
          logger.info(
            `[LimitsCleanup] Cleaning up limit ${limit.id}: ${limit.limitType}, lastCleanup=${limit.lastCleanup ? limit.lastCleanup.toISOString() : "never"}`,
          );

          await LimitModel.resetLimitUsage(limit.id);

          logger.info(
            `[LimitsCleanup] Successfully cleaned up limit ${limit.id}, reset model usage to 0 and set lastCleanup to ${now.toISOString()}`,
          );
        }

        logger.info(
          `[LimitsCleanup] Completed cleanup of ${limitsToCleanup.length} limits for organization: ${organizationId}`,
        );
      } else {
        logger.info(
          `[LimitsCleanup] No limits need cleanup for organization: ${organizationId}`,
        );
      }
    } catch (error) {
      logger.error(
        { error },
        `[LimitsCleanup] Error cleaning up limits for organization ${organizationId}`,
      );
      // Don't throw - cleanup is best effort and shouldn't break the main flow
    }
  }
}

/**
 * Context for `checkLimitsBeforeRequest`. `billedUserId`/`virtualKeyId` are
 * `undefined` when not applicable; the matching scope is then skipped.
 */
export interface LimitViolation {
  scope: LimitEntityType;
  contentMessage: string;
}

export interface CheckLimitsContext {
  agentId: string;
  organizationId: string;
  billedUserId?: string;
  virtualKeyId?: string;
  model: string;
}

/**
 * Service for validating if current usage has exceeded limits
 * Similar to tool invocation policies but for token cost limits
 */
export class LimitValidationService {
  /**
   * Return the first scope over its token-cost limit, or null if allowed.
   * Order (short-circuit on first hit): virtual_api_key → user → agent → teams → organization.
   */
  static async checkLimitsBeforeRequest(
    ctx: CheckLimitsContext,
  ): Promise<null | LimitViolation> {
    const { agentId, organizationId, billedUserId, virtualKeyId, model } = ctx;
    try {
      logger.debug(
        { agentId, organizationId, billedUserId, virtualKeyId, model },
        "[LimitValidation] Starting limit check",
      );

      await LimitModel.cleanupLimitsIfNeeded(organizationId);

      // 1. Virtual API key scope
      if (virtualKeyId) {
        const violation = await LimitValidationService.checkEntityLimits(
          "virtual_api_key",
          virtualKeyId,
          model,
          organizationId,
        );
        if (violation) {
          logger.info(
            { scope: "virtual_api_key", entityId: virtualKeyId },
            "[LimitValidation] BLOCKED",
          );
          return violation;
        }
      }

      // 2. User scope — only for identifiable humans (chat UI / personal key / JWKS).
      if (billedUserId) {
        const violation = await LimitValidationService.checkEntityLimits(
          "user",
          billedUserId,
          model,
          organizationId,
        );
        if (violation) {
          logger.info(
            { scope: "user", entityId: billedUserId },
            "[LimitValidation] BLOCKED",
          );
          return violation;
        }
      }

      // 3. Agent scope
      const agentViolation = await LimitValidationService.checkEntityLimits(
        "agent",
        agentId,
        model,
        organizationId,
      );
      if (agentViolation) {
        logger.info(
          { scope: "agent", entityId: agentId },
          "[LimitValidation] BLOCKED",
        );
        return agentViolation;
      }

      // 4. Team scope — iterate over agent's teams
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);
      for (const teamId of agentTeamIds) {
        const violation = await LimitValidationService.checkEntityLimits(
          "team",
          teamId,
          model,
          organizationId,
        );
        if (violation) {
          logger.info(
            { scope: "team", entityId: teamId },
            "[LimitValidation] BLOCKED",
          );
          return violation;
        }
      }

      // 5. Organization scope
      const orgViolation = await LimitValidationService.checkEntityLimits(
        "organization",
        organizationId,
        model,
        organizationId,
      );
      if (orgViolation) {
        logger.info(
          { scope: "organization", entityId: organizationId },
          "[LimitValidation] BLOCKED",
        );
        return orgViolation;
      }

      logger.info(
        { agentId },
        "[LimitValidation] ALLOWED — all scopes within limit",
      );
      return null;
    } catch (error) {
      logger.error(
        { err: error, ctx },
        "[LimitValidation] Error checking limits before request",
      );
      // Fail-open: a DB/pricing outage must not wedge the proxy.
      // The counter surfaces silently-disabled enforcement.
      metrics.llm.reportLimitCheckErrored("");
      return null;
    }
  }

  /**
   * Check one scope. Limits whose `model[]` does not cover `incomingModel`
   * are skipped so an exhausted Claude limit never blocks an OpenAI request.
   */
  private static async checkEntityLimits(
    entityType: LimitEntityType,
    entityId: string,
    incomingModel: string,
    organizationId: string,
  ): Promise<null | LimitViolation> {
    try {
      logger.debug(
        `[LimitValidation] Querying limits for ${entityType} ${entityId}`,
      );
      const limits = await LimitModel.findLimitsForValidation(
        entityType,
        entityId,
        organizationId,
        "token_cost",
      );

      logger.debug(
        `[LimitValidation] Found ${limits.length} token_cost limits for ${entityType} ${entityId}`,
      );

      if (limits.length === 0) {
        return null;
      }

      for (const limit of limits) {
        if (!limitAppliesToModel(limit.model, incomingModel)) {
          logger.debug(
            { limitId: limit.id, limitModels: limit.model, incomingModel },
            "[LimitValidation] Skipping limit — model[] does not cover incoming request",
          );
          continue;
        }

        logger.debug(
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
              logger.debug(
                { limitId: limit.id },
                "[LimitValidation] No model usage records yet for limit (e.g. fresh ['*'] limit)",
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
          logger.debug(
            `[LimitValidation] LIMIT EXCEEDED for ${entityType} ${entityId}: ${comparisonValue} ${limitDescription} >= ${limit.limitValue}`,
          );

          const remaining = Math.max(0, limit.limitValue - comparisonValue);
          const totalTokens = totalTokensIn + totalTokensOut;

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

          return { scope: entityType, contentMessage };
        }
      }

      return null;
    } catch (error) {
      logger.error(
        `[LimitValidation] Error checking ${entityType} limits for ${entityId}: ${error}`,
      );
      metrics.llm.reportLimitCheckErrored(entityType);
      return null; // Allow request on error
    }
  }
}

export default LimitModel;

/**
 * True if the limit's `model[]` covers `incomingModel`:
 * null/empty → false; contains `["*"]` → true; else exact membership.
 */
function limitAppliesToModel(
  limitModels: string[] | null | undefined,
  incomingModel: string,
): boolean {
  if (!limitModels || limitModels.length === 0) return false;
  if (limitModels.includes(ALL_MODELS_SENTINEL)) return true;
  return limitModels.includes(incomingModel);
}
