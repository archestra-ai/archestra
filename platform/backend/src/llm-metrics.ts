/**
 * Custom observability metrics for LLMs: request metrics and token usage.
 * To instrument OpenAI or Anthropic clients, pass observable fetch to the fetch option.
 * For OpenAI or Anthropic streaming mode, proxy handlers call reportLLMTokens() after consuming the stream.
 * To instrument Gemini, provide its instance to getObservableGenAI, which will wrap around its model calls.
 *
 * To calculate queries per second (QPS), use the rate() function on the histogram counter in Prometheus:
 * rate(llm_request_duration_seconds_count{provider="openai"}[10s])
 */

import type { GoogleGenAI } from "@google/genai";
import type { SupportedProvider } from "@shared";
import client from "prom-client";
import logger from "@/logging";
import type { Agent } from "@/types";
import * as utils from "./routes/proxy/utils";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// LLM-specific metrics matching fastify-metrics format for consistency.
// You can monitor request count, duration and error rate with these.
let llmRequestDuration: client.Histogram<string>;
let llmTokensCounter: client.Counter<string>;
let llmBlockedToolCounter: client.Counter<string>;
let llmCostTotal: client.Counter<string>;
let llmTimeToFirstToken: client.Histogram<string>;
let llmTokensPerSecond: client.Histogram<string>;

// Store current label keys for comparison
let currentLabelKeys: string[] = [];

// Regexp pattern to sanitize label keys
const sanitizeRegexp = /[^a-zA-Z0-9_]/g;

/**
 * Initialize LLM metrics with dynamic agent label keys
 * @param labelKeys Array of agent label keys to include as metric labels
 */
export function initializeMetrics(labelKeys: string[]): void {
  // Prometheus labels have naming restrictions. Dashes are not allowed, for example.
  const nextLabelKeys = labelKeys
    .map((key) => key.replace(sanitizeRegexp, "_"))
    .sort();
  // Check if label keys have changed
  const labelKeysChanged =
    JSON.stringify(nextLabelKeys) !== JSON.stringify(currentLabelKeys);

  if (
    !labelKeysChanged &&
    llmRequestDuration &&
    llmTokensCounter &&
    llmBlockedToolCounter &&
    llmCostTotal &&
    llmTimeToFirstToken &&
    llmTokensPerSecond
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
    if (llmBlockedToolCounter) {
      client.register.removeSingleMetric("llm_blocked_tools_total");
    }
    if (llmCostTotal) {
      client.register.removeSingleMetric("llm_cost_total");
    }
    if (llmTimeToFirstToken) {
      client.register.removeSingleMetric("llm_time_to_first_token_seconds");
    }
    if (llmTokensPerSecond) {
      client.register.removeSingleMetric("llm_tokens_per_second");
    }
  } catch (_error) {
    // Ignore errors if metrics don't exist
  }

  // Create new metrics with updated label names
  // agent_id: External agent ID from X-Archestra-Agent-Id header (client-provided identifier)
  // profile_id/profile_name: Internal Archestra profile ID and name
  const baseLabelNames = [
    "provider",
    "model",
    "agent_id",
    "profile_id",
    "profile_name",
  ];

  llmRequestDuration = new client.Histogram({
    name: "llm_request_duration_seconds",
    help: "LLM request duration in seconds",
    labelNames: [...baseLabelNames, "status_code", ...nextLabelKeys],
    // Same bucket style as http_request_duration_seconds but adjusted for LLM latency
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  });

  llmTokensCounter = new client.Counter({
    name: "llm_tokens_total",
    help: "Total tokens used",
    labelNames: [...baseLabelNames, "type", ...nextLabelKeys], // type: input|output
  });

  llmBlockedToolCounter = new client.Counter({
    name: "llm_blocked_tools_total",
    help: "Blocked tool count",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
  });

  llmCostTotal = new client.Counter({
    name: "llm_cost_total",
    help: "Total estimated cost in USD",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
  });

  llmTimeToFirstToken = new client.Histogram({
    name: "llm_time_to_first_token_seconds",
    help: "Time to first token in seconds (streaming latency)",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    // Buckets optimized for TTFT - typically faster than full response
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  });

  llmTokensPerSecond = new client.Histogram({
    name: "llm_tokens_per_second",
    help: "Output tokens per second throughput",
    labelNames: [...baseLabelNames, ...nextLabelKeys],
    // Buckets for tokens/sec throughput - typical range 10-200 tokens/sec
    buckets: [5, 10, 25, 50, 75, 100, 150, 200, 300],
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
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
function buildMetricLabels(
  profile: Agent,
  additionalLabels: Record<string, string>,
  model?: string,
  externalAgentId?: string,
): Record<string, string> {
  // agent_id: External agent ID from X-Archestra-Agent-Id header (or empty if not provided)
  // profile_id/profile_name: Internal Archestra profile ID and name
  const labels: Record<string, string> = {
    agent_id: externalAgentId ?? "",
    profile_id: profile.id,
    profile_name: profile.name,
    model: model ?? "unknown",
    ...additionalLabels,
  };

  // Add agent label values for all registered label keys
  for (const labelKey of currentLabelKeys) {
    // Find the label value for this key from the agent's labels
    const agentLabel = profile.labels?.find(
      (l) => l.key.replace(sanitizeRegexp, "_") === labelKey,
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
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
export function reportLLMTokens(
  provider: SupportedProvider,
  profile: Agent,
  usage: { input?: number; output?: number },
  model: string | undefined,
  externalAgentId?: string,
): void {
  if (!llmTokensCounter) {
    logger.warn("LLM metrics not initialized, skipping token reporting");
    return;
  }

  if (usage.input && usage.input > 0) {
    llmTokensCounter.inc(
      buildMetricLabels(
        profile,
        { provider, type: "input" },
        model,
        externalAgentId,
      ),
      usage.input,
    );
  }
  if (usage.output && usage.output > 0) {
    llmTokensCounter.inc(
      buildMetricLabels(
        profile,
        { provider, type: "output" },
        model,
        externalAgentId,
      ),
      usage.output,
    );
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
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
export function reportBlockedTools(
  provider: SupportedProvider,
  profile: Agent,
  count: number,
  model?: string,
  externalAgentId?: string,
) {
  if (!llmBlockedToolCounter) {
    logger.warn(
      "LLM metrics not initialized, skipping blocked tools reporting",
    );
    return;
  }
  llmBlockedToolCounter.inc(
    buildMetricLabels(profile, { provider }, model, externalAgentId),
    count,
  );
}

/**
 * Reports estimated cost for LLM request in USD
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param model The model name
 * @param cost The cost in USD
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
export function reportLLMCost(
  provider: SupportedProvider,
  profile: Agent,
  model: string,
  cost: number | null | undefined,
  externalAgentId?: string,
): void {
  if (!llmCostTotal) {
    logger.warn("LLM metrics not initialized, skipping cost reporting");
    return;
  } else if (!cost) {
    logger.warn("Cost not specified when reporting");
    return;
  }
  llmCostTotal.inc(
    buildMetricLabels(profile, { provider }, model, externalAgentId),
    cost,
  );
}

/**
 * Reports time to first token (TTFT) for streaming LLM requests.
 * This metric helps application developers understand streaming latency
 * and choose models with lower initial response times.
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param model The model name
 * @param ttftSeconds Time to first token in seconds
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
export function reportTimeToFirstToken(
  provider: SupportedProvider,
  profile: Agent,
  model: string | undefined,
  ttftSeconds: number,
  externalAgentId?: string,
): void {
  if (!llmTimeToFirstToken) {
    logger.warn("LLM metrics not initialized, skipping TTFT reporting");
    return;
  }
  if (ttftSeconds <= 0) {
    logger.warn("Invalid TTFT value, must be positive");
    return;
  }
  llmTimeToFirstToken.observe(
    buildMetricLabels(profile, { provider }, model, externalAgentId),
    ttftSeconds,
  );
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
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
export function reportTokensPerSecond(
  provider: SupportedProvider,
  profile: Agent,
  model: string | undefined,
  outputTokens: number,
  durationSeconds: number,
  externalAgentId?: string,
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
  llmTokensPerSecond.observe(
    buildMetricLabels(profile, { provider }, model, externalAgentId),
    tokensPerSecond,
  );
}

/**
 * Returns a fetch wrapped in observability. Use it as OpenAI or Anthropic provider custom fetch implementation.
 * @param provider The LLM provider
 * @param profile The Archestra profile
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
export function getObservableFetch(
  provider: SupportedProvider,
  profile: Agent,
  externalAgentId?: string,
): Fetch {
  return async function observableFetch(
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (!llmRequestDuration) {
      logger.warn("LLM metrics not initialized, skipping duration tracking");
      return fetch(url, init);
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
      response = await fetch(url, init);
      const duration = Math.round((Date.now() - startTime) / 1000);
      const status = response.status.toString();

      llmRequestDuration.observe(
        buildMetricLabels(
          profile,
          { provider, status_code: status },
          model,
          externalAgentId,
        ),
        duration,
      );
    } catch (error) {
      // Network errors only: fetch does not throw on 4xx or 5xx.
      const duration = Math.round((Date.now() - startTime) / 1000);
      llmRequestDuration.observe(
        buildMetricLabels(
          profile,
          { provider, status_code: "0" },
          model,
          externalAgentId,
        ),
        duration,
      );
      throw error;
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
        if (provider === "openai") {
          const { input, output } = utils.adapters.openai.getUsageTokens(
            data.usage,
          );
          reportLLMTokens(
            provider,
            profile,
            { input, output },
            model,
            externalAgentId,
          );
        } else if (provider === "anthropic") {
          const { input, output } = utils.adapters.anthropic.getUsageTokens(
            data.usage,
          );
          reportLLMTokens(
            provider,
            profile,
            { input, output },
            model,
            externalAgentId,
          );
        } else {
          throw new Error("Unknown provider when logging usage token metrics");
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
 * @param externalAgentId Optional external agent ID from X-Archestra-Agent-Id header
 */
export function getObservableGenAI(
  genAI: GoogleGenAI,
  profile: Agent,
  externalAgentId?: string,
) {
  const originalGenerateContent = genAI.models.generateContent;
  const provider: SupportedProvider = "gemini";
  genAI.models.generateContent = async (...args) => {
    if (!llmRequestDuration) {
      logger.warn("LLM metrics not initialized, skipping duration tracking");
      return originalGenerateContent.apply(genAI.models, args);
    }

    // Extract model from args - first arg should contain model info
    let model: string | undefined;
    try {
      if (args[0] && typeof args[0] === "object" && "model" in args[0]) {
        model = args[0].model as string;
      }
    } catch (_error) {
      // Ignore extraction errors
    }

    const startTime = Date.now();

    try {
      const result = await originalGenerateContent.apply(genAI.models, args);
      const duration = Math.round((Date.now() - startTime) / 1000);

      // Assuming 200 status code. Gemini doesn't expose HTTP status, but unlike fetch, throws on 4xx & 5xx.
      llmRequestDuration.observe(
        buildMetricLabels(
          profile,
          { provider, status_code: "200" },
          model,
          externalAgentId,
        ),
        duration,
      );

      // Record token metrics
      const usage = result.usageMetadata;
      if (usage) {
        const { input, output } = utils.adapters.gemini.getUsageTokens(usage);
        reportLLMTokens(
          provider,
          profile,
          { input, output },
          model,
          externalAgentId,
        );
      }

      return result;
    } catch (error) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      const statusCode =
        error instanceof Error &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status.toString()
          : "0";

      llmRequestDuration.observe(
        buildMetricLabels(
          profile,
          { provider, status_code: statusCode },
          model,
          externalAgentId,
        ),
        duration,
      );

      throw error;
    }
  };
  return genAI;
}
