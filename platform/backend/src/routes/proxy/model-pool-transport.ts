/**
 * How a pooled request reaches one member.
 *
 * The proxy pipeline (guardrails, OpenAPPA, logging) runs once, on the shapes
 * of the wire the client spoke. Each member then gets a transport that takes
 * a request in those shapes and returns a response or chunk stream in those
 * shapes, whatever the member's own provider speaks: the same wire is sent
 * as is with the member's model id, and a different wire goes through a
 * translator. Members a client's wire cannot reach are left out of its plan.
 */
import {
  isModelPoolProvider,
  type ModelPoolProvider,
  type SupportedProvider,
  type SupportedProviderDiscriminator,
} from "@archestra/shared";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Anthropic, Bedrock, LLMProvider, OpenAi } from "@/types";
import {
  anthropicAdapterFactory,
  azureAdapterFactory,
  bedrockAdapterFactory,
  cerebrasAdapterFactory,
  deepseekAdapterFactory,
  groqAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
  openaiAdapterFactory,
  openrouterAdapterFactory,
  perplexityAdapterFactory,
  vllmAdapterFactory,
  xaiAdapterFactory,
  zhipuaiAdapterFactory,
} from "./adapters";
import {
  anthropicResponseToOpenai,
  openaiToAnthropic,
} from "./adapters/anthropic-openai-translator";
import {
  converseResponseToOpenai,
  createConverseToOpenaiSseEncoder,
  openaiToConverse,
} from "./adapters/bedrock-openai-translator";
import {
  anthropicToOpenai,
  createOpenaiToAnthropicStreamTranslator,
  openaiResponseToAnthropic,
} from "./adapters/openai-anthropic-translator";

/** The request formats a pool can carry a request in. */
export type PoolWire = "openai-chat" | "anthropic" | "bedrock-converse";

/** Sends a request in the client's shapes to one member, and answers in them. */
export interface MemberTransport {
  execute(request: unknown): Promise<unknown>;
  executeStream(request: unknown): Promise<AsyncIterable<unknown>>;
}

/** Whether a pool can send requests to a key on this provider. */
export function isPoolableProvider(provider: SupportedProvider): boolean {
  return isModelPoolProvider(provider);
}

/** The wire a request arrived in, or null when pools don't serve it. */
export function inboundPoolWire(
  interactionType: SupportedProviderDiscriminator,
): PoolWire | null {
  if (interactionType === "anthropic:messages") return "anthropic";
  if (interactionType === "bedrock:converse") return "bedrock-converse";
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
  const target = wireOf(provider);
  if (!target) return false;
  return target === inbound || TRANSLATED.has(`${inbound}>${target}`);
}

/**
 * The transport for one member. `client` is built with the member provider's
 * own adapter (see `memberAdapter`).
 */
export function memberTransport(params: {
  inbound: PoolWire;
  provider: SupportedProvider;
  modelId: string;
  client: unknown;
}): MemberTransport {
  const { inbound, provider, modelId, client } = params;
  const adapter = memberAdapter(provider);
  const target = wireOf(provider);
  if (!adapter || !target) {
    throw new Error(`Provider ${provider} cannot serve a model pool`);
  }

  if (target === inbound) {
    const withModel = (request: unknown) =>
      target === "bedrock-converse"
        ? { ...(request as object), modelId }
        : { ...(request as object), model: modelId };
    return {
      execute: (request) => adapter.execute(client, withModel(request)),
      executeStream: (request) =>
        adapter.executeStream(client, withModel(request)),
    };
  }

  if (inbound === "openai-chat" && target === "anthropic") {
    return {
      async execute(request) {
        const { anthropicBody, openaiContext } = openaiToAnthropic(
          request as OpenAi.Types.ChatCompletionsRequest,
        );
        const response = await adapter.execute(client, {
          ...anthropicBody,
          model: modelId,
        });
        return anthropicResponseToOpenai(
          response as Anthropic.Types.MessagesResponse,
          openaiContext,
        );
      },
      async executeStream(request) {
        const { anthropicBody, openaiContext } = openaiToAnthropic(
          request as OpenAi.Types.ChatCompletionsRequest,
        );
        const events = await adapter.executeStream(client, {
          ...anthropicBody,
          model: modelId,
          stream: true,
        });
        const translator = anthropicEventsToOpenAiChunks(openaiContext);
        return mapStream(events, translator.translate, translator.finish);
      },
    };
  }

  if (inbound === "openai-chat" && target === "bedrock-converse") {
    const translate = (request: unknown) => {
      const { converseBody, openaiContext } = openaiToConverse(
        request as OpenAi.Types.ChatCompletionsRequest,
      );
      return {
        body: { ...converseBody, modelId } as Bedrock.Types.ConverseRequest,
        openaiContext: { ...openaiContext, includeUsageInStream: true },
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
      async executeStream(request) {
        const { body, openaiContext } = translate(request);
        const events = await adapter.executeStream(client, body);
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

  if (inbound === "anthropic" && target === "openai-chat") {
    return {
      async execute(request) {
        const { openaiBody, anthropicContext } = anthropicToOpenai(
          request as Anthropic.Types.MessagesRequest,
        );
        const response = await adapter.execute(client, {
          ...openaiBody,
          model: modelId,
        });
        return openaiResponseToAnthropic(
          response as OpenAi.Types.ChatCompletionsResponse,
          anthropicContext,
        );
      },
      async executeStream(request) {
        const { openaiBody, anthropicContext } = anthropicToOpenai(
          request as Anthropic.Types.MessagesRequest,
        );
        const chunks = await adapter.executeStream(client, {
          ...openaiBody,
          model: modelId,
          stream: true,
        });
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
  const body = request as {
    max_completion_tokens?: unknown;
    max_tokens?: unknown;
    inferenceConfig?: { maxTokens?: unknown };
  } | null;
  const limit =
    body?.max_completion_tokens ??
    body?.max_tokens ??
    body?.inferenceConfig?.maxTokens;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? limit
    : undefined;
}

/** The adapter whose client and execute calls a member's provider uses. */
export function memberAdapter(
  provider: SupportedProvider,
): LLMProvider<unknown, unknown, unknown, unknown, unknown> | null {
  if (!isModelPoolProvider(provider)) return null;
  return MEMBER_ADAPTERS[provider] as LLMProvider<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >;
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
  "anthropic>openai-chat",
]);

function wireOf(provider: SupportedProvider): PoolWire | null {
  if (!isModelPoolProvider(provider)) return null;
  if (provider === "anthropic") return "anthropic";
  if (provider === "bedrock") return "bedrock-converse";
  return "openai-chat";
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
}): { translate(event: unknown): unknown[]; finish(): unknown[] } {
  // biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK event union
  type Event = any;
  let nextToolIndex = 0;
  let toolIndexByBlock = new Map<number, number>();
  let finishReason: string | null = null;
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let outputTokens = 0;
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: ctx.chatcmplId,
    object: "chat.completion.chunk",
    created: ctx.createdUnix,
    model: ctx.requestedModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return {
    translate(raw) {
      const event = raw as Event;
      switch (event?.type) {
        case "message_start": {
          const usage = event.message?.usage ?? {};
          inputTokens = usage.input_tokens ?? 0;
          cacheRead = usage.cache_read_input_tokens ?? 0;
          cacheWrite = usage.cache_creation_input_tokens ?? 0;
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
          outputTokens = usage.output_tokens ?? outputTokens;
          inputTokens = usage.input_tokens ?? inputTokens;
          cacheRead = usage.cache_read_input_tokens ?? cacheRead;
          cacheWrite = usage.cache_creation_input_tokens ?? cacheWrite;
          return [];
        }
        default:
          return [];
      }
    },
    finish() {
      // Without a stop reason the stream was cut off, not finished.
      if (finishReason === null) {
        throw new Error("The upstream stream ended before it finished");
      }
      const prompt = inputTokens + cacheRead + cacheWrite;
      return [
        chunk(
          {},
          finishReason === "max_tokens"
            ? "length"
            : finishReason === "tool_use"
              ? "tool_calls"
              : "stop",
        ),
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
            ...(cacheRead > 0
              ? { prompt_tokens_details: { cached_tokens: cacheRead } }
              : {}),
          },
        },
      ];
    },
  };
}

const DECODER = new TextDecoder();

/** The chunk objects in OpenAI SSE bytes; `[DONE]` carries none. */
function sseToChunks(bytes: Uint8Array | null): unknown[] {
  if (!bytes) return [];
  return DECODER.decode(bytes)
    .split("\n\n")
    .map((event) => event.trim())
    .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
    .map((event) => JSON.parse(event.slice("data: ".length)));
}
