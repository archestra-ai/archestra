/**
 * Kimi (Moonshot AI) LLM Proxy Adapter - OpenAI-compatible
 *
 * Kimi uses an OpenAI-compatible API, so the whole adapter is OpenAI's,
 * configured for Kimi via createOpenAiCompatibleAdapterFactory.
 *
 * @see https://platform.moonshot.ai/docs/api/chat
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const kimiAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "kimi",
  interactionType: "kimi:chatCompletions",
  getBaseUrl: () => config.llm.kimi.baseUrl,
  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch("kimi", options.agent, options.source)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options.baseUrl ?? config.llm.kimi.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
