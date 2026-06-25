/**
 * Cerebras LLM Proxy Adapter - OpenAI-compatible
 *
 * Cerebras exposes an OpenAI-compatible API at https://api.cerebras.ai/v1, so the
 * whole adapter is OpenAI's, configured for Cerebras via
 * createOpenAiCompatibleAdapterFactory.
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const cerebrasAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "cerebras",
  interactionType: "cerebras:chatCompletions",
  getBaseUrl: () => config.llm.cerebras.baseUrl,
  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "cerebras",
          options.agent,
          options.source,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
