/**
 * Mock Zhipuai Client for Benchmarking
 *
 * Returns immediate tool call responses without making actual API calls.
 * Used for benchmarking Archestra platform overhead without network latency.
 */

import type { Zhipuai } from "@/types";

/**
 * Options for controlling mock stream behavior
 */
export interface MockStreamOptions {
  /** If set, the stream will end early at this chunk index (0-based) */
  interruptAtChunk?: number;
}

const MOCK_RESPONSE: Zhipuai.Types.ChatCompletionsResponse = {
  id: "chatcmpl-mock-zhipuai-123",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "glm-4",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_zhipuai_mock789",
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

const MOCK_STREAMING_CHUNKS: Zhipuai.Types.ChatCompletionChunk[] = [
  {
    id: "chatcmpl-mock-zhipuai-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "glm-4",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-zhipuai-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "glm-4",
    choices: [
      {
        index: 0,
        delta: { content: "你好" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-zhipuai-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "glm-4",
    choices: [
      {
        index: 0,
        delta: { content: "，我能帮您什么？" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-zhipuai-123",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "glm-4",
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
 * Mock Zhipuai Client that returns immediate tool call responses
 */
export class MockZhipuaiClient {
  private static streamOptions: MockStreamOptions = {};

  /**
   * Configure stream behavior for testing (static method affects all instances)
   */
  static setStreamOptions(options: MockStreamOptions) {
    MockZhipuaiClient.streamOptions = options;
  }

  /**
   * Reset stream options to default
   */
  static resetStreamOptions() {
    MockZhipuaiClient.streamOptions = {};
  }

  async chatCompletions(
    _request: Zhipuai.Types.ChatCompletionsRequest,
  ): Promise<Zhipuai.Types.ChatCompletionsResponse> {
    // Return mock response immediately
    return MOCK_RESPONSE;
  }

  async chatCompletionsStream(
    _request: Zhipuai.Types.ChatCompletionsRequest,
  ): Promise<AsyncIterable<Zhipuai.Types.ChatCompletionChunk>> {
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            // Check if we should interrupt at this chunk
            // Instead of throwing, just end the stream early (simulates client disconnect)
            if (
              MockZhipuaiClient.streamOptions.interruptAtChunk !== undefined &&
              index === MockZhipuaiClient.streamOptions.interruptAtChunk
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
