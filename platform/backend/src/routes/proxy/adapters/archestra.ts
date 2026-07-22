/**
 * Archestra LLM Proxy Adapter - OpenAI-compatible
 *
 * The "archestra" provider lets one Archestra instance route through another
 * Archestra's LLM proxy. That proxy exposes an OpenAI-compatible
 * chat-completions API, so the whole adapter is OpenAI's, configured for
 * Archestra via createOpenAiCompatibleAdapterFactory. The upstream endpoint has
 * no default and is always supplied per key (base URL), e.g.
 * https://other-archestra/v1/proxy/openai/<agentId>.
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const archestraAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "archestra",
  interactionType: "archestra:chatCompletions",
  getBaseUrl: () => config.llm.archestra.baseUrl,
  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "archestra",
          options.agent,
          options.source,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options.baseUrl ?? config.llm.archestra.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
