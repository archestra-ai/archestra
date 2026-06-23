/**
 * DeepSeek LLM Proxy Adapter - OpenAI-compatible
 *
 * DeepSeek uses an OpenAI-compatible API (with optional extras like
 * reasoning_content), so the whole adapter is OpenAI's, configured for
 * DeepSeek via createOpenAiCompatibleAdapterFactory.
 *
 * @see https://api-docs.deepseek.com/api/create-chat-completion
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const deepseekAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "deepseek",
  interactionType: "deepseek:chatCompletions",
  getBaseUrl: () => config.llm.deepseek.baseUrl,
  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "deepseek",
          options.agent,
          options.source,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options.baseUrl ?? config.llm.deepseek.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
