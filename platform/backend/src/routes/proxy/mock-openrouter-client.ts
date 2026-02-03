/**
 * Mock OpenRouter Client for Benchmarking
 *
 * Returns immediate tool call responses without making actual API calls.
 * Used for benchmarking Archestra platform overhead without network latency.
 */

import type { Openrouter } from "@/types";

/**
 * Options for controlling mock stream behavior
 */
export interface MockStreamOptions {
  /** If set, the stream will end early at this chunk index (0-based) */
  interruptAtChunk?: number;
}

const MOCK_RESPONSE: Openrouter.Types.ChatCompletionsResponse = {
  id: "chatcmpl-mock-openrouter-123",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "openai/gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_openrouter_mock789",
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

const MOCK_STREAM_CHUNKS: Openrouter.Types.ChatCompletionChunk[] = [
  {
    id: "chatcmpl-mock-openrouter-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_openrouter_mock_stream",
              type: "function",
              function: {
                name: "list_files",
                arguments: "",
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-openrouter-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: '{"path": "."}',
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-mock-openrouter-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 82,
      completion_tokens: 17,
      total_tokens: 99,
    },
  },
];

export class MockOpenrouterClient {
  private streamOptions: MockStreamOptions = {};

  async chatCompletions(
    _request: Openrouter.Types.ChatCompletionsRequest,
  ): Promise<Openrouter.Types.ChatCompletionsResponse> {
    return {
      ...MOCK_RESPONSE,
      created: Math.floor(Date.now() / 1000),
    };
  }

  async *chatCompletionsStream(
    _request: Openrouter.Types.ChatCompletionsRequest,
  ): AsyncIterable<Openrouter.Types.ChatCompletionChunk> {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < MOCK_STREAM_CHUNKS.length; i++) {
      if (
        this.streamOptions.interruptAtChunk !== undefined &&
        i >= this.streamOptions.interruptAtChunk
      ) {
        break;
      }
      yield {
        ...MOCK_STREAM_CHUNKS[i],
        created: now,
      };
    }
  }

  setStreamOptions(options: MockStreamOptions): void {
    this.streamOptions = options;
  }
}
