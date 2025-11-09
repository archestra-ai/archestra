/**
 * Custom observability metrics for LLMs: request metrics and token usage.
 * To instrument OpenAI or Anthropic clients, pass observable fetch to the fetch option.
 * For OpenAI or Anthropic streaming mode, proxy handlers call reportUsage() after consuming the stream.
 * To instrument Gemini, provide its instance to getObservableGenAI, which will wrap around its model calls.
 */

import type { GoogleGenAI } from "@google/genai";
import client from "prom-client";
import { llmPricing, PricingModel } from "@/llm-pricing";
import logger from "@/logging";
import type { Agent, SupportedProvider } from "@/types";
import * as utils from "./routes/proxy/utils";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// originalModel is the model requested by user if the cost optimization is in effect
type ProviderModel = { provider: SupportedProvider, model: string, originalModel?: string };

// LLM-specific metrics matching fastify-metrics format for consistency.
// You can monitor request count, duration and error rate with these.
let llmRequestDuration: client.Histogram<string>;
let llmTokensCounter: client.Counter<string>;
let llmCostCounter: client.Counter<string>;
let llmRequestedCostCounter: client.Counter<string>;

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
    llmCostCounter &&
    llmRequestedCostCounter
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
    if (llmCostCounter) {
      client.register.removeSingleMetric("llm_cost_usd");
    }
    if (llmRequestedCostCounter) {
      client.register.removeSingleMetric("llm_requested_cost_usd");
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
  const costLabelNames = [...baseLabelNames, "model", ...nextLabelKeys];
  const requestedCostLabelNames = [
    ...baseLabelNames,
    "requested_model",
    ...nextLabelKeys,
  ];

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

  llmCostCounter = new client.Counter({
    name: "llm_cost_usd",
    help: "Actual cost of LLM requests in USD",
    labelNames: costLabelNames,
  });

  llmRequestedCostCounter = new client.Counter({
    name: "llm_requested_cost_usd",
    help: "Cost of requested model (before optimization) in USD",
    labelNames: requestedCostLabelNames,
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

function getCost(model: PricingModel, usage: { input?: number, output?: number }): number {
  const pricing = llmPricing.openai[model];
  return ((usage.input ?? 0) * pricing.input + (usage.output ?? 0) * pricing.output) / 1000000;
}

/**
 * Reports LLM token usage and costs
 */
export function reportUsage(
  agent: Agent,
  { provider, model, originalModel }: ProviderModel,
  usage: { input?: number, output?: number },
): void {
  if (!llmTokensCounter) {
    logger.warn("LLM metrics not initialized, skipping token reporting");
    return;
  }

  // Report token usage
  if (usage.input && usage.input > 0) {
    llmTokensCounter.inc(
      buildMetricLabels(agent, { provider, type: "input" }),
      usage.input,
    );
  }
  if (usage.output && usage.output > 0) {
    llmTokensCounter.inc(
      buildMetricLabels(agent, { provider, type: "output" }),
      usage.output,
    );
  }

  // Report costs (OpenAI only for now)
  if (provider === "openai" && model && usage.input > 0 && usage.output > 0) {
    const normalizedModel = utils.adapters.openai.normalizeModel(model);
    if (normalizedModel in llmPricing.openai) {
      const cost = getCost(normalizedModel, usage);
      llmCostCounter.inc(buildMetricLabels(agent, { provider, model: normalizedModel }), cost,);
    }

    if (originalModel) {
      const normalizedModel = utils.adapters.openai.normalizeModel(originalModel);
      if (normalizedModel in llmPricing.openai) {
        const requestedCost = getCost(normalizedModel, usage);
        llmRequestedCostCounter.inc(buildMetricLabels(agent, { provider, model: normalizedModel }), requestedCost,);
      }
    }
  }
}

/**
 * Returns a fetch wrapped in observability. Use it as OpenAI or Anthropic provider custom fetch implementation.
 */
export function getObservableFetch(
  agent: Agent,
  { provider, model, originalModel }: ProviderModel,
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
          reportUsage(agent, {provider, model, originalModel}, { input, output });
        } else if (provider === "anthropic") {
          const { input, output } = utils.adapters.anthropic.getUsageTokens(
            data.usage,
          );
          reportUsage(agent, {provider, model, originalModel}, { input, output });
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
export function getObservableGenAI(genAI: GoogleGenAI, agent: Agent, model: string) {
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
        reportUsage(agent, { provider, model },{input, output});
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
