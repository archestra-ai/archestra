import { OptimizationRuleModel } from "@/models";
import type { Agent, Anthropic, OpenAi } from "@/types";

type ProviderMessages = {
  openai: OpenAi.Types.ChatCompletionsRequest["messages"],
  anthropic: Anthropic.Types.MessagesRequest["messages"]
}

/**
 * Get optimized model based on dynamic optimization rules
 * Returns the optimized model name or null if no optimization applies
 */
export async function getOptimizedModel<Provider extends keyof ProviderMessages>(
  agent: Agent,
  messages: ProviderMessages[Provider],
  provider: Provider,
  hasTools: boolean,
): Promise<string | null> {
  // Return null if cost optimization is disabled
  if (!agent.optimizeCost) {
    return null;
  }

  // Fetch enabled optimization rules for this agent and provider
  const rules = await OptimizationRuleModel.findEnabledByAgentIdAndProvider(
    agent.id,
    provider,
  );

  // No rules configured, no optimization
  if (rules.length === 0) {
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
  return OptimizationRuleModel.evaluateRules(rules, {
    contentLength,
    hasTools,
  });
}
