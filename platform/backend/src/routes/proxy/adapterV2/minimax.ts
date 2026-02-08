/**
 * MiniMax Adapter
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

type MinimaxRequest = any;
type MinimaxResponse = any;
type MinimaxMessages = any;
type MinimaxHeaders = any;
type MinimaxStreamChunk = any;

export const minimaxAdapterFactory: LLMProvider<
  MinimaxRequest,
  MinimaxResponse,
  MinimaxMessages,
  MinimaxStreamChunk,
  MinimaxHeaders
> = {
  provider: "minimax",
  interactionType: "openai:chatCompletions",

  createRequestAdapter(request: MinimaxRequest): LLMRequestAdapter<MinimaxRequest, MinimaxMessages> {
    const adapter = new OpenAIRequestAdapter(request);
    (adapter as any).provider = "minimax";
    return adapter;
  },

  createResponseAdapter(response: MinimaxResponse): LLMResponseAdapter<MinimaxResponse> {
    const adapter = new OpenAIResponseAdapter(response);
    (adapter as any).provider = "minimax";
    return adapter;
  },

  createStreamAdapter(): LLMStreamAdapter<MinimaxStreamChunk, MinimaxResponse> {
    const adapter = new OpenAIStreamAdapter();
    (adapter as any).provider = "minimax";
    return adapter;
  },

  extractApiKey(headers: MinimaxHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.minimax.baseUrl;
  },

  getSpanName(): string {
    return "minimax.chat.completions";
  },

  createClient(apiKey: string | undefined, options?: CreateClientOptions): OpenAIProvider {
    const customFetch = options?.agent
      ? getObservableFetch("minimax", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(client: unknown, request: MinimaxRequest): Promise<MinimaxResponse> {
    const minimaxClient = client as OpenAIProvider;
    return minimaxClient.chat.completions.create({
      ...request,
      stream: false,
    } as any) as Promise<MinimaxResponse>;
  },

  async executeStream(client: unknown, request: MinimaxRequest): Promise<AsyncIterable<MinimaxStreamChunk>> {
    const minimaxClient = client as OpenAIProvider;
    const stream = await minimaxClient.chat.completions.create({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as any);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as MinimaxStreamChunk;
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
