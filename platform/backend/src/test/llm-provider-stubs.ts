import type Anthropic from "@anthropic-ai/sdk";
import { FinishReason, type GenerateContentResponse } from "@google/genai";
import type OpenAI from "openai";

export interface OpenAiStubOptions {
  interruptAtChunk?: number;
}

export interface AnthropicStubOptions {
  interruptAtChunk?: number;
  includeToolUse?: boolean;
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
                  tool_calls: [
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
  };
}

export function createAnthropicTestClient(options: AnthropicStubOptions = {}) {
  return {
    messages: {
      create: async () =>
        ({
          id: "msg-test-anthropic",
          type: "message",
          container: null,
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Hello! How can I help you today?",
              citations: [],
            },
          ],
          model: "claude-3-5-sonnet-20241022",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }) as unknown as Anthropic.Message,
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
    },
  };
}

function createOpenAiStream(options: OpenAiStubOptions) {
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
          input_tokens: 12,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        } as unknown as Anthropic.Messages.Usage,
      },
    },
  ];

  if (options.includeToolUse) {
    chunks.push(
      {
        type: "content_block_start",
        index: 0,
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
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"location":"',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: 'San Francisco",',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '"unit":"fahrenheit"}',
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
          text: "How can I help you today?",
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
        stop_reason: "end_turn",
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
