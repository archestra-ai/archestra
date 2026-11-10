/**
 * How a pooled request reaches one member.
 *
 * The proxy pipeline (guardrails, OpenAPPA, logging) runs once, on the shapes
 * of the wire the client spoke. Each member then gets a transport that takes
 * a request in those shapes and returns a response or chunk stream in those
 * shapes, whatever the member's own provider speaks: the same wire is sent
 * as is with the member's model id, and a different wire goes through a
 * translator. A pool containing incompatible enabled members is rejected.
 */
import {
  isClaudeOnBedrock,
  isModelPoolProvider,
  type ModelPoolProvider,
  type SupportedProvider,
  type SupportedProviderDiscriminator,
} from "@archestra/shared";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import {
  openAIUsageTokens,
  reportsReasoningOutsideCompletion,
  withReasoningOutsideCompletion,
} from "@/observability/metrics/llm-usage";
import type {
  Anthropic,
  Bedrock,
  Gemini,
  LLMProvider,
  OpenAi,
  UsageView,
} from "@/types";
import { asRecord } from "@/utils/as-record";
import { ObservedProviderUsageError } from "@/utils/observed-provider-usage-error";
import { UpstreamStreamIncompleteError } from "@/utils/upstream-stream-incomplete-error";
import {
  anthropicAdapterFactory,
  azureAdapterFactory,
  azureResponsesAdapterFactory,
  bedrockAdapterFactory,
  bedrockInvokeAdapterFactory,
  cerebrasAdapterFactory,
  deepseekAdapterFactory,
  geminiAdapterFactory,
  githubCopilotAdapterFactory,
  githubCopilotResponsesAdapterFactory,
  groqAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
  openrouterAdapterFactory,
  perplexityAdapterFactory,
  vllmAdapterFactory,
  xaiAdapterFactory,
  zhipuaiAdapterFactory,
} from "./adapters";
import { withAnthropicToolCallIds } from "./adapters/anthropic";
import {
  anthropicResponseToOpenai,
  mapStopReason,
  openaiToAnthropic,
} from "./adapters/anthropic-openai-translator";
import { withBedrockToolCallIds } from "./adapters/bedrock";
import {
  converseResponseToOpenai,
  createConverseToOpenaiSseEncoder,
  openaiToConverse,
} from "./adapters/bedrock-openai-translator";
import { makeGeminiOpenaiAdapterFactory } from "./adapters/gemini-openai";
import {
  createOpenaiToGeminiStreamTranslator,
  geminiToOpenai,
  openaiResponseToGemini,
  openaiToGemini,
} from "./adapters/gemini-openai-translator";
import {
  anthropicToOpenai,
  createOpenaiToAnthropicStreamTranslator,
  openaiResponseToAnthropic,
} from "./adapters/openai-anthropic-translator";
import {
  withOpenAiChatToolCallIds,
  withOpenAiResponsesToolCallIds,
} from "./utils/tool-call-ids";

/** The request formats a pool can carry a request in. */
export type PoolWire =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "bedrock-converse"
  | "gemini";

/** Sends a request in the client's shapes to one member, and answers in them. */
export interface MemberTransport {
  /** Actual provider usage when the client wire cannot represent its cache split. */
  getUsage?: () => UsageView | null;
  /** Observed usage retained even when translation cannot emit a terminal event. */
  getStreamUsage?: () => UsageView | null;
  execute(request: unknown): Promise<unknown>;
  /** `onAccepted` fires once the member's provider accepted the request. */
  executeStream(
    request: unknown,
    onAccepted?: () => void,
  ): Promise<AsyncIterable<unknown>>;
}

/** Whether a pool can send requests to a key on this provider. */
export function isPoolableProvider(provider: SupportedProvider): boolean {
  return isModelPoolProvider(provider);
}

/** The wire a request arrived in, or null when pools don't serve it. */
export function inboundPoolWire(
  interactionType: SupportedProviderDiscriminator,
): PoolWire | null {
  if (
    interactionType === "openai:responses" ||
    interactionType === "azure:responses" ||
    interactionType === "github-copilot:responses"
  )
    return "openai-responses";
  if (interactionType === "anthropic:messages") return "anthropic";
  if (interactionType === "bedrock:converse") return "bedrock-converse";
  if (interactionType === "gemini:generateContent") return "gemini";
  const [provider, surface] = interactionType.split(":");
  if (
    surface === "chatCompletions" &&
    wireOf(provider as SupportedProvider) === "openai-chat"
  ) {
    return "openai-chat";
  }
  return null;
}

/** Whether a client on `inbound` can be answered by a member on `provider`. */
export function canReachMember(
  inbound: PoolWire,
  provider: SupportedProvider,
): boolean {
  if (inbound === "openai-responses")
    return (
      provider === "openai" ||
      provider === "azure" ||
      provider === "github-copilot"
    );
  const target = wireOf(provider);
  if (!target) return false;
  return target === inbound || TRANSLATED.has(`${inbound}>${target}`);
}

/**
 * The transport for one member. `client` is built with the member provider's
 * own adapter (see `memberAdapter`).
 *
 * The client's route reads the answer with its own adapter, so an OpenAI chat
 * answer is put in that route's reasoning dialect: xAI leaves reasoning out of
 * `completion_tokens`, every other member and translator counts it inside
 * (see `reportsReasoningOutsideCompletion`). Without this an xAI member's
 * reasoning goes uncounted behind an OpenAI client and a Gemini member's is
 * counted twice behind an xAI client.
 */
export function memberTransport(params: {
  inbound: PoolWire;
  provider: SupportedProvider;
  modelId: string;
  client: unknown;
  /** The client route's dialect; absent for routes that count it inside. */
  inboundReasoningOutsideCompletion?: boolean;
}): MemberTransport {
  const transport = memberTransportOnWire(params);
  const inboundOutside = params.inboundReasoningOutsideCompletion ?? false;
  const memberOutside =
    wireOf(params.provider) === "openai-chat" &&
    reportsReasoningOutsideCompletion(params.provider);
  if (params.inbound !== "openai-chat" || inboundOutside === memberOutside) {
    return transport;
  }
  const inDialect = <T>(value: T): T => {
    const usage = (value as { usage?: OpenAi.Types.Usage | null } | null)
      ?.usage;
    return usage
      ? {
          ...value,
          usage: withReasoningOutsideCompletion(usage, inboundOutside),
        }
      : value;
  };
  return {
    ...transport,
    execute: async (request) => inDialect(await transport.execute(request)),
    executeStream: async (request, onAccepted) =>
      mapStream(
        await transport.executeStream(request, onAccepted),
        (chunk) => [inDialect(chunk)],
        () => [],
      ),
  };
}

/** `memberTransport` before the answer's usage is put in the route's dialect. */
function memberTransportOnWire(params: {
  inbound: PoolWire;
  provider: SupportedProvider;
  modelId: string;
  client: unknown;
}): MemberTransport {
  const { inbound, provider, modelId, client } = params;
  // Bedrock also serves Claude in Anthropic's own format (InvokeModel), as it
  // does for Claude Code with CLAUDE_CODE_USE_BEDROCK, so an Anthropic client
  // reaches it untranslated.
  const claudeOnBedrock =
    inbound === "anthropic" &&
    provider === "bedrock" &&
    isClaudeOnBedrock(modelId);
  const adapter = claudeOnBedrock
    ? bedrockInvokeAdapterFactory
    : memberAdapter(provider, inbound);
  const target = claudeOnBedrock
    ? "anthropic"
    : inbound === "openai-responses" && adapter
      ? "openai-responses"
      : wireOf(provider);
  if (!adapter || !target) {
    throw new Error(`Provider ${provider} cannot serve a model pool`);
  }

  if (target === inbound) {
    const withModel = (request: unknown) => {
      if (target === "openai-responses") {
        const body = request as OpenAi.Types.ResponsesRequest;
        return {
          ...body,
          model: modelId,
          input: Array.isArray(body.input)
            ? body.input.map(withOpenAiResponsesToolCallIds)
            : body.input,
        };
      }
      if (target === "bedrock-converse")
        return { ...(request as object), modelId };
      if (target === "gemini")
        return { ...(request as object), _model: modelId };
      const body = request as OpenAi.Types.ChatCompletionsRequest &
        Anthropic.Types.MessagesRequest;
      // The selected OpenAI model may require the modern output-limit field
      // even when the caller or a translator supplied the legacy one.
      const { max_tokens, ...openaiBody } = body;
      const destinationBody =
        provider === "openai"
          ? {
              ...openaiBody,
              ...(max_tokens != null && body.max_completion_tokens == null
                ? { max_completion_tokens: max_tokens }
                : {}),
            }
          : body;
      return {
        ...destinationBody,
        model: modelId,
        messages:
          target === "anthropic"
            ? withAnthropicToolCallIds(body.messages)
            : withOpenAiChatToolCallIds(body.messages),
      };
    };
    return {
      async execute(request) {
        const response = await adapter.execute(client, withModel(request));
        if (target === "openai-responses")
          assertResponsesAttemptSucceeded(response);
        return response;
      },
      async executeStream(request, onAccepted) {
        const stream = await adapter.executeStream(
          client,
          withModel(request),
          onAccepted,
        );
        return target === "openai-responses"
          ? bufferResponsesPreamble(stream)
          : stream;
      },
    };
  }

  if (inbound === "openai-chat" && target === "anthropic") {
    let getUsage: (() => UsageView | null) | undefined;
    return {
      getStreamUsage: () => getUsage?.() ?? null,
      async execute(request) {
        const { anthropicBody, openaiContext } = openaiToAnthropic(
          request as OpenAi.Types.ChatCompletionsRequest,
        );
        const response = await adapter.execute(client, {
          ...anthropicBody,
          model: modelId,
          messages: withAnthropicToolCallIds(anthropicBody.messages),
        });
        return anthropicResponseToOpenai(
          response as Anthropic.Types.MessagesResponse,
          openaiContext,
        );
      },
      async executeStream(request, onAccepted) {
        const { anthropicBody, openaiContext } = openaiToAnthropic(
          request as OpenAi.Types.ChatCompletionsRequest,
        );
        const events = await adapter.executeStream(
          client,
          {
            ...anthropicBody,
            model: modelId,
            messages: withAnthropicToolCallIds(anthropicBody.messages),
            stream: true,
          },
          onAccepted,
        );
        const translator = anthropicEventsToOpenAiChunks(openaiContext);
        getUsage = translator.getUsage;
        return mapStream(events, translator.translate, translator.finish);
      },
    };
  }

  if (inbound === "openai-chat" && target === "bedrock-converse") {
    const translate = (request: unknown) => {
      const openaiRequest = request as OpenAi.Types.ChatCompletionsRequest;
      // Model-specific options must use the selected member, not the pool alias.
      const { converseBody, openaiContext } = openaiToConverse({
        ...openaiRequest,
        model: modelId,
      });
      return {
        body: {
          ...converseBody,
          modelId,
          messages: withBedrockToolCallIds(converseBody.messages ?? []),
        } as Bedrock.Types.ConverseRequest,
        openaiContext: {
          ...openaiContext,
          requestedModel: openaiRequest.model,
          includeUsageInStream: true,
        },
      };
    };
    return {
      async execute(request) {
        const { body, openaiContext } = translate(request);
        const response = await adapter.execute(client, body);
        return converseResponseToOpenai(
          response as Bedrock.Types.ConverseResponse,
          openaiContext,
        );
      },
      async executeStream(request, onAccepted) {
        const { body, openaiContext } = translate(request);
        const events = await adapter.executeStream(client, body, onAccepted);
        const encoder = createConverseToOpenaiSseEncoder(openaiContext);
        return mapStream(
          events,
          (event) =>
            sseToChunks(
              encoder.encodeBedrockEvent(event as ConverseStreamOutput),
            ),
          () => sseToChunks(encoder.formatEnd()),
        );
      },
    };
  }

  if (inbound === "openai-chat" && target === "gemini") {
    let observedUsage: UsageView | null = null;
    const translate = (request: unknown) => {
      // Translation depends on the selected model's thinking capabilities.
      const { geminiBody, openaiContext } = openaiToGemini({
        ...(request as OpenAi.Types.ChatCompletionsRequest),
        model: modelId,
      });
      return {
        body: geminiBody,
        adapter: makeGeminiOpenaiAdapterFactory({
          ...openaiContext,
          requestedModel: (request as OpenAi.Types.ChatCompletionsRequest)
            .model,
        }),
      };
    };
    return {
      getStreamUsage: () => observedUsage,
      async execute(request) {
        const { body, adapter } = translate(request);
        const response = await adapter.execute(client, body);
        return adapter.createResponseAdapter(response).getOriginalResponse();
      },
      async executeStream(request, onAccepted) {
        const { body, adapter } = translate(request);
        observedUsage = null;
        const events = await adapter.executeStream(client, body);
        onAccepted?.();
        const stream = adapter.createStreamAdapter(body);
        return mapStream(
          events,
          (event) => {
            const result = stream.processChunk(
              event as Parameters<typeof stream.processChunk>[0],
            );
            if (stream.state.usage) {
              // Output already includes thinking, as completion tokens do.
              observedUsage = stream.state.usage;
            }
            return sseToChunks(result.sseData);
          },
          () => {
            if (!stream.state.stopReason) {
              throw new UpstreamStreamIncompleteError(
                "The upstream stream ended before it finished",
              );
            }
            return [
              ...(stream.state.toolCalls.length > 0
                ? (
                    stream.formatToolCallsSSE?.(stream.state.toolCalls) ?? []
                  ).flatMap(sseToChunks)
                : []),
              ...sseToChunks(stream.formatEndSSE()),
            ];
          },
        );
      },
    };
  }

  if (inbound === "gemini") {
    const viaOpenai = memberTransport({
      inbound: "openai-chat",
      provider,
      modelId,
      client,
    });
    let usage: UsageView | null = null;
    const observe = (raw: OpenAi.Types.ChatCompletionChunk["usage"]) => {
      if (!raw) return;
      const tokens = openAIUsageTokens(raw);
      usage = {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        cacheWrite1hTokens: tokens.cacheWrite1h,
        reasoningTokens: tokens.reasoning,
      };
    };
    return {
      getUsage: () => usage,
      getStreamUsage: viaOpenai.getStreamUsage,
      async execute(request) {
        const response = (await viaOpenai.execute(
          geminiToOpenai(request as Gemini.Types.GenerateContentRequest),
        )) as OpenAi.Types.ChatCompletionsResponse;
        observe(response.usage);
        try {
          return openaiResponseToGemini(response);
        } catch (error) {
          if (!usage) throw error;
          throw new ObservedProviderUsageError({
            original: error,
            usage,
            response: {
              error:
                error instanceof Error
                  ? error.message
                  : "Upstream response cannot be translated",
            },
          });
        }
      },
      async executeStream(request, onAccepted) {
        const chunks = await viaOpenai.executeStream(
          {
            ...geminiToOpenai(request as Gemini.Types.GenerateContentRequest),
            stream: true,
          },
          onAccepted,
        );
        const translator = createOpenaiToGeminiStreamTranslator();
        return mapStream(
          chunks,
          (raw) => {
            const chunk = raw as OpenAi.Types.ChatCompletionChunk;
            observe(chunk.usage);
            return translator.translate(chunk);
          },
          translator.finish,
        );
      },
    };
  }

  if (inbound === "anthropic") {
    // Through the OpenAI chat shape, which an OpenAI-style member speaks and
    // the Converse translator takes. Anthropic-only fields (cache_control,
    // thinking blocks) don't survive it.
    const viaOpenai = memberTransport({
      inbound: "openai-chat",
      provider,
      modelId,
      client,
    });
    return {
      getStreamUsage: viaOpenai.getStreamUsage,
      async execute(request) {
        const { openaiBody, anthropicContext } = anthropicToOpenai(
          request as Anthropic.Types.MessagesRequest,
        );
        const response = await viaOpenai.execute(openaiBody);
        return openaiResponseToAnthropic(
          response as OpenAi.Types.ChatCompletionsResponse,
          anthropicContext,
        );
      },
      async executeStream(request, onAccepted) {
        const { openaiBody, anthropicContext } = anthropicToOpenai(
          request as Anthropic.Types.MessagesRequest,
        );
        const chunks = await viaOpenai.executeStream(
          { ...openaiBody, stream: true },
          onAccepted,
        );
        const translator =
          createOpenaiToAnthropicStreamTranslator(anthropicContext);
        return mapStream(
          chunks,
          (chunk) =>
            translator.translate(chunk as OpenAi.Types.ChatCompletionChunk),
          translator.finish,
        );
      },
    };
  }

  throw new Error(`A ${inbound} request cannot reach a ${target} member`);
}

/**
 * The most output tokens a request in any pool wire lets the model write, or
 * undefined when it sets no limit (allowed on OpenAI chat and Converse).
 */
export function requestedMaxOutputTokens(request: unknown): number | undefined {
  const body = asRecord(request);
  const generation = asRecord(
    body?.generationConfig ?? body?.generation_config,
  );
  const limit =
    body?.max_output_tokens ??
    body?.max_completion_tokens ??
    body?.max_tokens ??
    asRecord(body?.inferenceConfig)?.maxTokens ??
    generation?.maxOutputTokens ??
    generation?.max_output_tokens;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? limit
    : undefined;
}

/** The adapter whose client and execute calls a member's provider uses. */
export function memberAdapter(
  provider: SupportedProvider,
  inbound?: PoolWire,
): LLMProvider<unknown, unknown, unknown, unknown, unknown> | null {
  if (!isModelPoolProvider(provider)) return null;
  const adapter =
    inbound === "openai-responses"
      ? provider === "openai"
        ? openAiResponsesAdapterFactory
        : provider === "azure"
          ? azureResponsesAdapterFactory
          : provider === "github-copilot"
            ? githubCopilotResponsesAdapterFactory
            : null
      : MEMBER_ADAPTERS[provider];
  return adapter as LLMProvider<unknown, unknown, unknown, unknown, unknown>;
}

// === Internal helpers ===

/** The adapter each provider a pool member can sit on sends requests with. */
const MEMBER_ADAPTERS: Record<ModelPoolProvider, unknown> = {
  anthropic: anthropicAdapterFactory,
  bedrock: bedrockAdapterFactory,
  openai: openaiAdapterFactory,
  azure: azureAdapterFactory,
  cerebras: cerebrasAdapterFactory,
  deepseek: deepseekAdapterFactory,
  gemini: geminiAdapterFactory,
  "github-copilot": githubCopilotAdapterFactory,
  groq: groqAdapterFactory,
  minimax: minimaxAdapterFactory,
  mistral: mistralAdapterFactory,
  ollama: ollamaAdapterFactory,
  openrouter: openrouterAdapterFactory,
  perplexity: perplexityAdapterFactory,
  vllm: vllmAdapterFactory,
  xai: xaiAdapterFactory,
  zhipuai: zhipuaiAdapterFactory,
};

/** Wire pairs a translator connects, as `inbound>member`. */
const TRANSLATED = new Set([
  "openai-chat>anthropic",
  "openai-chat>bedrock-converse",
  "openai-chat>gemini",
  "anthropic>openai-chat",
  "anthropic>bedrock-converse",
  "anthropic>gemini",
  "gemini>openai-chat",
  "gemini>anthropic",
  "gemini>bedrock-converse",
]);

function wireOf(provider: SupportedProvider): PoolWire | null {
  if (!isModelPoolProvider(provider)) return null;
  if (provider === "anthropic") return "anthropic";
  if (provider === "bedrock") return "bedrock-converse";
  if (provider === "gemini") return "gemini";
  return "openai-chat";
}

/** Only an empty, usage-free transient failure is safe to try elsewhere. */
function assertResponsesAttemptSucceeded(value: unknown): void {
  const response = asRecord(value);
  if (
    response?.status !== "failed" ||
    response.usage ||
    !Array.isArray(response.output) ||
    response.output.length > 0
  )
    return;
  const error = asRecord(response.error);
  const status =
    error?.code === "server_error"
      ? 500
      : error?.code === "rate_limit_exceeded" ||
          error?.code === "insufficient_quota"
        ? 429
        : undefined;
  if (status === undefined) return;
  throw Object.assign(
    new Error(
      typeof error?.message === "string"
        ? error.message
        : "Upstream Responses generation failed",
    ),
    { status, error },
  );
}

/**
 * A Responses HTTP 200 commonly starts with two lifecycle envelopes before
 * inference produces anything. Keep those inside the pool's first-output
 * timeout/failover boundary. Once any other event is seen, replay the original
 * envelopes and never replace that member's answer, including tool/reasoning
 * output. Retain at most one envelope of each kind while waiting.
 */
async function* bufferResponsesPreamble(source: AsyncIterable<unknown>) {
  const preamble = new Map<string, unknown>();
  let started = false;
  let terminal = false;
  for await (const chunk of source) {
    const event = asRecord(chunk);
    const response = asRecord(event?.response);
    const type = event?.type;
    if (
      !started &&
      (type === "response.created" || type === "response.in_progress") &&
      !response?.usage &&
      (!Array.isArray(response?.output) || response.output.length === 0)
    ) {
      preamble.set(type, chunk);
      continue;
    }
    if (!started && type === "response.failed")
      assertResponsesAttemptSucceeded(response);
    started = true;
    yield* preamble.values();
    preamble.clear();
    if (
      type === "response.completed" ||
      type === "response.failed" ||
      type === "response.incomplete"
    )
      terminal = true;
    yield chunk;
  }
  if (!terminal)
    throw new UpstreamStreamIncompleteError(
      "The upstream Responses stream ended before it finished",
    );
}

async function* mapStream<T>(
  source: AsyncIterable<unknown>,
  map: (item: unknown) => T[],
  end: () => T[],
): AsyncIterable<T> {
  for await (const item of source) yield* map(item);
  yield* end();
}

/** Anthropic events as OpenAI chat chunks, finish reason and usage last. */
function anthropicEventsToOpenAiChunks(ctx: {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
}): {
  translate(event: unknown): unknown[];
  finish(): unknown[];
  getUsage(): UsageView | null;
} {
  // biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK event union
  type Event = any;
  let nextToolIndex = 0;
  let toolIndexByBlock = new Map<number, number>();
  let finishReason: Anthropic.Types.MessagesResponse["stop_reason"] = null;
  let observedUsage = false;
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheWrite1h: number | undefined;
  let outputTokens = 0;
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: ctx.chatcmplId,
    object: "chat.completion.chunk",
    created: ctx.createdUnix,
    model: ctx.requestedModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return {
    getUsage: () =>
      observedUsage
        ? {
            inputTokens,
            outputTokens,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            cacheWrite1hTokens: cacheWrite1h,
          }
        : null,
    translate(raw) {
      const event = raw as Event;
      switch (event?.type) {
        case "message_start": {
          const usage = event.message?.usage ?? {};
          observedUsage ||= event.message?.usage !== undefined;
          inputTokens = usage.input_tokens ?? 0;
          cacheRead = usage.cache_read_input_tokens ?? 0;
          cacheWrite = usage.cache_creation_input_tokens ?? 0;
          cacheWrite1h =
            usage.cache_creation?.ephemeral_1h_input_tokens ?? undefined;
          outputTokens = usage.output_tokens ?? 0;
          toolIndexByBlock = new Map();
          return [chunk({ role: "assistant" }, null)];
        }
        case "content_block_start": {
          if (event.content_block?.type !== "tool_use") return [];
          const index = nextToolIndex++;
          toolIndexByBlock.set(event.index, index);
          return [
            chunk(
              {
                tool_calls: [
                  {
                    index,
                    id: event.content_block.id,
                    type: "function",
                    function: { name: event.content_block.name, arguments: "" },
                  },
                ],
              },
              null,
            ),
          ];
        }
        case "content_block_delta": {
          if (event.delta?.type === "text_delta") {
            return [chunk({ content: event.delta.text }, null)];
          }
          if (event.delta?.type === "input_json_delta") {
            const index = toolIndexByBlock.get(event.index);
            if (index === undefined) return [];
            return [
              chunk(
                {
                  tool_calls: [
                    {
                      index,
                      function: { arguments: event.delta.partial_json },
                    },
                  ],
                },
                null,
              ),
            ];
          }
          return [];
        }
        case "message_delta": {
          finishReason = event.delta?.stop_reason ?? finishReason;
          const usage = event.usage ?? {};
          observedUsage ||= event.usage !== undefined;
          outputTokens = usage.output_tokens ?? outputTokens;
          inputTokens = usage.input_tokens ?? inputTokens;
          cacheRead = usage.cache_read_input_tokens ?? cacheRead;
          cacheWrite = usage.cache_creation_input_tokens ?? cacheWrite;
          cacheWrite1h =
            usage.cache_creation?.ephemeral_1h_input_tokens ?? cacheWrite1h;
          return [];
        }
        default:
          return [];
      }
    },
    finish() {
      // Without a stop reason the stream was cut off, not finished.
      if (finishReason === null) {
        throw new UpstreamStreamIncompleteError(
          "The upstream stream ended before it finished",
        );
      }
      const prompt = inputTokens + cacheRead + cacheWrite;
      return [
        chunk({}, mapStopReason(finishReason)),
        {
          id: ctx.chatcmplId,
          object: "chat.completion.chunk",
          created: ctx.createdUnix,
          model: ctx.requestedModel,
          choices: [],
          usage: {
            prompt_tokens: prompt,
            completion_tokens: outputTokens,
            total_tokens: prompt + outputTokens,
            ...(cacheRead > 0 || cacheWrite > 0
              ? {
                  prompt_tokens_details: {
                    cached_tokens: cacheRead,
                    ...(cacheWrite > 0
                      ? { cache_write_tokens: cacheWrite }
                      : {}),
                    ...((cacheWrite1h ?? 0) > 0
                      ? { cache_write_1h_tokens: cacheWrite1h }
                      : {}),
                  },
                }
              : {}),
          },
        },
      ];
    },
  };
}

const DECODER = new TextDecoder();

/** The chunk objects in OpenAI SSE bytes; `[DONE]` carries none. */
function sseToChunks(bytes: Uint8Array | string | null): unknown[] {
  if (!bytes) return [];
  return (typeof bytes === "string" ? bytes : DECODER.decode(bytes))
    .split("\n\n")
    .map((event) => event.trim())
    .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
    .map((event) => JSON.parse(event.slice("data: ".length)));
}
