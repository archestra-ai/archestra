import type { SupportedProvider } from "@archestra/shared";
import logger from "@/logging";
import {
  AgentTeamModel,
  ModelModel,
  OptimizationRuleModel,
  TeamModel,
} from "@/models";
import {
  getTokenizer,
  type ProviderMessage,
  type Tokenizer,
} from "@/tokenizers";
import type {
  Agent,
  Anthropic,
  Cerebras,
  Cohere,
  CommonMcpToolDefinition,
  DeepSeek,
  Gemini,
  GithubCopilot,
  Groq,
  Minimax,
  Mistral,
  OpenAi,
  Openrouter,
  Perplexity,
  Vllm,
  Xai,
  Zhipuai,
} from "@/types";

type ProviderMessages = {
  anthropic: Anthropic.Types.MessagesRequest["messages"];
  cerebras: Cerebras.Types.ChatCompletionsRequest["messages"];
  cohere: Cohere.Types.ChatRequest["messages"];
  gemini: Gemini.Types.GenerateContentRequest["contents"];
  groq: Groq.Types.ChatCompletionsRequest["messages"];
  openrouter: Openrouter.Types.ChatCompletionsRequest["messages"];
  mistral: Mistral.Types.ChatCompletionsRequest["messages"];
  perplexity: Perplexity.Types.ChatCompletionsRequest["messages"];
  minimax: Minimax.Types.ChatCompletionsRequest["messages"];
  openai: OpenAi.Types.ChatCompletionsRequest["messages"];
  vllm: Vllm.Types.ChatCompletionsRequest["messages"];
  ollama: Vllm.Types.ChatCompletionsRequest["messages"];
  xai: Xai.Types.ChatCompletionsRequest["messages"];
  zhipuai: Zhipuai.Types.ChatCompletionsRequest["messages"];
  deepseek: DeepSeek.Types.ChatCompletionsRequest["messages"];
  "github-copilot": GithubCopilot.Types.ChatCompletionsRequest["messages"];
};

/**
 * Estimate token count for tool definitions by serializing them
 * and using the provider-specific tokenizer for accurate counting.
 */
export function estimateToolTokens(
  tools: CommonMcpToolDefinition[],
  tokenizer: Tokenizer,
): number {
  if (tools.length === 0) return 0;
  const serialized = tools
    .map((t) => {
      let text = t.name;
      if (t.description) text += ` ${t.description}`;
      if (t.inputSchema) text += ` ${JSON.stringify(t.inputSchema)}`;
      return text;
    })
    .join(" ");
  return tokenizer.countTokens({
    role: "user",
    content: serialized,
  } as ProviderMessage);
}

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
  tools: CommonMcpToolDefinition[] = [],
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
  const messageTokenCount = tokenizer.countTokens(messages);
  const toolTokenCount = estimateToolTokens(tools, tokenizer);
  const tokenCount = messageTokenCount + toolTokenCount;

  logger.info(
    { tokenCount, messageTokenCount, toolTokenCount, hasTools },
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
 * Cache token cost as a multiple of the model's per-token INPUT price.
 * `read` = cache-read (cheap reuse); `write` = cache-creation surcharge.
 * Anthropic/Bedrock bill a separate write surcharge; OpenAI/Gemini/DeepSeek
 * auto-cache with only a read discount (no write surcharge).
 */
export const CACHE_PRICE_MULTIPLIERS: Record<
  string,
  { read: number; write: number; write1h?: number }
> = {
  // write = 5-minute cache-write surcharge; write1h = 1-hour cache-write
  // surcharge (Anthropic/Bedrock bill the 1h write at 2x input, the 5m at 1.25x).
  anthropic: { read: 0.1, write: 1.25, write1h: 2 },
  bedrock: { read: 0.1, write: 1.25, write1h: 2 },
  openai: { read: 0.25, write: 0 },
  gemini: { read: 0.25, write: 0 },
  deepseek: { read: 0.1, write: 0 },
};

interface CacheTokenCounts {
  readTokens?: number;
  writeTokens?: number;
  /** Portion of writeTokens written at the 1-hour TTL (billed at write1h, the rest at write). */
  write1hTokens?: number;
}

/**
 * Calculate the all-in cost for token usage based on model pricing (input +
 * output + cache read + cache write). Uses provider to disambiguate models with
 * the same name across providers. Returns undefined when there is no usage at
 * all (so a fully-cached request — inputTokens 0 but real cache/output cost —
 * is still costed).
 */
export async function calculateCost(
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  provider: SupportedProvider,
  cacheTokens?: CacheTokenCounts,
): Promise<number | undefined> {
  const readTokens = cacheTokens?.readTokens ?? 0;
  const writeTokens = cacheTokens?.writeTokens ?? 0;
  if (!inputTokens && !outputTokens && !readTokens && !writeTokens) {
    return undefined;
  }

  const model_entry = await ModelModel.findByProviderAndModelId(
    provider,
    model,
  );
  const pricing = ModelModel.getEffectivePricing(model_entry, model);
  const priceIn = Number.parseFloat(pricing.pricePerMillionInput);
  const priceOut = Number.parseFloat(pricing.pricePerMillionOutput);
  const mult: { read: number; write: number; write1h?: number } =
    CACHE_PRICE_MULTIPLIERS[provider] ?? { read: 0, write: 0 };

  // Cache writes are billed per TTL: 1h costs more than the 5m default.
  const write1h = Math.min(
    Math.max(cacheTokens?.write1hTokens ?? 0, 0),
    writeTokens,
  );
  const write5m = writeTokens - write1h;
  const write1hMult = mult.write1h ?? mult.write;

  return (
    ((inputTokens ?? 0) / 1_000_000) * priceIn +
    ((outputTokens ?? 0) / 1_000_000) * priceOut +
    (readTokens / 1_000_000) * priceIn * mult.read +
    (write5m / 1_000_000) * priceIn * mult.write +
    (write1h / 1_000_000) * priceIn * write1hMult
  );
}

/**
 * Cache cost breakdown for the interaction record / observability:
 *  - `cacheCost`: what the cache read+write tokens actually cost.
 *  - `cacheSavings`: net amount caching saved vs paying full input price for
 *    those tokens — cache reads save `(1 - readMult)`, cache writes cost an
 *    extra `(writeMult - 1)`, so net = readSavings - writeSurcharge.
 * Returns undefined when there are no cache tokens.
 */
export async function calculateCacheCost(
  model: string,
  provider: SupportedProvider,
  readTokens: number,
  writeTokens: number,
  /** Portion of writeTokens written at the 1-hour TTL (the rest is costed at the 5m rate). */
  write1hTokens = 0,
): Promise<{ cacheCost: number; cacheSavings: number } | undefined> {
  if (!readTokens && !writeTokens) {
    return undefined;
  }
  const model_entry = await ModelModel.findByProviderAndModelId(
    provider,
    model,
  );
  const mult = CACHE_PRICE_MULTIPLIERS[provider];
  if (!mult) {
    // Provider has no cache pricing model; don't fabricate cost/savings.
    return undefined;
  }
  const pricing = ModelModel.getEffectivePricing(model_entry, model);
  const priceIn = Number.parseFloat(pricing.pricePerMillionInput);

  // Split writes by TTL: 1h is billed at a higher surcharge than the 5m default.
  const write1h = Math.min(Math.max(write1hTokens, 0), writeTokens);
  const write5m = writeTokens - write1h;
  const write1hMult = mult.write1h ?? mult.write;

  const readFull = (readTokens / 1_000_000) * priceIn;
  const write5mFull = (write5m / 1_000_000) * priceIn;
  const write1hFull = (write1h / 1_000_000) * priceIn;

  const cacheCost =
    readFull * mult.read + write5mFull * mult.write + write1hFull * write1hMult;
  const cacheSavings =
    readFull * (1 - mult.read) -
    write5mFull * (mult.write - 1) -
    write1hFull * (write1hMult - 1);

  return { cacheCost, cacheSavings };
}
