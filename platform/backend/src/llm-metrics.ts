/**
 * Custom observability metrics for LLMs: request metrics and token usage.
 * To instrument OpenAI or Anthropic clients, pass observable fetch to the fetch option.
 * For OpenAI or Anthropic streaming mode, proxy handlers call reportLLMTokens() after consuming the stream.
 * To instrument Gemini, provide its instance to getObservableGenAI, which will wrap around its model calls.
 */

import type { GoogleGenAI } from "@google/genai";
import client from "prom-client";
import logger from "@/logging";
import type { Agent } from "@/types";
import type { SupportedProvider } from "@/types/llm-providers";
import * as utils from "./routes/proxy/utils";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// LLM-specific metrics matching fastify-metrics format for consistency.
// You can monitor request count, duration and error rate with these.
let llmRequestDuration: client.Histogram<string>;
let llmTokensCounter: client.Counter<string>;

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

  if (!labelKeysChanged && llmRequestDuration && llmTokensCounter) {
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
  } catch (_error) {
    // Ignore errors if metrics don't exist
  }

  // Create new metrics with updated label names
  const baseLabelNames = ["provider", "agent_id", "agent_name"];
  const durationLabelNames = [
    ...baseLabelNames,
    "status_code",
    ...nextLabelKeys,
  ];
  const tokensLabelNames = [...baseLabelNames, "type", ...nextLabelKeys]; // type: input|output

  llmRequestDuration = new client.Histogram({
    name: "llm_request_duration_seconds",
    help: "LLM request duration in seconds",
    labelNames: durationLabelNames,
    // Same bucket style as http_request_duration_seconds but adjusted for LLM latency
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  });

  llmTokensCounter = new client.Counter({
    name: "llm_tokens_total",
    help: "Total tokens used",
    labelNames: tokensLabelNames,
  });

  logger.info(
    `Metrics initialized with ${nextLabelKeys.length} agent label keys: ${nextLabelKeys.join(", ")}`,
  );
}

/**
 * Helper function to build metric labels from agent
 */
function buildMetricLabels(
  agent: Agent,
  additionalLabels: Record<string, string>,
): Record<string, string> {
  const labels: Record<string, string> = {
    agent_id: agent.id,
    agent_name: agent.name,
    ...additionalLabels,
  };

  // Add agent label values for all registered label keys
  for (const labelKey of currentLabelKeys) {
    // Find the label value for this key from the agent's labels
    const agentLabel = agent.labels?.find(
      (l) => l.key.replace(sanitizeRegexp, "_") === labelKey,
    );
    labels[labelKey] = agentLabel?.value ?? "";
  }

  return labels;
}

/**
 * Reports LLM token usage
 */
export function reportLLMTokens(
  provider: SupportedProvider,
  agent: Agent,
  inputTokens?: number,
  outputTokens?: number,
): void {
  if (!llmTokensCounter) {
    logger.warn("LLM metrics not initialized, skipping token reporting");
    return;
  }

  if (inputTokens && inputTokens > 0) {
    llmTokensCounter.inc(
      buildMetricLabels(agent, { provider, type: "input" }),
      inputTokens,
    );
  }
  if (outputTokens && outputTokens > 0) {
    llmTokensCounter.inc(
      buildMetricLabels(agent, { provider, type: "output" }),
      outputTokens,
    );
  }
}

/**
 * Returns a fetch wrapped in observability. Use it as OpenAI or Anthropic provider custom fetch implementation.
 */
export function getObservableFetch(
  provider: SupportedProvider,
  agent: Agent,
): Fetch {
  return async function observableFetch(
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (!llmRequestDuration) {
      logger.warn("LLM metrics not initialized, skipping duration tracking");
      return fetch(url, init);
    }

    const startTime = Date.now();
    let response: Response;

    try {
      response = await fetch(url, init);
      const duration = Math.round((Date.now() - startTime) / 1000);
      const status = response.status.toString();
      llmRequestDuration.observe(
        buildMetricLabels(agent, { provider, status_code: status }),
        duration,
      );
    } catch (error) {
      // Network errors only: fetch does not throw on 4xx or 5xx.
      const duration = Math.round((Date.now() - startTime) / 1000);
      llmRequestDuration.observe(
        buildMetricLabels(agent, { provider, status_code: "0" }),
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
        if (!data.usage) {
          return response;
        }
        if (provider === "openai") {
          const { input, output } = utils.adapters.openai.getUsageTokens(
            data.usage,
          );
          reportLLMTokens(provider, agent, input, output);
        } else if (provider === "anthropic") {
          const { input, output } = utils.adapters.anthropic.getUsageTokens(
            data.usage,
          );
          reportLLMTokens(provider, agent, input, output);
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
 */
export function getObservableGenAI(genAI: GoogleGenAI, agent: Agent) {
  const originalGenerateContent = genAI.models.generateContent;
  const provider: SupportedProvider = "gemini";
  genAI.models.generateContent = async (...args) => {
    if (!llmRequestDuration) {
      logger.warn("LLM metrics not initialized, skipping duration tracking");
      return originalGenerateContent.apply(genAI.models, args);
    }

    const startTime = Date.now();

    try {
      const result = await originalGenerateContent.apply(genAI.models, args);
      const duration = Math.round((Date.now() - startTime) / 1000);

      // Assuming 200 status code. Gemini doesn't expose HTTP status, but unlike fetch, throws on 4xx & 5xx.
      llmRequestDuration.observe(
        buildMetricLabels(agent, { provider, status_code: "200" }),
        duration,
      );

      // Record token metrics
      const usage = result.usageMetadata;
      if (usage) {
        const { input, output } = utils.adapters.gemini.getUsageTokens(usage);
        reportLLMTokens(provider, agent, input, output);
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
        buildMetricLabels(agent, { provider, status_code: statusCode }),
        duration,
      );

      throw error;
    }
  };
  return genAI;
}
