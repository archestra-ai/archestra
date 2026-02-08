/**
 * x.AI Adapter
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

type XaiRequest = any; // Will use OpenAI types at runtime
type XaiResponse = any;
type XaiMessages = any;
type XaiHeaders = any;
type XaiStreamChunk = any;

export const xaiAdapterFactory: LLMProvider<
  XaiRequest,
  XaiResponse,
  XaiMessages,
  XaiStreamChunk,
  XaiHeaders
> = {
  provider: "xai",
  interactionType: "openai:chatCompletions",

  createRequestAdapter(request: XaiRequest): LLMRequestAdapter<XaiRequest, XaiMessages> {
    const adapter = new OpenAIRequestAdapter(request);
    (adapter as any).provider = "xai";
    return adapter;
  },

  createResponseAdapter(response: XaiResponse): LLMResponseAdapter<XaiResponse> {
    const adapter = new OpenAIResponseAdapter(response);
    (adapter as any).provider = "xai";
    return adapter;
  },

  createStreamAdapter(): LLMStreamAdapter<XaiStreamChunk, XaiResponse> {
    const adapter = new OpenAIStreamAdapter();
    (adapter as any).provider = "xai";
    return adapter;
  },

  extractApiKey(headers: XaiHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.xai.baseUrl;
  },

  getSpanName(): string {
    return "xai.chat.completions";
  },

  createClient(apiKey: string | undefined, options?: CreateClientOptions): OpenAIProvider {
    const customFetch = options?.agent
      ? getObservableFetch("xai", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(client: unknown, request: XaiRequest): Promise<XaiResponse> {
    const xaiClient = client as OpenAIProvider;
    return xaiClient.chat.completions.create({
      ...request,
      stream: false,
    } as any) as Promise<XaiResponse>;
  },

  async executeStream(client: unknown, request: XaiRequest): Promise<AsyncIterable<XaiStreamChunk>> {
    const xaiClient = client as OpenAIProvider;
    const stream = await xaiClient.chat.completions.create({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as any);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as XaiStreamChunk;
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
