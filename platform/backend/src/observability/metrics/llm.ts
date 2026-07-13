/**
 * Custom observability metrics for LLMs: request metrics and token usage.
 * To instrument OpenAI or Anthropic clients, pass observable fetch to the fetch option.
 * For OpenAI or Anthropic streaming mode, proxy handlers call reportLLMTokens() after consuming the stream.
 * To instrument Gemini, provide its instance to getObservableGenAI, which will wrap around its model calls.
 *
 * To calculate queries per second (QPS), use the rate() function on the histogram counter in Prometheus:
 * rate(llm_request_duration_seconds_count{provider="openai"}[10s])
 */

import type { InteractionSource, SupportedProvider } from "@archestra/shared";
import type { GoogleGenAI } from "@google/genai";
import client from "prom-client";
import { getLlmUpstreamDispatcher } from "@/clients/llm-upstream-dispatcher";
import logger from "@/logging";
import { getUsageTokens as getAnthropicUsage } from "@/routes/proxy/adapters/anthropic";
import { getUsageTokens as getCohereUsage } from "@/routes/proxy/adapters/cohere";
import { getUsageTokens as getGeminiUsage } from "@/routes/proxy/adapters/gemini";
import { getUsageTokens as getMinimaxUsage } from "@/routes/proxy/adapters/minimax";
import { getUsageTokens as getOpenAIUsage } from "@/routes/proxy/adapters/openai";
import { getUsageTokens as getZhipuaiUsage } from "@/routes/proxy/adapters/zhipuai";
import type { Agent } from "@/types";
import { getExemplarLabels, sanitizeLabelKey } from "./utils";

type UsageExtractor =
  | // biome-ignore lint/suspicious/noExplicitAny: usage comes from parsed JSON (cloned.json())
  ((usage: any) => {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    })
  | null;

/**
 * Maps each provider to its usage token extraction function for fetch-based observability.
 * Providers mapped to `null` use their own observability wrappers (e.g. Gemini uses getObservableGenAI,
 * Bedrock uses its own client) and should not extract tokens here to avoid double-reporting.
 * Using Record<SupportedProvider, ...> ensures TypeScript enforces adding new providers here.
 */
const fetchUsageExtractors: Record<SupportedProvider, UsageExtractor> = {
  openai: getOpenAIUsage,
  cerebras: getOpenAIUsage,
  vllm: getOpenAIUsage,
  ollama: getOpenAIUsage,
  mistral: getOpenAIUsage,
  perplexity: getOpenAIUsage,
  groq: getOpenAIUsage,
  xai: getOpenAIUsage,
  openrouter: getOpenAIUsage,
  anthropic: getAnthropicUsage,
  azure: getOpenAIUsage,
  cohere: getCohereUsage,
  zhipuai: getZhipuaiUsage,
  minimax: getMinimaxUsage,
  deepseek: getOpenAIUsage,
  "github-copilot": getOpenAIUsage,
  // Responses are OpenAI-shaped by our own Graph translation (usage estimated)
  "microsoft-365-copilot": getOpenAIUsage,
  gemini: null,
  bedrock: null,
};

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// LLM-specific metrics matching fastify-metrics format for consistency.
// You can monitor request count, duration and error rate with these.
let llmRequestDuration: client.Histogram<string>;
let llmTokensCounter: client.Counter<string>;
let llmCacheTokensCounter: client.Counter<string>;
let llmBlockedToolCounter: client.Counter<string>;
let llmCostTotal: client.Counter<string>;
let llmCacheCostTotal: client.Counter<string>;
let llmCacheSavingsTotal: client.Counter<string>;
let llmTimeToFirstToken: client.Histogram<string>;
let llmTokensPerSecond: client.Histogram<string>;
let llmTokenUsage: client.Histogram<string>;

// Store current label keys for comparison
let currentLabelKeys: string[] = [];

/**
 * Initialize LLM metrics with dynamic agent label keys
 * @param labelKeys Array of agent label keys to include as metric labels
 */
export function initializeMetrics(labelKeys: string[]): void {
  // Prometheus labels have naming restrictions. Dashes are not allowed, for example.
  const nextLabelKeys = labelKeys.map(sanitizeLabelKey).sort();
  // Check if label keys have changed
  const labelKeysChanged =
    JSON.stringify(nextLabelKeys) !== JSON.stringify(currentLabelKeys);

  if (
    !labelKeysChanged &&
    llmRequestDuration &&
    llmTokensCounter &&
    llmCacheTokensCounter &&
    llmBlockedToolCounter &&
    llmCostTotal &&
    llmCacheCostTotal &&
    llmCacheSavingsTotal &&
    llmTimeToFirstToken &&
    llmTokensPerSecond &&
    llmTokenUsage
  ) {
    logger.info(
      "Metrics already initialized with same label keys, skipping reinitialization",
    );
    return;
  }

  currentLabelKeys = nextLabelKeys;

  // Unregister old metrics if they exist
  try {
    if (llmRequestDuration) {
      client.register.removeSingleMetric("llm_request_duration_seconds");
    }
    if (llmTokensCounter) {
      client.register.removeSingleMetric("llm_tokens_total");
    }
    if (llmCacheTokensCounter) {
      client.register.removeSingleMetric("llm_cache_tokens_total");
    }
    if (llmBlockedToolCounter) {
      client.register.removeSingleMetric("llm_blocked_tools_total");
    }
    if (llmCostTotal) {
      client.register.removeSingleMetric("llm_cost_total");
    }
    if (llmCacheCostTotal) {
      client.register.removeSingleMetric("llm_cache_cost_total");
    }
    if (llmCacheSavingsTotal) {
      client.register.removeSingleMetric("llm_cache_savings_total");
    }
    if (llmTimeToFirstToken) {
      client.register.removeSingleMetric("llm_time_to_first_token_seconds");
    }
    if (llmTokensPerSecond) {
      client.register.removeSingleMetric("llm_tokens_per_second");
    }
    if (llmTokenUsage) {
      client.register.removeSingleMetric("llm_token_usage");
    }
  } catch (_error) {
    // Ignore errors if metrics don't exist
  }

  // Create new metrics with updated label names
  // agent_id/agent_name: Internal Archestra agent ID and name
  // agent_type: The agent type (mcp_gateway, llm_proxy, profile, agent)
  // Note: no external_agent_id label — it is client-supplied (X-Archestra-Agent-Id)
  // and unbounded, which would explode Prometheus series cardinality.
  const baseLabelNames = [
    "provider",
    "model",
    "agent_id",
    "agent_name",
    "agent_type",
    "source",
  ];

  llmRequestDuration = new client.Histogram({
    name: "llm_request_duration_seconds",
    help: "LLM request duration in seconds",
    labelNames: [...baseLabelNames, "status_code", ...nextLabelKeys],
    // Same bucket style as http_request_duration_seconds but adjusted for LLM latency
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    enableExemplars: true,
  });

  llmTokensCounter = new client.Counter({
    name: "llm_tokens_total",
    help: "Total tokens used",
    labelNames: [...baseLabelNames, "type", ...nextLabelKeys], // type: input|output
    enableExemplars: true,
  });

  // Separate from llm_tokens_total so existing input/output aggregates keep
  // their meaning; prompt-cache read/write are disjoint from input/output.
  llmCacheTokensCounter = new client.Counter({
    name: "llm_cache_tokens_total",
    help: "Total prompt-cache tokens (read = reused prefix, write = newly cached)",
    labelNames: [...baseLabelNames, "cache_type", ...nextLabelKeys], // cache_type: read|write
    enableExemplars: true,
  });

  llmBlockedToolCounter = new client.Counter({
    name: "llm_blocked_tools_total",
    help: "Blocked tool count",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    enableExemplars: true,
  });

  llmCostTotal = new client.Counter({
    name: "llm_cost_total",
    help: "Total estimated cost in USD",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    enableExemplars: true,
  });

  // Cost attributable to prompt-cache tokens alone (read + write, TTL-aware).
  // Separate from llm_cost_total (which is the full request cost) so caching ROI
  // can be charted on its own.
  llmCacheCostTotal = new client.Counter({
    name: "llm_cache_cost_total",
    help: "Estimated cost in USD attributable to prompt-cache tokens (read + write)",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    enableExemplars: true,
  });

  // Gross USD saved by cache reads (reads billed at a discount vs full input
  // price). Read-side only and always >= 0, so it is a valid monotonic counter;
  // the signed net-of-write-surcharge savings is persisted per interaction
  // (interactions.cache_savings) since counters cannot decrease.
  llmCacheSavingsTotal = new client.Counter({
    name: "llm_cache_savings_total",
    help: "Gross estimated USD saved by cache reads (discounted vs full input price)",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    enableExemplars: true,
  });

  llmTimeToFirstToken = new client.Histogram({
    name: "llm_time_to_first_token_seconds",
    help: "Time to first token in seconds (streaming latency)",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    // Buckets optimized for TTFT - typically faster than full response
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    enableExemplars: true,
  });

  llmTokensPerSecond = new client.Histogram({
    name: "llm_tokens_per_second",
    help: "Output tokens per second throughput",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    // Buckets for tokens/sec throughput - typical range 10-200 tokens/sec
    buckets: [5, 10, 25, 50, 75, 100, 150, 200, 300],
    enableExemplars: true,
  });

  llmTokenUsage = new client.Histogram({
    name: "llm_token_usage",
    help: "Token usage distribution per request (input + output combined)",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    buckets: [4, 16, 64, 256, 1024, 4096, 16384, 65536],
    enableExemplars: true,
  });

  logger.info(
    `Metrics initialized with ${
      nextLabelKeys.length
    } agent label keys: ${nextLabelKeys.join(", ")}`,
  );
}

/**
 * Helper function to build metric labels from agent
 * @param profile The Archestra profile
 * @param additionalLabels Additional labels to include
 * @param model The model name
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
function buildMetricLabels(
  profile: Agent,
  additionalLabels: Record<string, string>,
  model: string | undefined,
  source: InteractionSource,
): Record<string, string> {
  // agent_id/agent_name: Internal Archestra agent ID and name
  const labels: Record<string, string> = {
    agent_id: profile.id,
    agent_name: profile.name,
    agent_type: profile.agentType ?? "",
    model: model ?? "unknown",
    source,
    ...additionalLabels,
  };

  // Add agent label values for all registered label keys
  for (const labelKey of currentLabelKeys) {
    // Find the label value for this key from the agent's labels
    const agentLabel = profile.labels?.find(
      (l) => sanitizeLabelKey(l.key) === labelKey,
    );
    labels[labelKey] = agentLabel?.value ?? "";
  }

  return labels;
}

/**
 * Reports LLM token usage
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param usage Token usage object with input/output counts
 * @param model The model name
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function reportLLMTokens(
  provider: SupportedProvider,
  profile: Agent,
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
  model: string,
  source: InteractionSource,
): void {
  if (!llmTokensCounter) {
    logger.warn("LLM metrics not initialized, skipping token reporting");
    return;
  }

  const exemplarLabels = getExemplarLabels();
  // Built once and shared across the up-to-5 emissions below; per-metric
  // extras (type/cache_type) are spread on top.
  const baseLabels = buildMetricLabels(profile, { provider }, model, source);

  if (usage.input && usage.input > 0) {
    llmTokensCounter.inc({
      labels: { ...baseLabels, type: "input" },
      value: usage.input,
      exemplarLabels,
    });
  }
  if (usage.output && usage.output > 0) {
    llmTokensCounter.inc({
      labels: { ...baseLabels, type: "output" },
      value: usage.output,
      exemplarLabels,
    });
  }

  if (usage.cacheRead && usage.cacheRead > 0) {
    llmCacheTokensCounter.inc({
      labels: { ...baseLabels, cache_type: "read" },
      value: usage.cacheRead,
      exemplarLabels,
    });
  }
  if (usage.cacheWrite && usage.cacheWrite > 0) {
    llmCacheTokensCounter.inc({
      labels: { ...baseLabels, cache_type: "write" },
      value: usage.cacheWrite,
      exemplarLabels,
    });
  }

  const totalTokens = (usage.input ?? 0) + (usage.output ?? 0);
  if (totalTokens > 0 && llmTokenUsage) {
    llmTokenUsage.observe({
      labels: baseLabels,
      value: totalTokens,
      exemplarLabels,
    });
  }
}

/**
 * Increases the blocked tool counter by count.
 * Count can be more than 1, because when one tool call from an LLM response call is blocked,
 * all other calls in a response are blocked too.
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param count Number of blocked tools
 * @param model The model name
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function reportBlockedTools(
  provider: SupportedProvider,
  profile: Agent,
  count: number,
  model: string,
  source: InteractionSource,
) {
  if (!llmBlockedToolCounter) {
    logger.warn(
      "LLM metrics not initialized, skipping blocked tools reporting",
    );
    return;
  }
  llmBlockedToolCounter.inc({
    labels: buildMetricLabels(profile, { provider }, model, source),
    value: count,
    exemplarLabels: getExemplarLabels(),
  });
}

/**
 * Reports estimated cost for LLM request in USD
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param model The model name
 * @param cost The cost in USD
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function reportLLMCost(
  provider: SupportedProvider,
  profile: Agent,
  model: string,
  cost: number | null | undefined,
  source: InteractionSource,
): void {
  if (!llmCostTotal) {
    logger.warn("LLM metrics not initialized, skipping cost reporting");
    return;
  } else if (!cost) {
    logger.warn("Cost not specified when reporting");
    return;
  }
  llmCostTotal.inc({
    labels: buildMetricLabels(profile, { provider }, model, source),
    value: cost,
    exemplarLabels: getExemplarLabels(),
  });
}

/**
 * Reports prompt-cache cost and savings for an LLM request in USD.
 * `cacheCost` is the spend attributable to cache tokens; `cacheReadSavings` is
 * the gross (always >= 0) amount saved by cache reads being discounted. Both are
 * no-ops when undefined or non-positive, so requests without caching emit nothing.
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param model The model name
 * @param cache Cache cost breakdown in USD
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function reportLLMCacheCost(
  provider: SupportedProvider,
  profile: Agent,
  model: string,
  cache: { cacheCost?: number | null; cacheReadSavings?: number | null },
  source: InteractionSource,
): void {
  if (!llmCacheCostTotal || !llmCacheSavingsTotal) {
    logger.warn("LLM metrics not initialized, skipping cache cost reporting");
    return;
  }

  const labels = buildMetricLabels(profile, { provider }, model, source);
  const exemplarLabels = getExemplarLabels();

  if (cache.cacheCost && cache.cacheCost > 0) {
    llmCacheCostTotal.inc({ labels, value: cache.cacheCost, exemplarLabels });
  }
  if (cache.cacheReadSavings && cache.cacheReadSavings > 0) {
    llmCacheSavingsTotal.inc({
      labels,
      value: cache.cacheReadSavings,
      exemplarLabels,
    });
  }
}

/**
 * Reports time to first token (TTFT) for streaming LLM requests.
 * This metric helps application developers understand streaming latency
 * and choose models with lower initial response times.
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param model The model name
 * @param ttftSeconds Time to first token in seconds
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function reportTimeToFirstToken(
  provider: SupportedProvider,
  profile: Agent,
  model: string,
  ttftSeconds: number,
  source: InteractionSource,
): void {
  if (!llmTimeToFirstToken) {
    logger.warn("LLM metrics not initialized, skipping TTFT reporting");
    return;
  }
  if (ttftSeconds <= 0) {
    logger.warn("Invalid TTFT value, must be positive");
    return;
  }
  llmTimeToFirstToken.observe({
    labels: buildMetricLabels(profile, { provider }, model, source),
    value: ttftSeconds,
    exemplarLabels: getExemplarLabels(),
  });
}

/**
 * Reports tokens per second throughput for LLM requests.
 * This metric allows comparing model response speeds and helps
 * developers choose models for latency-sensitive applications.
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param model The model name
 * @param outputTokens Number of output tokens generated
 * @param durationSeconds Total request duration in seconds
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function reportTokensPerSecond(
  provider: SupportedProvider,
  profile: Agent,
  model: string,
  outputTokens: number,
  durationSeconds: number,
  source: InteractionSource,
): void {
  if (!llmTokensPerSecond) {
    logger.warn("LLM metrics not initialized, skipping tokens/sec reporting");
    return;
  }
  if (durationSeconds <= 0 || outputTokens <= 0) {
    // Skip reporting if no output tokens or invalid duration
    return;
  }
  const tokensPerSecond = outputTokens / durationSeconds;
  llmTokensPerSecond.observe({
    labels: buildMetricLabels(profile, { provider }, model, source),
    value: tokensPerSecond,
    exemplarLabels: getExemplarLabels(),
  });
}

/**
 * Records the `llm_request_duration_seconds` histogram for a single request.
 *
 * Most providers instrument duration inside their transport wrapper
 * (fetch-based providers via getObservableFetch, Gemini via getObservableGenAI),
 * so they must NOT call this or the observation would be double-counted. It
 * exists for providers whose transport can't self-instrument — notably Bedrock,
 * which uses a custom SigV4 client that has no access to the profile/source
 * needed for metric labels. For those, the LLM proxy handler records duration
 * on the provider's behalf (gated by `LLMProvider.recordRequestDurationInHandler`).
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param model The model name
 * @param durationSeconds Request duration in seconds
 * @param statusCode HTTP-like status code label ("200" on success, upstream
 *   status or "0" on error) — mirrors getObservableFetch's status labeling
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function reportRequestDuration(
  provider: SupportedProvider,
  profile: Agent,
  model: string,
  durationSeconds: number,
  statusCode: string,
  source: InteractionSource,
): void {
  if (!llmRequestDuration) {
    logger.warn("LLM metrics not initialized, skipping duration reporting");
    return;
  }
  llmRequestDuration.observe({
    labels: buildMetricLabels(
      profile,
      { provider, status_code: statusCode },
      model,
      source,
    ),
    value: durationSeconds,
    exemplarLabels: getExemplarLabels(),
  });
}

/**
 * Returns a fetch wrapped in observability. Use it as OpenAI or Anthropic provider custom fetch implementation.
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function getObservableFetch(
  provider: SupportedProvider,
  profile: Agent,
  source: InteractionSource,
): Fetch {
  return async function observableFetch(
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // Opt-in upstream timeout dispatcher; undefined leaves undici defaults (and
    // `init`) untouched. See @/clients/llm-upstream-dispatcher.
    const dispatcher = getLlmUpstreamDispatcher();
    const dispatchedInit = dispatcher
      ? ({ ...init, dispatcher } as RequestInit)
      : init;
    logger.info(
      {
        url: typeof url === "string" ? url : url.toString(),
        headers: extractHeaderNames(init?.headers),
      },
      `[${provider}Proxy] outbound request headers`,
    );
    if (!llmRequestDuration) {
      logger.warn("LLM metrics not initialized, skipping duration tracking");
      return fetch(url, dispatchedInit);
    }

    // Extract model from request body if available
    let requestModel: string | undefined;
    try {
      if (init?.body && typeof init.body === "string") {
        const requestBody = JSON.parse(init.body);
        requestModel = requestBody.model;
      }
    } catch (_error) {
      // Ignore JSON parse errors
    }

    const startTime = Date.now();
    let response: Response;
    let model = requestModel;

    try {
      response = await fetch(url, dispatchedInit);
      const duration = (Date.now() - startTime) / 1000;
      const status = response.status.toString();

      llmRequestDuration.observe({
        labels: buildMetricLabels(
          profile,
          { provider, status_code: status },
          model,
          source,
        ),
        value: duration,
        exemplarLabels: getExemplarLabels(),
      });
    } catch (error) {
      // Network errors only: fetch does not throw on 4xx or 5xx.
      const duration = (Date.now() - startTime) / 1000;
      llmRequestDuration.observe({
        labels: buildMetricLabels(
          profile,
          { provider, status_code: "0" },
          model,
          source,
        ),
        value: duration,
        exemplarLabels: getExemplarLabels(),
      });
      throw error;
    }

    // When the upstream returns an error, log the raw body for debugging.
    // The body may be lost by the time provider SDKs process the error
    // (e.g. OpenAI SDK produces "500 status code (no body)" for non-standard formats).
    if (!response.ok) {
      try {
        const cloned = response.clone();
        const rawBody = await cloned.text();
        if (rawBody) {
          logger.error(
            {
              statusCode: response.status,
              upstreamError: rawBody.slice(0, 2000),
              provider,
              model,
            },
            "Upstream provider returned an error response",
          );
        }
      } catch (bodyError) {
        logger.debug(
          { err: bodyError },
          "Failed to read upstream error response body",
        );
      }
    }

    // Record token metrics
    if (
      response.ok &&
      response.headers.get("content-type")?.includes("application/json")
    ) {
      const cloned = response.clone();
      try {
        const data = await cloned.json();
        // Extract model from response if not in request
        if (!model && data.model) {
          model = data.model;
        }
        if (!data.usage) {
          return response;
        }
        const extractor = fetchUsageExtractors[provider];
        if (extractor) {
          const { input, output, cacheRead, cacheWrite } = extractor(
            data.usage,
          );
          reportLLMTokens(
            provider,
            profile,
            { input, output, cacheRead, cacheWrite },
            model ?? "unknown",
            source,
          );
        }
      } catch (_parseError) {
        logger.error("Error parsing LLM response JSON for tokens");
      }
    }

    return response;
  };
}

/**
 * Wraps observability around GenAI's LLM request methods
 * @param genAI The GoogleGenAI instance
 * @param profile The Archestra profile
 * @param source Interaction source (e.g. "api", "chat", "knowledge:embedding")
 */
export function getObservableGenAI(
  genAI: GoogleGenAI,
  profile: Agent,
  source: InteractionSource,
) {
  const originalGenerateContent = genAI.models.generateContent;
  const originalGenerateContentStream = genAI.models.generateContentStream;
  const provider: SupportedProvider = "gemini";

  genAI.models.generateContent = async (...args) => {
    if (!llmRequestDuration) {
      logger.warn("LLM metrics not initialized, skipping duration tracking");
      return originalGenerateContent.apply(genAI.models, args);
    }

    const model = extractGeminiModel(args[0]);
    const startTime = Date.now();

    try {
      const result = await originalGenerateContent.apply(genAI.models, args);
      const duration = (Date.now() - startTime) / 1000;

      // Assuming 200 status code. Gemini doesn't expose HTTP status, but unlike fetch, throws on 4xx & 5xx.
      llmRequestDuration.observe({
        labels: buildMetricLabels(
          profile,
          { provider, status_code: "200" },
          model,
          source,
        ),
        value: duration,
        exemplarLabels: getExemplarLabels(),
      });

      // Record token metrics
      const usage = result.usageMetadata;
      if (usage) {
        const { input, output, cacheRead, cacheWrite } = getGeminiUsage(usage);
        reportLLMTokens(
          provider,
          profile,
          { input, output, cacheRead, cacheWrite },
          model ?? "unknown",
          source,
        );
      }

      return result;
    } catch (error) {
      observeGeminiError(error, startTime, profile, model, source);
      throw error;
    }
  };

  genAI.models.generateContentStream = async (...args) => {
    if (!llmRequestDuration) {
      logger.warn("LLM metrics not initialized, skipping duration tracking");
      return originalGenerateContentStream.apply(genAI.models, args);
    }

    const model = extractGeminiModel(args[0]);
    const startTime = Date.now();

    try {
      const result = await originalGenerateContentStream.apply(
        genAI.models,
        args,
      );
      // Record duration when the stream connection is established (before consuming chunks).
      // This is consistent with how getObservableFetch records duration for other providers'
      // streaming requests — fetch() resolves on response headers, not stream completion.
      const duration = (Date.now() - startTime) / 1000;

      llmRequestDuration.observe({
        labels: buildMetricLabels(
          profile,
          { provider, status_code: "200" },
          model,
          source,
        ),
        value: duration,
        exemplarLabels: getExemplarLabels(),
      });

      return result;
    } catch (error) {
      observeGeminiError(error, startTime, profile, model, source);
      throw error;
    }
  };

  return genAI;
}

/**
 * Reports Prometheus metrics for knowledge base LLM calls (embeddings, reranking).
 * These bypass the LLM proxy so metrics must be emitted separately.
 * Uses a synthetic "Knowledge Base" agent label since KB calls have no associated profile.
 */
export function reportKbLlmCall(params: {
  provider: SupportedProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationSeconds: number;
  cost: number | undefined;
  source: InteractionSource;
}): void {
  const labels: Record<string, string> = {
    provider: params.provider,
    model: params.model,
    agent_id: "",
    agent_name: "Knowledge Base",
    agent_type: "",
    source: params.source,
  };
  // Fill in dynamic label keys with empty values
  for (const key of currentLabelKeys) {
    labels[key] = "";
  }

  const exemplarLabels = getExemplarLabels();

  if (llmRequestDuration) {
    llmRequestDuration.observe({
      labels: { ...labels, status_code: "200" },
      value: params.durationSeconds,
      exemplarLabels,
    });
  }

  if (llmTokensCounter) {
    if (params.inputTokens > 0) {
      llmTokensCounter.inc({
        labels: { ...labels, type: "input" },
        value: params.inputTokens,
        exemplarLabels,
      });
    }
    if (params.outputTokens > 0) {
      llmTokensCounter.inc({
        labels: { ...labels, type: "output" },
        value: params.outputTokens,
        exemplarLabels,
      });
    }
  }

  if (llmTokenUsage) {
    const totalTokens = params.inputTokens + params.outputTokens;
    if (totalTokens > 0) {
      llmTokenUsage.observe({
        labels,
        value: totalTokens,
        exemplarLabels,
      });
    }
  }

  if (llmCostTotal && params.cost) {
    llmCostTotal.inc({
      labels,
      value: params.cost,
      exemplarLabels,
    });
  }
}

function extractHeaderNames(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const firstChar = (v: unknown) =>
    typeof v === "string" && v.length > 0 ? v[0] : "";
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      result[k] = firstChar(v);
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) result[k] = firstChar(v);
    return result;
  }
  for (const [k, v] of Object.entries(headers)) result[k] = firstChar(v);
  return result;
}

function extractGeminiModel(arg: unknown): string | undefined {
  try {
    if (arg && typeof arg === "object" && "model" in arg) {
      return arg.model as string;
    }
  } catch (_error) {
    // Ignore extraction errors
  }
  return undefined;
}

function observeGeminiError(
  error: unknown,
  startTime: number,
  profile: Agent,
  model: string | undefined,
  source: InteractionSource,
): void {
  const duration = (Date.now() - startTime) / 1000;
  const statusCode =
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status.toString()
      : "0";

  llmRequestDuration.observe({
    labels: buildMetricLabels(
      profile,
      { provider: "gemini", status_code: statusCode },
      model,
      source,
    ),
    value: duration,
    exemplarLabels: getExemplarLabels(),
  });
}
