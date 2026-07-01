/**
 * Ollama Adapter - OpenAI-compatible
 *
 * Ollama exposes an OpenAI-compatible API, so the whole adapter is OpenAI's,
 * configured for Ollama via createOpenAiCompatibleAdapterFactory.
 * See: https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const ollamaAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "ollama",
  interactionType: "ollama:chatCompletions",
  getBaseUrl: () => config.llm.ollama.baseUrl,
  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "ollama",
          options.agent,
          options.source,
          options.externalAgentId,
        )
      : undefined;

    // Ollama typically runs without auth; the OpenAI SDK still requires a non-empty key.
    return new OpenAIProvider({
      apiKey: apiKey || "EMPTY",
      baseURL: options.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
