/**
 * Mock Gemini Client for Benchmarking
 *
 * Returns immediate tool call responses without making actual API calls.
 * Used for benchmarking Archestra platform overhead without network latency.
 */

import { FinishReason, type GenerateContentResponse } from "@google/genai";

/**
 * Options for controlling mock stream behavior
 */
export interface MockStreamOptions {
  /** If set, the stream will end early at this chunk index (0-based) */
  interruptAtChunk?: number;
}

const MOCK_RESPONSE = {
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
  responseId: "gemini-mock123",
} as unknown as GenerateContentResponse;

const MOCK_STREAMING_CHUNKS = [
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
    responseId: "gemini-mock123",
  },
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
    responseId: "gemini-mock123",
  },
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
    responseId: "gemini-mock123",
  },
] as GenerateContentResponse[];

/**
 * Mock Gemini Client that returns immediate tool call responses
 */
export class MockGeminiClient {
  private static streamOptions: MockStreamOptions = {};

  /**
   * Configure stream behavior for testing (static method affects all instances)
   */
  static setStreamOptions(options: MockStreamOptions) {
    MockGeminiClient.streamOptions = options;
  }

  /**
   * Reset stream options to default
   */
  static resetStreamOptions() {
    MockGeminiClient.streamOptions = {};
  }

  models = {
    generateContent: async () => {
      return MOCK_RESPONSE;
    },

    generateContentStream: async () => {
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              // Check if we should interrupt at this chunk
              if (
                MockGeminiClient.streamOptions.interruptAtChunk !== undefined &&
                index === MockGeminiClient.streamOptions.interruptAtChunk
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
    },
  };
}
