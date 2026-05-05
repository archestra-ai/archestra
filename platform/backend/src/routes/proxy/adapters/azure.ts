/**
 * Azure AI Foundry LLM Proxy Adapter - OpenAI-compatible
 *
 * Azure AI Foundry uses an OpenAI-compatible API.
 * The baseURL can be either the full deployment URL:
 *   https://<resource>.openai.azure.com/openai/deployments/<deployment>
 * or the v1 Foundry endpoint:
 *   https://<resource>.services.ai.azure.com/openai/v1
 *
 * This adapter delegates request/response/stream parsing to the OpenAI adapters
 * and only overrides provider-specific configuration.
 */
import { ArchestraInternalErrorCode } from "@shared";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import {
  normalizeAzureApiKey,
  shouldUseAzureOpenAiApiVersion,
} from "@/clients/azure-url";
import config from "@/config";
import { metrics } from "@/observability";
import type {
  Azure,
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
} from "@/types";
import { ApiError } from "@/types";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type AzureRequest = Azure.Types.ChatCompletionsRequest;
type AzureResponse = Azure.Types.ChatCompletionsResponse;
type AzureMessages = Azure.Types.ChatCompletionsRequest["messages"];
type AzureHeaders = Azure.Types.ChatCompletionsHeaders;
type AzureStreamChunk = Azure.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

class AzureRequestAdapter
  implements LLMRequestAdapter<AzureRequest, AzureMessages>
{
  readonly provider = "azure" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: AzureRequest) {
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
  convertToolResultContent(messages: AzureMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

class AzureResponseAdapter implements LLMResponseAdapter<AzureResponse> {
  readonly provider = "azure" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: AzureResponse) {
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

class AzureStreamAdapter
  implements LLMStreamAdapter<AzureStreamChunk, AzureResponse>
{
  readonly provider = "azure" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: AzureStreamChunk) {
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

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export const azureAdapterFactory: LLMProvider<
  AzureRequest,
  AzureResponse,
  AzureMessages,
  AzureStreamChunk,
  AzureHeaders
> = {
  provider: "azure",
  interactionType: "azure:chatCompletions",

  createRequestAdapter(
    request: AzureRequest,
  ): LLMRequestAdapter<AzureRequest, AzureMessages> {
    return new AzureRequestAdapter(request);
  },

  createResponseAdapter(
    response: AzureResponse,
  ): LLMResponseAdapter<AzureResponse> {
    return new AzureResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<AzureStreamChunk, AzureResponse> {
    return new AzureStreamAdapter();
  },

  extractApiKey(headers: AzureHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.azure.baseUrl || undefined;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "azure",
          options.agent,
          options.source,
          options.externalAgentId,
        )
      : undefined;

    if (!apiKey && isAzureOpenAiEntraIdEnabled()) {
      return new OpenAIProvider({
        apiKey: getAzureOpenAiBearerTokenProvider(options.baseUrl),
        baseURL: options.baseUrl,
        defaultQuery: getAzureDefaultQuery(options.baseUrl),
        fetch: customFetch,
        defaultHeaders: options.defaultHeaders,
      });
    }

    if (!apiKey) {
      throw new ApiError(401, "API key required for Azure AI Foundry");
    }

    const normalizedApiKey = normalizeAzureApiKey(apiKey);

    return new OpenAIProvider({
      apiKey: normalizedApiKey,
      baseURL: options.baseUrl,
      defaultQuery: getAzureDefaultQuery(options.baseUrl),
      fetch: customFetch,
      defaultHeaders: {
        ...options.defaultHeaders,
        "api-key": normalizedApiKey,
      },
    });
  },

  async execute(
    client: unknown,
    request: AzureRequest,
  ): Promise<AzureResponse> {
    const azureClient = client as OpenAIProvider;
    const azureRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;

    return (await azureClient.chat.completions.create(
      azureRequest,
    )) as unknown as AzureResponse;
  },

  async executeStream(
    client: unknown,
    request: AzureRequest,
  ): Promise<AsyncIterable<AzureStreamChunk>> {
    const azureClient = client as OpenAIProvider;
    const azureRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;

    const stream = await azureClient.chat.completions.create(azureRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as AzureStreamChunk;
        }
      },
    };
  },

  extractInternalCode(error: unknown): ArchestraInternalErrorCode | undefined {
    if (get(error, "error.code") === "context_length_exceeded") {
      return ArchestraInternalErrorCode.ContextLengthExceeded;
    }
    return undefined;
  },

  extractErrorMessage(error: unknown): string {
    const azureMessage = get(error, "error.message");
    if (typeof azureMessage === "string") {
      return azureMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};

function getAzureDefaultQuery(
  baseUrl: string | undefined,
): Record<string, string> | undefined {
  return shouldUseAzureOpenAiApiVersion(baseUrl)
    ? { "api-version": config.llm.azure.apiVersion }
    : undefined;
}
