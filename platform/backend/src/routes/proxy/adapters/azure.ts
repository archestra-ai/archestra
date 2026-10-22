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

import { ArchestraInternalErrorCode } from "@archestra/shared";
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
  buildAzureDeploymentBaseUrl,
  createAzureFetchWithRequestQuery,
  isAzureOpenAiFirstPartyModelName,
  isAzureThinkingModelName,
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
  OpenAi,
  StreamAccumulatorState,
} from "@/types";
import { ApiError } from "@/types";
import type { ReasoningEffort } from "@/types/model";
import {
  makeOpenAiCompatibleEmbeddingsAdapterFactory,
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type AzureRequest = Azure.Types.ChatCompletionsRequest;
type AzureResponse = Azure.Types.ChatCompletionsResponse;
type AzureMessages = Azure.Types.ChatCompletionsRequest["messages"];
type AzureHeaders = Azure.Types.ChatCompletionsHeaders;
type AzureStreamChunk = Azure.Types.ChatCompletionChunk;

type AzureClient = {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  apiVersion: string;
  defaultHeaders: Record<string, string> | undefined;
  fetch: typeof globalThis.fetch | undefined;
  openai: OpenAIProvider;
};

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

  constructor(private readonly response: AzureResponse) {
    this.delegate = new OpenAIResponseAdapter(response);
  }

  getId() {
    return this.delegate.getId();
  }
  getModel() {
    return this.delegate.getModel();
  }
  getText() {
    return (
      this.delegate.getText() ||
      this.response.choices[0]?.message.audio?.transcript ||
      ""
    );
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
  withRewrittenToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
  ) {
    return this.delegate.withRewrittenToolCalls(toolCalls);
  }
}

class AzureStreamAdapter
  implements LLMStreamAdapter<AzureStreamChunk, AzureResponse>
{
  readonly provider = "azure" as const;
  private delegate: OpenAIStreamAdapter;
  private audio: {
    id?: string;
    expires_at?: number;
    transcript: string;
  } | null = null;
  private audioChunks: Buffer[] = [];
  private audioBytes = 0;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: AzureStreamChunk) {
    const result = this.delegate.processChunk(chunk);
    // The SDK's chunk type does not declare Azure's native audio deltas. They
    // contain model-authored output, even when accompanied by a role preamble.
    const delta = chunk.choices?.[0]?.delta;
    const audio = (
      delta as
        | {
            audio?: {
              id?: string;
              data?: string;
              expires_at?: number;
              transcript?: string;
            };
          }
        | undefined
    )?.audio;
    if (!audio) return result;
    this.audio ??= { transcript: "" };
    if (audio.id) this.audio.id = audio.id;
    if (audio.expires_at !== undefined)
      this.audio.expires_at = audio.expires_at;
    if (audio.transcript) {
      this.audio.transcript += audio.transcript;
      // Native audio has a transcript instead of delta.content; expose it to
      // response policies and logs without duplicating Realtime's text delta.
      if (!delta?.content) this.state.text += audio.transcript;
    }
    if (audio.data) {
      const bytes = Buffer.from(audio.data, "base64");
      this.audioBytes += bytes.length;
      if (this.audioBytes > 16 * 1024 * 1024)
        throw new ApiError(502, "Azure audio output exceeded the size limit.");
      this.audioChunks.push(bytes);
    }
    // Preserve the original audio frame, while leaving tool calls under the
    // delegate's policy gate. A pure audio delta otherwise produces no SSE.
    if (!result.sseData && delta) {
      const { tool_calls: _toolCalls, ...safeDelta } = delta;
      result.sseData = `data: ${JSON.stringify({
        ...chunk,
        choices: [{ ...chunk.choices[0], delta: safeDelta }],
      })}\n\n`;
    }
    result.isResponsePreamble = false;
    return result;
  }
  getSSEHeaders() {
    return this.delegate.getSSEHeaders();
  }
  formatTextDeltaSSE(text: string) {
    return this.delegate.formatTextDeltaSSE(text);
  }
  setTextSuffix(getSuffix: (completedText: string) => string) {
    this.delegate.setTextSuffix(getSuffix);
  }
  getRawToolCallEvents() {
    return this.delegate.getRawToolCallEvents();
  }
  prepareResponseReplacement() {
    this.audio = null;
    this.audioChunks = [];
    this.audioBytes = 0;
    this.delegate.prepareResponseReplacement();
  }
  formatCompleteTextSSE(text: string) {
    return this.delegate.formatCompleteTextSSE(text);
  }
  formatToolCallsSSE(toolCalls: StreamAccumulatorState["toolCalls"]) {
    return this.delegate.formatToolCallsSSE(toolCalls);
  }
  formatEndSSE() {
    return this.delegate.formatEndSSE();
  }
  toProviderResponse() {
    const response = this.delegate.toProviderResponse();
    if (this.audio)
      response.choices[0].message.audio = {
        ...this.audio,
        data: Buffer.concat(this.audioChunks).toString("base64"),
      };
    return response;
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
  ): AzureClient {
    const baseUrl = options.azureRequest?.deployment
      ? (buildAzureDeploymentBaseUrl({
          baseUrl: options.baseUrl,
          deploymentName: options.azureRequest.deployment,
          overrideDeployment: true,
        }) ?? options.baseUrl)
      : options.baseUrl;
    const observableFetch = options.agent
      ? metrics.llm.getObservableFetch("azure", options.agent, options.source)
      : undefined;
    const customFetch = createAzureFetchWithRequestQuery({
      fetch: observableFetch,
      rawQuery: options.azureRequest?.rawQuery,
      abortSignal: options.abortSignal,
    });
    const apiVersion =
      new URLSearchParams(options.azureRequest?.rawQuery).get("api-version") ??
      config.llm.azure.apiVersion;

    if (!apiKey && isAzureOpenAiEntraIdEnabled()) {
      const client = new OpenAIProvider({
        maxRetries: PROXY_SDK_MAX_RETRIES,
        apiKey: getAzureOpenAiBearerTokenProvider(baseUrl),
        baseURL: baseUrl,
        defaultQuery: getAzureDefaultQuery(baseUrl),
        fetch: customFetch,
        defaultHeaders: options.defaultHeaders,
      });
      return {
        apiKey,
        baseUrl: baseUrl,
        apiVersion,
        defaultHeaders: options.defaultHeaders,
        fetch: customFetch,
        openai: client,
      };
    }

    if (!apiKey) {
      throw new ApiError(401, "API key required for Azure AI Foundry");
    }

    const normalizedApiKey = normalizeAzureApiKey(apiKey);
    if (!normalizedApiKey) {
      throw new ApiError(401, "API key required for Azure AI Foundry");
    }

    const defaultHeaders = {
      ...options.defaultHeaders,
      "api-key": normalizedApiKey,
    };

    const client = new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey: normalizedApiKey,
      baseURL: baseUrl,
      defaultQuery: getAzureDefaultQuery(baseUrl),
      fetch: customFetch,
      defaultHeaders,
    });

    return {
      apiKey: normalizedApiKey,
      baseUrl: baseUrl,
      apiVersion,
      defaultHeaders,
      fetch: customFetch,
      openai: client,
    };
  },

  async execute(
    client: unknown,
    request: AzureRequest,
  ): Promise<AzureResponse> {
    const azureClient = getAzureClientForRequest(client, request.model);
    const azureRequest = {
      ...withAzureMaxCompletionTokens(request, client as AzureClient),
      ...defaultAzureReasoningEffort(request),
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
    const azureClient = getAzureClientForRequest(client, request.model);
    const azureRequest = {
      ...withAzureMaxCompletionTokens(request, client as AzureClient),
      ...defaultAzureReasoningEffort(request),
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

/** Azure embeddings need Azure authentication and deployment-scoped classic URLs. */
export const azureEmbeddingsAdapterFactory = {
  ...makeOpenAiCompatibleEmbeddingsAdapterFactory(
    "azure",
    () => config.llm.azure.baseUrl || undefined,
  ),
  createClient: azureAdapterFactory.createClient,
  async execute(client: unknown, request: OpenAi.Types.EmbeddingRequest) {
    return getAzureClientForRequest(client, request.model).embeddings.create(
      request as Parameters<OpenAIProvider["embeddings"]["create"]>[0],
    );
  },
};

export function getAzureClientForRequest(
  client: unknown,
  model: string,
): OpenAIProvider {
  const azureClient = client as AzureClient;
  const deploymentBaseUrl = buildAzureDeploymentBaseUrl({
    baseUrl: azureClient.baseUrl,
    deploymentName: model,
  });

  if (!deploymentBaseUrl || deploymentBaseUrl === azureClient.baseUrl) {
    return azureClient.openai;
  }

  return new OpenAIProvider({
    maxRetries: PROXY_SDK_MAX_RETRIES,
    apiKey:
      azureClient.apiKey ??
      getAzureOpenAiBearerTokenProvider(deploymentBaseUrl),
    baseURL: deploymentBaseUrl,
    defaultQuery: getAzureDefaultQuery(deploymentBaseUrl),
    fetch: azureClient.fetch,
    defaultHeaders: azureClient.defaultHeaders,
  });
}

/**
 * Reasoning models on Foundry only split their thinking into
 * `reasoning_content` when the request asks for it; with no `reasoning_effort`
 * they narrate it inline in `content`, where nothing can tell thinking from
 * answer. Default the parameter for deployments known to accept it, and never
 * override a value the caller set — an explicit `"none"` must keep meaning
 * "no thinking".
 */
function defaultAzureReasoningEffort(request: AzureRequest): {
  reasoning_effort?: ReasoningEffort;
} {
  const existing = (request as { reasoning_effort?: unknown }).reasoning_effort;
  if (existing !== undefined) {
    return {};
  }

  const model = typeof request.model === "string" ? request.model : "";
  if (!isAzureThinkingModelName(model)) {
    return {};
  }

  return { reasoning_effort: DEFAULT_AZURE_REASONING_EFFORT };
}

const DEFAULT_AZURE_REASONING_EFFORT: ReasoningEffort = "medium";

/**
 * Azure's OpenAI reasoning deployments reject `max_tokens` ("Use
 * 'max_completion_tokens' instead"), and clients still send it: the AI SDK
 * only switches fields for model names it knows are reasoning models, which
 * misses newer families. `max_completion_tokens` caps every OpenAI chat model
 * the same way, so send it for OpenAI deployments. Open models keep
 * `max_tokens`, and so do classic endpoints pinned to an api-version that
 * predates `max_completion_tokens`.
 */
function withAzureMaxCompletionTokens(
  request: AzureRequest,
  client: AzureClient,
): AzureRequest {
  const { max_tokens: maxTokens, ...rest } = request;
  if (
    maxTokens == null ||
    request.max_completion_tokens != null ||
    !isAzureOpenAiFirstPartyModelName(request.model) ||
    !azureAcceptsMaxCompletionTokens(client)
  ) {
    return request;
  }
  return { ...rest, max_completion_tokens: maxTokens };
}

function azureAcceptsMaxCompletionTokens(client: AzureClient): boolean {
  // v1 URLs carry no api-version and always accept the field. Dated
  // api-versions compare lexically; the field shipped in 2024-09-01-preview.
  return (
    !shouldUseAzureOpenAiApiVersion(client.baseUrl) ||
    client.apiVersion >= MAX_COMPLETION_TOKENS_API_VERSION
  );
}

const MAX_COMPLETION_TOKENS_API_VERSION = "2024-09-01";

function getAzureDefaultQuery(
  baseUrl: string | undefined,
): Record<string, string> | undefined {
  return shouldUseAzureOpenAiApiVersion(baseUrl)
    ? { "api-version": config.llm.azure.apiVersion }
    : undefined;
}
