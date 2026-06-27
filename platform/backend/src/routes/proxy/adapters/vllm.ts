/**
 * vLLM Adapter - OpenAI-compatible
 *
 * vLLM exposes an OpenAI-compatible API, so the whole adapter is OpenAI's,
 * configured for vLLM via createOpenAiCompatibleAdapterFactory.
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
 */
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const vllmAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "vllm",
  interactionType: "vllm:chatCompletions",
  getBaseUrl: () => config.llm.vllm.baseUrl,
  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "vllm",
          options.agent,
          options.source,
          options.externalAgentId,
        )
      : undefined;

    // vLLM typically runs without auth; the OpenAI SDK still requires a non-empty key.
    return new OpenAIProvider({
      apiKey: apiKey || "EMPTY",
      baseURL: options.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
  // vLLM returns a plain message (no structured error.code) on context overflow.
  extractInternalCode(error: unknown): ArchestraInternalErrorCode | undefined {
    const message: unknown = get(error, "error.message");
    if (
      typeof message === "string" &&
      message.toLowerCase().includes("maximum context length")
    ) {
      return ArchestraInternalErrorCode.ContextLengthExceeded;
    }
    return undefined;
  },
});
