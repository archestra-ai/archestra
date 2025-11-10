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
 * Mock Anthropic Client that returns immediate responses
 */
export class MockAnthropicClient {
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
  };
}
