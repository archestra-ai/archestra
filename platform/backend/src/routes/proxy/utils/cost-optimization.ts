import logger from "@/logging";
import { OptimizationRuleModel, TokenPriceModel } from "@/models";
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
  organizationId: string,
  agent: Agent,
  messages: ProviderMessages[Provider],
  provider: Provider,
  hasTools: boolean,
): Promise<string | null> {
  const agentId = agent.id;
  if (!agent.optimizeCost) {
    logger.info({ agentId }, "Cost optimization disabled for profile");
    return null;
  }

  logger.info({ agentId }, "Cost optimization enabled for profile");

  // Fetch enabled optimization rules for this organization, agent, and provider
  const rules =
    await OptimizationRuleModel.findEnabledByOrganizationAndProvider(
      organizationId,
      agent.id,
      provider,
    );

  if (rules.length === 0) {
    logger.info(
      { agentId, organizationId },
      "No optimization rules configured",
    );
    return null;
  }

  let contentLength = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      contentLength += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          contentLength += block.text.length;
        }
      }
    }
  }

  // Evaluate rules and return optimized model (or null if no rule matches)
  const optimizedModel = OptimizationRuleModel.evaluateRules(rules, {
    contentLength,
    hasTools,
  });

  if (optimizedModel) {
    logger.info(
      { agentId, optimizedModel },
      "Optimization rule matched - using optimized model",
    );
  } else {
    logger.info(
      { agentId },
      "No optimization rule matched - using baseline model",
    );
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
