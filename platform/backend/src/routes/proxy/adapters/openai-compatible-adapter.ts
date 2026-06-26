/**
 * Factory for OpenAI-compatible LLM proxy adapters.
 *
 * Providers whose chat-completions API matches OpenAI's (DeepSeek, GitHub
 * Copilot, …) reuse OpenAI's request/response/stream adapters verbatim — only
 * the provider name, base URL, and client construction differ. This factory
 * builds the whole `LLMProvider` for such a provider so each one is a few lines
 * of configuration instead of a per-method delegation wrapper.
 */
import {
  ArchestraInternalErrorCode,
  type SupportedProvider,
  type SupportedProviderDiscriminator,
} from "@archestra/shared";
import { get } from "lodash-es";
import type OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import type {
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
} from "@/types";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// OpenAI-compatible providers reuse OpenAI's wire types (their own type modules
// are OpenAI schemas re-exported with `.passthrough()`), so the adapters are
// structurally identical to OpenAI's.
type Request = OpenAi.Types.ChatCompletionsRequest;
type Response = OpenAi.Types.ChatCompletionsResponse;
type Messages = OpenAi.Types.ChatCompletionsRequest["messages"];
type Headers = OpenAi.Types.ChatCompletionsHeaders;
type StreamChunk = OpenAi.Types.ChatCompletionChunk;

interface OpenAiCompatibleAdapterOptions {
  provider: SupportedProvider;
  interactionType: SupportedProviderDiscriminator;
  getBaseUrl: () => string | undefined;
  createClient: (
    apiKey: string | undefined,
    options: CreateClientOptions,
  ) => OpenAIProvider;
  /**
   * Override context-overflow detection. The default matches OpenAI's structured
   * `error.code === "context_length_exceeded"`; providers that only return a plain
   * message (vLLM, Ollama) supply their own substring check.
   */
  extractInternalCode?: (
    error: unknown,
  ) => ArchestraInternalErrorCode | undefined;
}

function defaultExtractInternalCode(
  error: unknown,
): ArchestraInternalErrorCode | undefined {
  if (get(error, "error.code") === "context_length_exceeded") {
    return ArchestraInternalErrorCode.ContextLengthExceeded;
  }
  return undefined;
}

export function createOpenAiCompatibleAdapterFactory(
  options: OpenAiCompatibleAdapterOptions,
): LLMProvider<Request, Response, Messages, StreamChunk, Headers> {
  const { provider, interactionType, getBaseUrl, createClient } = options;

  return {
    provider,
    interactionType,
    spanName: "chat",

    createRequestAdapter(
      request: Request,
    ): LLMRequestAdapter<Request, Messages> {
      return new OpenAIRequestAdapter(request, provider);
    },

    createResponseAdapter(response: Response): LLMResponseAdapter<Response> {
      return new OpenAIResponseAdapter(response, provider);
    },

    createStreamAdapter(): LLMStreamAdapter<StreamChunk, Response> {
      return new OpenAIStreamAdapter(provider);
    },

    extractApiKey(headers: Headers): string | undefined {
      return headers.authorization;
    },

    getBaseUrl,

    createClient,

    async execute(client: unknown, request: Request): Promise<Response> {
      const openaiClient = client as OpenAIProvider;
      const params = {
        ...request,
        stream: false,
      } as unknown as ChatCompletionCreateParamsNonStreaming;
      return openaiClient.chat.completions.create(
        params,
      ) as unknown as Promise<Response>;
    },

    async executeStream(
      client: unknown,
      request: Request,
    ): Promise<AsyncIterable<StreamChunk>> {
      const openaiClient = client as OpenAIProvider;
      const params = {
        ...request,
        stream: true,
        stream_options: { include_usage: true },
      } as unknown as ChatCompletionCreateParamsStreaming;
      const stream = await openaiClient.chat.completions.create(params);

      return {
        [Symbol.asyncIterator]: async function* () {
          for await (const chunk of stream) {
            yield chunk as StreamChunk;
          }
        },
      };
    },

    extractInternalCode:
      options.extractInternalCode ?? defaultExtractInternalCode,

    extractErrorMessage(error: unknown): string {
      const openaiMessage = get(error, "error.message");
      if (typeof openaiMessage === "string") {
        return openaiMessage;
      }
      if (error instanceof Error) {
        return error.message;
      }
      return "Internal server error";
    },
  };
}
