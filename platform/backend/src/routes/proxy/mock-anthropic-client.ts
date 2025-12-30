/**
 * Mock Anthropic Client for Benchmarking
 *
 * Returns immediate responses without making actual API calls.
 * Used for benchmarking Archestra platform overhead without network latency.
 */

import type Anthropic from "@anthropic-ai/sdk";

const MOCK_RESPONSE: Anthropic.Message = {
  id: "msg-mock123",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "text",
      text: "Hello! How can I help you today?",
      citations: [],
    } as Anthropic.Messages.TextBlock,
  ],
  model: "claude-3-5-sonnet-20241022",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 12,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } as Anthropic.Messages.Usage,
};

/**
 * Options for controlling mock stream behavior
 */
export interface MockStreamOptions {
  /** If set, the stream will throw an error at this chunk index (0-based) */
  interruptAtChunk?: number;
  /** If true, include a tool_use block in the stream */
  includeToolUse?: boolean;
}

/**
 * Mock Anthropic Client that returns immediate responses
 */
export class MockAnthropicClient {
  private static streamOptions: MockStreamOptions = {};

  /**
   * Configure stream behavior for testing (static method affects all instances)
   */
  static setStreamOptions(options: MockStreamOptions) {
    MockAnthropicClient.streamOptions = options;
  }

  /**
   * Reset stream options to default
   */
  static resetStreamOptions() {
    MockAnthropicClient.streamOptions = {};
  }

  messages = {
    create: async (
      params: Anthropic.Messages.MessageCreateParams,
    ): Promise<Anthropic.Message> => {
      // Mock streaming mode
      if (params.stream) {
        // Return a mock stream
        return {
          [Symbol.asyncIterator]() {
            let index = 0;
            const chunks: Anthropic.Messages.MessageStreamEvent[] = [
              {
                type: "message_start",
                message: {
                  id: "msg-mock123",
                  type: "message",
                  role: "assistant",
                  content: [],
                  model: params.model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: 12,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  } as Anthropic.Messages.Usage,
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "text",
                  text: "",
                  citations: [],
                } as Anthropic.Messages.TextBlock,
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
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: {
                  output_tokens: 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                } as Anthropic.Messages.MessageDeltaUsage,
              },
              {
                type: "message_stop",
              },
            ];

            return {
              async next() {
                if (index < chunks.length) {
                  return {
                    value: chunks[index++],
                    done: false,
                  };
                }
                return { done: true, value: undefined };
              },
            };
          },
        } as unknown as Anthropic.Message;
      }

      // Mock regular mode
      return MOCK_RESPONSE;
    },
    stream: (params: Anthropic.Messages.MessageCreateParams) => {
      // Return the same async iterator structure
      let index = 0;
      const baseChunks: Anthropic.Messages.MessageStreamEvent[] = [
        {
          type: "message_start",
          message: {
            id: "msg-mock123",
            type: "message",
            role: "assistant",
            content: [],
            model: params.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 12,
              output_tokens: 10, // Final output tokens for completed stream
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            } as Anthropic.Messages.Usage,
          },
        },
      ];

      // Conditionally add tool_use or text content blocks
      if (MockAnthropicClient.streamOptions.includeToolUse) {
        baseChunks.push(
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_mock123",
              name: "get_weather",
              input: {}, // This empty object is what causes the bug if not handled
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
        baseChunks.push(
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: "",
              citations: [],
            } as Anthropic.Messages.TextBlock,
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

      baseChunks.push(
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          } as Anthropic.Messages.MessageDeltaUsage,
        },
        {
          type: "message_stop",
        },
      );

      const chunks = baseChunks;

      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              // Check if we should interrupt at this chunk
              // Instead of throwing, just end the stream early (simulates client disconnect)
              if (
                MockAnthropicClient.streamOptions.interruptAtChunk !==
                  undefined &&
                index === MockAnthropicClient.streamOptions.interruptAtChunk
              ) {
                return { done: true, value: undefined };
              }

              if (index < chunks.length) {
                return {
                  value: chunks[index++],
                  done: false,
                };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}
