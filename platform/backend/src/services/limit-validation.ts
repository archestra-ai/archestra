import { inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { AgentTeamModel, LimitModel, TokenPriceModel } from "@/models";
import { cleanupLimitsIfNeeded } from "@/utils/limits-cleanup";

/**
 * Service for validating if current usage has exceeded limits
 * Similar to tool invocation policies but for token cost limits
 */
class LimitValidationService {
  /**
   * Check if current usage has already exceeded any token cost limits
   * Returns null if allowed, or [refusalMessage, contentMessage] if blocked
   */
  static async checkLimitsBeforeRequest(
    agentId: string,
  ): Promise<null | [string, string]> {
    try {
      logger.info(
        `[LimitValidation] Starting limit check for agent: ${agentId}`,
      );

      // Get agent's teams to check team and organization limits
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);
      logger.info(
        `[LimitValidation] Agent ${agentId} belongs to teams: ${agentTeamIds.join(", ")}`,
      );

      // Get organization ID for cleanup (either from teams or fallback)
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
        // If agent has no teams, check if there are any organization limits to apply
        const existingOrgLimits = await db
          .select({ entityId: schema.limitsTable.entityId })
          .from(schema.limitsTable)
          .where(sql`${schema.limitsTable.entityType} = 'organization'`)
          .limit(1);
        if (existingOrgLimits.length > 0) {
          organizationId = existingOrgLimits[0].entityId;
        }
      }

      // Run cleanup if we have an organization ID
      if (organizationId) {
        logger.info(
          `[LimitValidation] Running cleanup for organization: ${organizationId}`,
        );
        await cleanupLimitsIfNeeded(organizationId);
      }

      // Check agent-level limits first (highest priority)
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
        if (teams.length > 0 && teams[0].organizationId) {
          logger.info(
            `[LimitValidation] Checking organization-level limits for org: ${teams[0].organizationId}`,
          );
          const orgLimitViolation =
            await LimitValidationService.checkEntityLimits(
              "organization",
              teams[0].organizationId,
            );
          if (orgLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by organization-level limit for org: ${teams[0].organizationId}`,
            );
            return orgLimitViolation;
          }
          logger.info(
            `[LimitValidation] Organization-level limits OK for org: ${teams[0].organizationId}`,
          );
        }
      } else {
        logger.info(
          `[LimitValidation] Agent ${agentId} has no teams, checking fallback organization limits`,
        );
        // If agent has no teams, check if there are any organization limits to apply
        const existingOrgLimits = await db
          .select({ entityId: schema.limitsTable.entityId })
          .from(schema.limitsTable)
          .where(sql`${schema.limitsTable.entityType} = 'organization'`)
          .limit(1);
        logger.info(
          `[LimitValidation] Found ${existingOrgLimits.length} fallback organization limits`,
        );

        if (existingOrgLimits.length > 0) {
          logger.info(
            `[LimitValidation] Checking fallback organization limit for org: ${existingOrgLimits[0].entityId}`,
          );
          const orgLimitViolation =
            await LimitValidationService.checkEntityLimits(
              "organization",
              existingOrgLimits[0].entityId,
            );
          if (orgLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by fallback organization-level limit for org: ${existingOrgLimits[0].entityId}`,
            );
            return orgLimitViolation;
          }
          logger.info(
            `[LimitValidation] Fallback organization-level limits OK for org: ${existingOrgLimits[0].entityId}`,
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
    entityType: "organization" | "team" | "agent",
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
        const currentUsage =
          (limit.currentUsageTokensIn || 0) +
          (limit.currentUsageTokensOut || 0);

        const limitDetails = {
          limitId: limit.id,
          limitValue: limit.limitValue,
          currentUsageTokensIn: limit.currentUsageTokensIn,
          currentUsageTokensOut: limit.currentUsageTokensOut,
          totalCurrentUsage: currentUsage,
          isExceeded: currentUsage >= limit.limitValue,
          fullLimitObject: limit,
        };
        logger.info(
          `[LimitValidation] Limit details for ${entityType} ${entityId}: ${JSON.stringify(limitDetails)}`,
        );

        // For token_cost limits, convert tokens to actual cost using token prices
        let comparisonValue = currentUsage;
        let limitDescription = "tokens";

        if (limit.limitType === "token_cost") {
          if (!limit.model) {
            logger.warn(
              `[LimitValidation] token_cost limit ${limit.id} has no model specified - cannot convert to cost`,
            );
            // Fall back to token comparison (will likely fail, but better than crashing)
          } else {
            try {
              // Look up token pricing for this model
              const tokenPrice = await TokenPriceModel.findByModel(limit.model);

              if (!tokenPrice) {
                logger.warn(
                  `[LimitValidation] No pricing found for model ${limit.model} - cannot convert to cost`,
                );
              } else {
                // Convert tokens to cost using the model's pricing
                const inputTokens = limit.currentUsageTokensIn || 0;
                const outputTokens = limit.currentUsageTokensOut || 0;

                const inputCost =
                  (inputTokens * parseFloat(tokenPrice.pricePerMillionInput)) /
                  1000000;
                const outputCost =
                  (outputTokens *
                    parseFloat(tokenPrice.pricePerMillionOutput)) /
                  1000000;
                const totalCost = inputCost + outputCost;

                comparisonValue = totalCost;
                limitDescription = "cost_dollars";
              }
            } catch (error) {
              logger.error(
                `[LimitValidation] Error converting tokens to cost for model ${limit.model}: ${error}`,
              );
            }
          }
        }

        if (comparisonValue >= limit.limitValue) {
          logger.info(
            `[LimitValidation] LIMIT EXCEEDED for ${entityType} ${entityId}: ${comparisonValue} ${limitDescription} >= ${limit.limitValue}`,
          );

          // Calculate remaining based on the comparison type (tokens vs dollars)
          const remaining = Math.max(0, limit.limitValue - comparisonValue);

          // For metadata, always use raw values for programmatic access
          const archestraMetadata = `
<archestra-limit-type>token_cost</archestra-limit-type>
<archestra-limit-entity-type>${entityType}</archestra-limit-entity-type>
<archestra-limit-entity-id>${entityId}</archestra-limit-entity-id>
<archestra-limit-current-usage>${currentUsage}</archestra-limit-current-usage>
<archestra-limit-value>${limit.limitValue}</archestra-limit-value>
<archestra-limit-remaining>${Math.max(0, limit.limitValue - currentUsage)}</archestra-limit-remaining>`;

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

Current usage: ${currentUsage.toLocaleString()} tokens
Limit: ${limit.limitValue.toLocaleString()} tokens
Remaining: ${Math.max(0, limit.limitValue - currentUsage).toLocaleString()} tokens

Please contact your administrator to increase the limit or wait for the usage to reset.`;
          }

          const refusalMessage = `${archestraMetadata}
${contentMessage}`;

          return [refusalMessage, contentMessage];
        } else {
          logger.info(
            `[LimitValidation] Limit OK for ${entityType} ${entityId}: ${currentUsage} < ${limit.limitValue}`,
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
}

export default LimitValidationService;
