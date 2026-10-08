import type Anthropic from "@anthropic-ai/sdk";
import { FinishReason, type GenerateContentResponse } from "@google/genai";
import type OpenAI from "openai";

export interface OpenAiStubOptions {
  interruptAtChunk?: number;
  /** Reject streaming requests with this error message before any chunk arrives (e.g. a provider 400). */
  failStreamWithError?: string;
  /**
   * Throw from the stream iterator at this chunk index, after earlier chunks have
   * already been yielded — a mid-stream failure once SSE headers and content are
   * on the wire, but before the usage-bearing final chunk arrives.
   */
  throwAtChunk?: number;
  /** Stream a `get_weather` tool call, closing the turn as `tool_calls`. */
  includeToolCalls?: boolean;
  /**
   * Return these tool calls (instead of the fixed `list_files` one) from the
   * buffered (non-streaming) response.
   */
  nonStreamingToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

export interface AnthropicStubOptions {
  interruptAtChunk?: number;
  includeToolUse?: boolean;
  /** Assistant text for a response without tool calls. */
  responseText?: string;
  /** Report `input_tokens: 0` (like z.ai's Anthropic-compatible endpoint) to exercise the input-token fallback. */
  zeroInputTokens?: boolean;
  /** Report `output_tokens: 0` to exercise the fallback's output>0 guard. */
  zeroOutputTokens?: boolean;
  /** Report this many `cache_read_input_tokens` to exercise the fallback's cache guard. */
  cacheReadInputTokens?: number;
  /** Terminal `message_delta` stop reason. A real turn carrying tool_use ends as `tool_use`. */
  streamStopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  /**
   * Stream text, then a tool_use, then more text. Withholding the middle block
   * is what exposes whether the indices the client receives stay contiguous.
   */
  toolUseBetweenText?: boolean;
  /**
   * Return a tool_use block from the buffered (non-streaming) response. Separate
   * from `includeToolUse`, which existing tests set while making buffered calls
   * that expect text.
   */
  includeToolUseNonStreaming?: boolean;
  /**
   * Emit this tool_use block (instead of the fixed `get_weather` one) from the
   * buffered (non-streaming) response, e.g. a gateway `run_tool` dispatch with
   * a client-decorated name. Implies a `tool_use` stop reason.
   */
  nonStreamingToolUse?: {
    name: string;
    input: Record<string, unknown>;
    /** The call id; `toolu_test_weather` when absent. */
    id?: string;
  };
  /** Emit this tool call through the streamed input-json deltas. */
  streamingToolUse?: {
    name: string;
    input: Record<string, unknown>;
    /** The call id; `toolu_test_weather` when absent. */
    id?: string;
  };
}

export interface GeminiStubOptions {
  interruptAtChunk?: number;
}

export function createOpenAiTestClient(options: OpenAiStubOptions = {}) {
  return {
    chat: {
      completions: {
        create: async (
          params: OpenAI.Chat.Completions.ChatCompletionCreateParams,
        ) => {
          if (params.stream) {
            if (options.failStreamWithError) {
              throw new Error(options.failStreamWithError);
            }
            return createOpenAiStream(options);
          }

          return {
            id: "chatcmpl-test-openai",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  refusal: null,
                  tool_calls: options.nonStreamingToolCalls?.map(
                    ({ id, name, arguments: args }) => ({
                      id,
                      type: "function" as const,
                      function: { name, arguments: args },
                    }),
                  ) ?? [
                    {
                      id: "call_list_files",
                      type: "function",
                      function: {
                        name: "list_files",
                        arguments: '{"path":"."}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 82,
              completion_tokens: 17,
              total_tokens: 99,
            },
          } satisfies OpenAI.Chat.Completions.ChatCompletion;
        },
      },
    },
    embeddings: {
      create: async (params: OpenAI.Embeddings.EmbeddingCreateParams) => {
        const inputs = Array.isArray(params.input)
          ? params.input
          : [params.input];

        return {
          object: "list",
          data: inputs.map((_input, index) => ({
            object: "embedding",
            embedding: [0.1, 0.2, 0.3],
            index,
          })),
          model: params.model,
          usage: {
            prompt_tokens: inputs.length,
            total_tokens: inputs.length,
          },
        } satisfies OpenAI.Embeddings.CreateEmbeddingResponse;
      },
    },
  };
}

export function createAnthropicTestClient(options: AnthropicStubOptions = {}) {
  return {
    messages: {
      // Typed as the plain async form tests wrap; the streaming result also
      // carries the SDK's `asResponse()` at runtime.
      create: ((params: Anthropic.Messages.MessageCreateParams) => {
        if (params.stream) {
          return anthropicStreamPromise(createAnthropicStream(options));
        }

        return Promise.resolve({
          id: "msg-test-anthropic",
          type: "message",
          container: null,
          role: "assistant",
          content:
            options.includeToolUseNonStreaming || options.nonStreamingToolUse
              ? [
                  {
                    type: "text",
                    text: "Checking the weather.",
                    citations: [],
                  },
                  {
                    type: "tool_use",
                    id: options.nonStreamingToolUse?.id ?? "toolu_test_weather",
                    name: options.nonStreamingToolUse?.name ?? "get_weather",
                    input: options.nonStreamingToolUse?.input ?? {
                      location: "SF",
                    },
                  },
                ]
              : [
                  {
                    type: "text",
                    text:
                      options.responseText ??
                      "Hello! How can I help you today?",
                    citations: [],
                  },
                ],
          model: "claude-3-5-sonnet-20241022",
          stop_reason:
            options.includeToolUseNonStreaming || options.nonStreamingToolUse
              ? "tool_use"
              : "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: options.zeroInputTokens ? 0 : 12,
            output_tokens: options.zeroOutputTokens ? 0 : 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: options.cacheReadInputTokens ?? 0,
          },
        } as unknown as Anthropic.Message);
      }) as (
        params: Anthropic.Messages.MessageCreateParams,
      ) => Promise<
        ReturnType<typeof createAnthropicStream> | Anthropic.Message
      >,
      stream: () => createAnthropicStream(options),
    },
  };
}

export function createGeminiTestClient(options: GeminiStubOptions = {}) {
  return {
    models: {
      generateContent: async () =>
        ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "list_files",
                      args: { path: "." },
                    },
                  },
                ],
              },
              finishReason: FinishReason.STOP,
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 82,
            candidatesTokenCount: 17,
            totalTokenCount: 99,
          },
          modelVersion: "gemini-2.5-pro",
          responseId: "gemini-test",
        }) as unknown as GenerateContentResponse,
      generateContentStream: async () => createGeminiStream(options),
      embedContent: async (params: { contents: unknown }) => {
        const contents = Array.isArray(params.contents)
          ? params.contents
          : [params.contents];
        return {
          embeddings: contents.map(() => ({ values: [0.1, 0.2, 0.3] })),
        };
      },
    },
  };
}

/** Same iteration semantics (throwAtChunk / interruptAtChunk) over any chunk list. */
function openAiStreamOver(
  chunks: OpenAI.Chat.Completions.ChatCompletionChunk[],
  options: OpenAiStubOptions,
) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (
            options.throwAtChunk !== undefined &&
            index === options.throwAtChunk
          ) {
            throw new Error("Simulated OpenAI stream failure before usage");
          }
          if (
            options.interruptAtChunk !== undefined &&
            index === options.interruptAtChunk
          ) {
            return { done: true, value: undefined };
          }
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createOpenAiStream(options: OpenAiStubOptions) {
  if (options.includeToolCalls) {
    return openAiStreamOver(
      [
        {
          id: "chatcmpl-test-openai",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_test_weather",
                    type: "function",
                    function: { name: "get_weather", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        {
          id: "chatcmpl-test-openai",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"location":"SF"}' },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        {
          id: "chatcmpl-test-openai",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
        },
      ] as OpenAI.Chat.Completions.ChatCompletionChunk[],
      options,
    );
  }

  const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [
    {
      id: "chatcmpl-test-openai",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    {
      id: "chatcmpl-test-openai",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { content: "How can" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    {
      id: "chatcmpl-test-openai",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { content: " I help you?" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    {
      id: "chatcmpl-test-openai",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 10,
        total_tokens: 22,
      },
    },
  ];

  return {
    [Symbol.asyncIterator]() {
      let index = 0;

      return {
        async next() {
          if (
            options.throwAtChunk !== undefined &&
            index === options.throwAtChunk
          ) {
            throw new Error("Simulated OpenAI stream failure before usage");
          }

          if (
            options.interruptAtChunk !== undefined &&
            index === options.interruptAtChunk
          ) {
            return { done: true, value: undefined };
          }

          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }

          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createAnthropicStream(options: AnthropicStubOptions) {
  const streamingArguments = options.streamingToolUse
    ? JSON.stringify(options.streamingToolUse.input)
    : undefined;
  const chunks: Anthropic.Messages.MessageStreamEvent[] = [
    {
      type: "message_start",
      message: {
        id: "msg-test-anthropic",
        type: "message",
        container: null,
        role: "assistant",
        content: [],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: options.zeroInputTokens ? 0 : 12,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        } as unknown as Anthropic.Messages.Usage,
      },
    },
  ];

  if (options.toolUseBetweenText) {
    chunks.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: [] },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me check." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_test_weather",
          caller: { type: "direct" },
          name: "get_weather",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"location":"SF"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "", citations: [] },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "Then I will summarise." },
      },
      { type: "content_block_stop", index: 2 },
    );
  } else if (options.includeToolUse) {
    chunks.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: options.streamingToolUse?.id ?? "toolu_test_weather",
          caller: { type: "direct" },
          name: options.streamingToolUse?.name ?? "get_weather",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: streamingArguments?.slice(0, 10) ?? '{"location":"',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: streamingArguments?.slice(10, 20) ?? 'San Francisco",',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: streamingArguments?.slice(20) ?? '"unit":"fahrenheit"}',
        },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
    );
  } else {
    chunks.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
          citations: [],
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello! " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: options.responseText ?? "How can I help you today?",
        },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
    );
  }

  chunks.push(
    {
      type: "message_delta",
      delta: {
        container: null,
        stop_reason: options.streamStopReason ?? "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as unknown as Anthropic.Messages.MessageDeltaUsage,
    },
    {
      type: "message_stop",
    },
  );

  return {
    [Symbol.asyncIterator]() {
      let index = 0;

      return {
        async next() {
          if (
            options.interruptAtChunk !== undefined &&
            index === options.interruptAtChunk
          ) {
            return { done: true, value: undefined };
          }

          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }

          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createGeminiStream(options: GeminiStubOptions) {
  const chunks = [
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "How can" }],
          },
          finishReason: undefined,
          index: 0,
        },
      ],
      modelVersion: "gemini-2.5-pro",
      responseId: "gemini-test",
    } as unknown as GenerateContentResponse,
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: " I help you?" }],
          },
          finishReason: undefined,
          index: 0,
        },
      ],
      modelVersion: "gemini-2.5-pro",
      responseId: "gemini-test",
    } as unknown as GenerateContentResponse,
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [],
          },
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 10,
        totalTokenCount: 22,
      },
      modelVersion: "gemini-2.5-pro",
      responseId: "gemini-test",
    } as unknown as GenerateContentResponse,
  ];

  return {
    [Symbol.asyncIterator]() {
      let index = 0;

      return {
        async next() {
          if (
            options.interruptAtChunk !== undefined &&
            index === options.interruptAtChunk
          ) {
            return { done: true, value: undefined };
          }

          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }

          return { done: true, value: undefined };
        },
      };
    },
  };
}

/**
 * A streaming `messages.create()` result shaped like the SDK's: awaitable as
 * the event iterable, or read as the raw SSE `Response` through
 * `asResponse()`, which is what the proxy consumes.
 */
export function anthropicStreamPromise(
  events: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
) {
  const promise = Promise.resolve(events);
  return Object.assign(promise, {
    asResponse: async () => anthropicSseResponse(await promise),
  });
}

function anthropicSseResponse(events: AsyncIterable<unknown>): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const event = next.value as { type?: string };
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}
