/**
 * Perplexity Adapter
 */
import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type {
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { estimateMessagesSize } from "@/utils/message-size";
import { unwrapToolContent } from "../utils/unwrap-tool-content";
import { OpenAIRequestAdapter, OpenAIResponseAdapter, OpenAIStreamAdapter } from "./openai";

type PerplexityRequest = any;
type PerplexityResponse = any;
type PerplexityMessages = any;
type PerplexityHeaders = any;
type PerplexityStreamChunk = any;

export const perplexityAdapterFactory: LLMProvider<
  PerplexityRequest,
  PerplexityResponse,
  PerplexityMessages,
  PerplexityStreamChunk,
  PerplexityHeaders
> = {
  provider: "perplexity",
  interactionType: "openai:chatCompletions",

  createRequestAdapter(request: PerplexityRequest): LLMRequestAdapter<PerplexityRequest, PerplexityMessages> {
    const adapter = new OpenAIRequestAdapter(request);
    (adapter as any).provider = "perplexity";
    return adapter;
  },

  createResponseAdapter(response: PerplexityResponse): LLMResponseAdapter<PerplexityResponse> {
    const adapter = new OpenAIResponseAdapter(response);
    (adapter as any).provider = "perplexity";
    return adapter;
  },

  createStreamAdapter(): LLMStreamAdapter<PerplexityStreamChunk, PerplexityResponse> {
    const adapter = new OpenAIStreamAdapter();
    (adapter as any).provider = "perplexity";
    return adapter;
  },

  extractApiKey(headers: PerplexityHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.perplexity.baseUrl;
  },

  getSpanName(): string {
    return "perplexity.chat.completions";
  },

  createClient(apiKey: string | undefined, options?: CreateClientOptions): OpenAIProvider {
    const customFetch = options?.agent
      ? getObservableFetch("perplexity", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(client: unknown, request: PerplexityRequest): Promise<PerplexityResponse> {
    const perplexityClient = client as OpenAIProvider;
    return perplexityClient.chat.completions.create({
      ...request,
      stream: false,
    } as any) as Promise<PerplexityResponse>;
  },

  async executeStream(client: unknown, request: PerplexityRequest): Promise<AsyncIterable<PerplexityStreamChunk>> {
    const perplexityClient = client as OpenAIProvider;
    const stream = await perplexityClient.chat.completions.create({
      ...request,
      stream: true,
      // Perplexity might not support include_usage
    } as any);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as PerplexityStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    const message = get(error, "error.message");
    if (typeof message === "string") return message;
    if (error instanceof Error) return error.message;
    return "Internal server error";
  },
};
