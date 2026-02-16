/**
 * Mock DeepSeek Client for Benchmarking
 *
 * Returns immediate tool call responses without making actual API calls.
 * Used for benchmarking Archestra platform overhead without network latency.
 */

import type { Deepseek } from "@/types";

/**
 * Options for controlling mock stream behavior
 */
export interface MockStreamOptions {
  /** If set, the stream will end early at this chunk index (0-based) */
  interruptAtChunk?: number;
}

const MOCK_RESPONSE: Deepseek.Types.ChatCompletionsResponse = {
  id: "chatcmpl-mock-deepseek-123",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "deepseek-chat",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_deepseek_mock789",
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

const MOCK_STREAMING_CHUNKS: Deepseek.Types.ChatCompletionChunk[] = [
  {
    id: "chatcmpl-mock-deepseek-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-deepseek-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        delta: { content: "Hello" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-deepseek-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        delta: { content: ", how can I help you?" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-deepseek-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-chat",
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
 * Mock DeepSeek Client that returns immediate tool call responses
 */
export class MockDeepseekClient {
  private static streamOptions: MockStreamOptions = {};

  /**
   * Configure stream behavior for testing (static method affects all instances)
   */
  static setStreamOptions(options: MockStreamOptions) {
    MockDeepseekClient.streamOptions = options;
  }

  /**
   * Reset stream options to default
   */
  static resetStreamOptions() {
    MockDeepseekClient.streamOptions = {};
  }

  async chatCompletions(
    _request: Deepseek.Types.ChatCompletionsRequest,
  ): Promise<Deepseek.Types.ChatCompletionsResponse> {
    return MOCK_RESPONSE;
  }

  async chatCompletionsStream(
    _request: Deepseek.Types.ChatCompletionsRequest,
  ): Promise<AsyncIterable<Deepseek.Types.ChatCompletionChunk>> {
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (
              MockDeepseekClient.streamOptions.interruptAtChunk !== undefined &&
              index === MockDeepseekClient.streamOptions.interruptAtChunk
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
