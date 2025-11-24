import { inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  AgentTeamModel,
  OptimizationRuleModel,
  TokenPriceModel,
} from "@/models";
import { getTokenizer } from "@/tokenizers";
import type { Agent, Anthropic, OpenAi } from "@/types";

type ProviderMessages = {
  openai: OpenAi.Types.ChatCompletionsRequest["messages"];
  anthropic: Anthropic.Types.MessagesRequest["messages"];
};

/**
 * Get optimized model based on dynamic optimization rules
 * Returns the optimized model name or null if no optimization applies
 */
export async function getOptimizedModel<
  Provider extends keyof ProviderMessages,
>(
  agent: Agent,
  messages: ProviderMessages[Provider],
  provider: Provider,
  hasTools: boolean,
): Promise<string | null> {
  const agentId = agent.id;
  if (!agent.optimizeCost) {
    logger.info({ agentId }, "Cost optimization: disabled for profile");
    return null;
  }

  logger.info({ agentId }, "Cost optimization: enabled for profile");

  // Get organizationId the same way limits do: from agent's teams OR fallback
  let organizationId: string | null = null;
  const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);

  if (agentTeamIds.length > 0) {
    // Get organizationId from agent's first team
    const teams = await db
      .select()
      .from(schema.teamsTable)
      .where(inArray(schema.teamsTable.id, agentTeamIds));
    if (teams.length > 0 && teams[0].organizationId) {
      organizationId = teams[0].organizationId;
      logger.info(
        { agentId, organizationId },
        "Cost optimization: resolved organizationId from team",
      );
    }
  } else {
    // If agent has no teams, check if there are any organization optimization rules to apply (fallback)
    const existingOrgRules = await db
      .select({ entityId: schema.optimizationRulesTable.entityId })
      .from(schema.optimizationRulesTable)
      .where(sql`${schema.optimizationRulesTable.entityType} = 'organization'`)
      .limit(1);

    if (existingOrgRules.length > 0) {
      organizationId = existingOrgRules[0].entityId;
      logger.info(
        { agentId, organizationId },
        "Cost optimization: agent has no teams - using fallback organization",
      );
    }
  }

  if (!organizationId) {
    logger.warn(
      { agentId },
      "Cost optimization: could not resolve organizationId",
    );
    return null;
  }

  // Fetch enabled optimization rules for this organization, agent, and provider
  const rules =
    await OptimizationRuleModel.findEnabledByOrganizationAndProvider(
      organizationId,
      provider,
    );

  if (rules.length === 0) {
    logger.info(
      { agentId, organizationId, provider },
      "Cost optimization: no optimization rules configured",
    );
    return null;
  }

  // Use provider-specific tokenizer to count tokens
  const tokenizer = getTokenizer(provider);
  const tokenCount = tokenizer.countTokens(messages);

  logger.info(
    { tokenCount, hasTools },
    "Cost optimization: LLM request evaluated",
  );

  // Evaluate rules and return optimized model (or null if no rule matches)
  const optimizedModel = OptimizationRuleModel.evaluateRules(rules, {
    tokenCount,
    hasTools,
  });

  if (optimizedModel) {
    logger.info(
      { agentId, optimizedModel },
      "Cost optimization: optimization rule matched",
    );
  } else {
    logger.info({ agentId }, "Cost optimization: no optimization rule matched");
  }

  return optimizedModel;
}

/**
 * Calculate cost for token usage based on model pricing
 * Returns undefined if pricing is not available for the model
 */
export async function calculateCost(
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): Promise<number | undefined> {
  if (!inputTokens || !outputTokens) {
    return undefined;
  }

  const pricing = await TokenPriceModel.findByModel(model);
  if (!pricing) {
    return undefined;
  }

  const inputCost =
    (inputTokens / 1_000_000) * Number.parseFloat(pricing.pricePerMillionInput);
  const outputCost =
    (outputTokens / 1_000_000) *
    Number.parseFloat(pricing.pricePerMillionOutput);

  return inputCost + outputCost;
}
