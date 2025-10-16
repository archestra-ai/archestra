/**
 * Mock OpenAI Client for Benchmarking
 *
 * Returns immediate tool call responses without making actual API calls.
 * Used for benchmarking Archestra platform overhead without network latency.
 */

import type OpenAI from "openai";

const MOCK_RESPONSE: OpenAI.Chat.Completions.ChatCompletion = {
  id: "chatcmpl-mock123",
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
            id: "call_mock789",
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

/**
 * Mock OpenAI Client that returns immediate tool call responses
 */
export class MockOpenAIClient {
  chat = {
    completions: {
      create: async () => {
        return MOCK_RESPONSE;
      },
    },
  };
}
