import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { metrics } from "@/observability";
import type {
  CreateClientOptions,
  DeepSeek,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

type DeepSeekRequest = DeepSeek.Types.ChatCompletionsRequest;
type DeepSeekResponse = DeepSeek.Types.ChatCompletionsResponse;
type DeepSeekMessages = DeepSeek.Types.ChatCompletionsRequest["messages"];
type DeepSeekHeaders = DeepSeek.Types.ChatCompletionsHeaders;
type DeepSeekStreamChunk = DeepSeek.Types.ChatCompletionChunk;

class DeepSeekRequestAdapter
  implements LLMRequestAdapter<DeepSeekRequest, DeepSeekMessages>
{
  readonly provider = "deepseek" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: DeepSeekRequest) {
    this.delegate = new OpenAIRequestAdapter(request);
  }

  getModel() {
    return this.delegate.getModel();
  }
  isStreaming() {
    return this.delegate.isStreaming();
  }
  getMessages() {
    return this.delegate.getMessages();
  }
  getToolResults() {
    return this.delegate.getToolResults();
  }
  getTools() {
    return this.delegate.getTools();
  }
  hasTools() {
    return this.delegate.hasTools();
  }
  getProviderMessages() {
    return this.delegate.getProviderMessages();
  }
  getOriginalRequest() {
    return this.delegate.getOriginalRequest();
  }
  setModel(model: string) {
    return this.delegate.setModel(model);
  }
  updateToolResult(toolCallId: string, newContent: string) {
    return this.delegate.updateToolResult(toolCallId, newContent);
  }
  applyToolResultUpdates(updates: Record<string, string>) {
    return this.delegate.applyToolResultUpdates(updates);
  }
  applyToonCompression(model: string) {
    return this.delegate.applyToonCompression(model);
  }
  convertToolResultContent(messages: DeepSeekMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

class DeepSeekResponseAdapter
  implements LLMResponseAdapter<DeepSeekResponse>
{
  readonly provider = "deepseek" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: DeepSeekResponse) {
    this.delegate = new OpenAIResponseAdapter(response);
  }

  getId() {
    return this.delegate.getId();
  }
  getModel() {
    return this.delegate.getModel();
  }
  getText() {
    return this.delegate.getText();
  }
  getToolCalls() {
    return this.delegate.getToolCalls();
  }
  hasToolCalls() {
    return this.delegate.hasToolCalls();
  }
  getUsage() {
    return this.delegate.getUsage();
  }
  getOriginalResponse() {
    return this.delegate.getOriginalResponse();
  }
  getFinishReasons() {
    return this.delegate.getFinishReasons();
  }
  toRefusalResponse(refusalMessage: string, contentMessage: string) {
    return this.delegate.toRefusalResponse(refusalMessage, contentMessage);
  }
}

class DeepSeekStreamAdapter
  implements LLMStreamAdapter<DeepSeekStreamChunk, DeepSeekResponse>
{
  readonly provider = "deepseek" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: DeepSeekStreamChunk) {
    return this.delegate.processChunk(chunk);
  }
  getSSEHeaders() {
    return this.delegate.getSSEHeaders();
  }
  formatTextDeltaSSE(text: string) {
    return this.delegate.formatTextDeltaSSE(text);
  }
  getRawToolCallEvents() {
    return this.delegate.getRawToolCallEvents();
  }
  formatCompleteTextSSE(text: string) {
    return this.delegate.formatCompleteTextSSE(text);
  }
  formatEndSSE() {
    return this.delegate.formatEndSSE();
  }
  toProviderResponse() {
    return this.delegate.toProviderResponse();
  }
}

export const deepseekAdapterFactory: LLMProvider<
  DeepSeekRequest,
  DeepSeekResponse,
  DeepSeekMessages,
  DeepSeekStreamChunk,
  DeepSeekHeaders
> = {
  provider: "deepseek",
  interactionType: "deepseek:chatCompletions",

  createRequestAdapter(
    request: DeepSeekRequest,
  ): LLMRequestAdapter<DeepSeekRequest, DeepSeekMessages> {
    return new DeepSeekRequestAdapter(request);
  },

  createResponseAdapter(
    response: DeepSeekResponse,
  ): LLMResponseAdapter<DeepSeekResponse> {
    return new DeepSeekResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<
    DeepSeekStreamChunk,
    DeepSeekResponse
  > {
    return new DeepSeekStreamAdapter();
  },

  extractApiKey(headers: DeepSeekHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.deepseek.baseUrl;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    if (!apiKey) {
      throw new Error("API key required for DeepSeek");
    }

    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "deepseek",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
      defaultHeaders: options?.defaultHeaders,
    });
  },

  async execute(
    client: unknown,
    request: DeepSeekRequest,
  ): Promise<DeepSeekResponse> {
    const deepseekClient = client as OpenAIProvider;
    const deepseekRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;

    return (await deepseekClient.chat.completions.create(
      deepseekRequest,
    )) as unknown as DeepSeekResponse;
  },

  async executeStream(
    client: unknown,
    request: DeepSeekRequest,
  ): Promise<AsyncIterable<DeepSeekStreamChunk>> {
    const deepseekClient = client as OpenAIProvider;
    const deepseekRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;

    const stream =
      await deepseekClient.chat.completions.create(deepseekRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as DeepSeekStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    const deepseekMessage = get(error, "error.message");
    if (typeof deepseekMessage === "string") {
      return deepseekMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
