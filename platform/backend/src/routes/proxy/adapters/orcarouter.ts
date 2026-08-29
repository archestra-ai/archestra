/**
 * OrcaRouter LLM Proxy Adapter - OpenAI-compatible
 *
 * OrcaRouter exposes an OpenAI-compatible API at https://api.orcarouter.ai/v1
 * (chat completions and embeddings), so the whole adapter is OpenAI's,
 * configured for OrcaRouter via createOpenAiCompatibleAdapterFactory.
 *
 * @see https://www.orcarouter.ai
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

export const orcarouterAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "orcarouter",
  interactionType: "orcarouter:chatCompletions",
  getBaseUrl: () => config.llm.orcarouter.baseUrl,
  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "orcarouter",
          options.agent,
          options.source,
        )
      : undefined;

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey,
      baseURL: options.baseUrl ?? config.llm.orcarouter.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
