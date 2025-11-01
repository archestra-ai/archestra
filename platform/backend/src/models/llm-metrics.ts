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
import * as utils from "../routes/proxy/utils";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// Store agent label keys for dynamic metric labels
let agentLabelKeys: string[] = [];

// LLM-specific metrics matching fastify-metrics format for consistency.
// You can monitor request count, duration and error rate with these.
let llmRequestDuration: client.Histogram<string>;
let llmTokensCounter: client.Counter<string>;

/**
 * Initialize metrics with dynamic agent label keys.
 * Must be called during application startup after database is ready.
 */
export function initializeMetrics(labelKeys: string[]): void {
  agentLabelKeys = labelKeys;

  // Create histogram with base labels + dynamic agent labels
  llmRequestDuration = new client.Histogram({
    name: "llm_request_duration_seconds",
    help: "LLM request duration in seconds",
    labelNames: [
      "provider",
      "agent_id",
      "agent_name",
      "status_code",
      ...labelKeys,
    ],
    // Same bucket style as http_request_duration_seconds but adjusted for LLM latency
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  });

  llmTokensCounter = new client.Counter({
    name: "llm_tokens_total",
    help: "Total tokens used",
    labelNames: ["provider", "agent_id", "agent_name", "type", ...labelKeys], // type: input|output
  });
}

/**
 * Build labels object including agent labels
 */
function buildLabels(
  baseLabels: Record<string, string>,
  agent: Agent,
): Record<string, string> {
  const labels = { ...baseLabels };

  // Add agent label values, using empty string for missing labels
  for (const labelKey of agentLabelKeys) {
    const agentLabel = agent.labels?.find((l) => l.key === labelKey);
    labels[labelKey] = agentLabel?.value || "";
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
    logger.warn("LLM metrics not initialized. Call initializeMetrics() first.");
    return;
  }

  if (inputTokens && inputTokens > 0) {
    const labels = buildLabels(
      { provider, agent_id: agent.id, agent_name: agent.name, type: "input" },
      agent,
    );
    llmTokensCounter.inc(labels, inputTokens);
  }
  if (outputTokens && outputTokens > 0) {
    const labels = buildLabels(
      { provider, agent_id: agent.id, agent_name: agent.name, type: "output" },
      agent,
    );
    llmTokensCounter.inc(labels, outputTokens);
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
    const startTime = Date.now();
    let response: Response;

    try {
      response = await fetch(url, init);
      const duration = Math.round((Date.now() - startTime) / 1000);
      const status = response.status.toString();

      if (llmRequestDuration) {
        const labels = buildLabels(
          {
            provider,
            agent_id: agent.id,
            agent_name: agent.name,
            status_code: status,
          },
          agent,
        );
        llmRequestDuration.observe(labels, duration);
      }
    } catch (error) {
      // Network errors only: fetch does not throw on 4xx or 5xx.
      const duration = Math.round((Date.now() - startTime) / 1000);

      if (llmRequestDuration) {
        const labels = buildLabels(
          {
            provider,
            agent_id: agent.id,
            agent_name: agent.name,
            status_code: "0",
          },
          agent,
        );
        llmRequestDuration.observe(labels, duration);
      }
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
    const startTime = Date.now();

    try {
      const result = await originalGenerateContent.apply(genAI.models, args);
      const duration = Math.round((Date.now() - startTime) / 1000);

      // Assuming 200 status code. Gemini doesn't expose HTTP status, but unlike fetch, throws on 4xx & 5xx.
      if (llmRequestDuration) {
        const labels = buildLabels(
          {
            provider,
            agent_id: agent.id,
            agent_name: agent.name,
            status_code: "200",
          },
          agent,
        );
        llmRequestDuration.observe(labels, duration);
      }

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

      if (llmRequestDuration) {
        const labels = buildLabels(
          {
            provider,
            agent_id: agent.id,
            agent_name: agent.name,
            status_code: statusCode,
          },
          agent,
        );
        llmRequestDuration.observe(labels, duration);
      }

      throw error;
    }
  };
  return genAI;
}
