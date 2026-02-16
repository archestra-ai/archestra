/**
 * Mock Groq Client for Benchmarking
 *
 * Returns immediate tool call responses without making actual API calls.
 * Used for benchmarking Archestra platform overhead without network latency.
 */

import type { Groq } from "@/types";

/**
 * Options for controlling mock stream behavior
 */
export interface MockStreamOptions {
  /** If set, the stream will end early at this chunk index (0-based) */
  interruptAtChunk?: number;
}

const MOCK_RESPONSE: Groq.Types.ChatCompletionsResponse = {
  id: "chatcmpl-mock-groq-123",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "llama-3.3-70b-versatile",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_groq_mock789",
            type: "function",
            function: {
              name: "list_files",
              arguments: '{"path": "."}',
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
};

const MOCK_STREAMING_CHUNKS: Groq.Types.ChatCompletionChunk[] = [
  {
    id: "chatcmpl-mock-groq-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "llama-3.3-70b-versatile",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-groq-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "llama-3.3-70b-versatile",
    choices: [
      {
        index: 0,
        delta: { content: "Hello" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-groq-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "llama-3.3-70b-versatile",
    choices: [
      {
        index: 0,
        delta: { content: ", how can I help you?" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-groq-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "llama-3.3-70b-versatile",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 10,
      total_tokens: 22,
    },
  },
];

/**
 * Mock Groq Client that returns immediate tool call responses
 */
export class MockGroqClient {
  private static streamOptions: MockStreamOptions = {};

  /**
   * Configure stream behavior for testing (static method affects all instances)
   */
  static setStreamOptions(options: MockStreamOptions) {
    MockGroqClient.streamOptions = options;
  }

  /**
   * Reset stream options to default
   */
  static resetStreamOptions() {
    MockGroqClient.streamOptions = {};
  }

  async chatCompletions(
    _request: Groq.Types.ChatCompletionsRequest,
  ): Promise<Groq.Types.ChatCompletionsResponse> {
    return MOCK_RESPONSE;
  }

  async chatCompletionsStream(
    _request: Groq.Types.ChatCompletionsRequest,
  ): Promise<AsyncIterable<Groq.Types.ChatCompletionChunk>> {
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (
              MockGroqClient.streamOptions.interruptAtChunk !== undefined &&
              index === MockGroqClient.streamOptions.interruptAtChunk
            ) {
              return { done: true, value: undefined };
            }

            if (index < MOCK_STREAMING_CHUNKS.length) {
              return {
                value: MOCK_STREAMING_CHUNKS[index++],
                done: false,
              };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}
