import logger from "@/logging";
import {
  AgentTeamModel,
  OptimizationRuleModel,
  TeamModel,
  TokenPriceModel,
} from "@/models";
import { getTokenizer } from "@/tokenizers";
import type { Agent, Anthropic, Gemini, OpenAi } from "@/types";

type ProviderMessages = {
  openai: OpenAi.Types.ChatCompletionsRequest["messages"];
  anthropic: Anthropic.Types.MessagesRequest["messages"];
  gemini: Gemini.Types.GenerateContentRequest["contents"];
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

  // Get organizationId the same way limits do: from agent's teams OR fallback
  let organizationId: string | null = null;
  const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);

  if (agentTeamIds.length > 0) {
    // Get organizationId from agent's first team
    const teams = await TeamModel.findByIds(agentTeamIds);
    if (teams.length > 0 && teams[0].organizationId) {
      organizationId = teams[0].organizationId;
      logger.info(
        { agentId, organizationId },
        "[CostOptimization] resolved organizationId from team",
      );
    }
  } else {
    // If agent has no teams, check if there are any organization optimization rules to apply (fallback)
    // TODO: this fallback doesn't work if there are multiple organizations.
    organizationId = await OptimizationRuleModel.getFirstOrganizationId();

    if (organizationId) {
      logger.info(
        { agentId, organizationId },
        "[CostOptimization] agent has no teams - using fallback organization",
      );
    }
  }

  if (!organizationId) {
    logger.warn(
      { agentId },
      "[CostOptimization] could not resolve organizationId",
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
      "[CostOptimization] no optimization rules configured",
    );
    return null;
  }

  // Use provider-specific tokenizer to count tokens
  const tokenizer = getTokenizer(provider);
  const tokenCount = tokenizer.countTokens(messages);

  logger.info(
    { tokenCount, hasTools },
    "[CostOptimization] LLM request evaluated",
  );

  // Evaluate rules and return optimized model (or null if no rule matches)
  const optimizedModel = OptimizationRuleModel.matchByRules(rules, {
    tokenCount,
    hasTools,
  });

  if (optimizedModel) {
    logger.info(
      { agentId, optimizedModel },
      "[CostOptimization] optimization rule matched",
    );
  } else {
    logger.info({ agentId }, "[CostOptimization] no optimization rule matched");
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
