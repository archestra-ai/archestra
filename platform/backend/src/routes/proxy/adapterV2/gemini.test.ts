import { FinishReason, type GenerateContentResponse } from "@google/genai";
import config from "@/config";
import { describe, expect, test } from "@/test";
import type { Gemini } from "@/types";
import { type GeminiRequestWithModel, geminiAdapterFactory } from "./gemini";

type GeminiStreamChunk = GenerateContentResponse;

function createMockResponse(
  parts: Gemini.Types.MessagePart[],
  usage?: Partial<Gemini.Types.UsageMetadata>,
): Gemini.Types.GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts,
        },
        finishReason: parts.some((p) => "functionCall" in p) ? "STOP" : "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: usage?.promptTokenCount ?? 100,
      candidatesTokenCount: usage?.candidatesTokenCount ?? 50,
      totalTokenCount:
        (usage?.promptTokenCount ?? 100) + (usage?.candidatesTokenCount ?? 50),
    },
    modelVersion: "gemini-2.5-pro",
    responseId: "gemini-test-response",
  };
}

function createMockRequest(
  contents: Gemini.Types.GenerateContentRequest["contents"],
  options?: Partial<GeminiRequestWithModel>,
): GeminiRequestWithModel {
  return {
    contents,
    _model: "gemini-2.5-pro",
    _isStreaming: false,
    ...options,
  };
}

describe("GeminiResponseAdapter", () => {
  describe("getToolCalls", () => {
    test("converts function calls to common format", () => {
      const response = createMockResponse([
        {
          functionCall: {
            name: "test_tool",
            id: "call_123",
            args: { param1: "value1", param2: 42 },
          },
        },
      ]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test_tool");
      expect(result[0].id).toBe("call_123");
      expect(result[0].arguments).toEqual({ param1: "value1", param2: 42 });
    });

    test("handles multiple function calls", () => {
      const response = createMockResponse([
        {
          functionCall: {
            name: "tool_one",
            id: "call_1",
            args: { param: "value1" },
          },
        },
        {
          functionCall: {
            name: "tool_two",
            id: "call_2",
            args: { param: "value2" },
          },
        },
      ]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("tool_one");
      expect(result[1].name).toBe("tool_two");
    });

    test("generates tool call id when not present", () => {
      const response = createMockResponse([
        {
          functionCall: {
            name: "test_tool",
            args: { param: "value" },
          },
        },
      ]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result[0].id).toMatch(/^gemini-call-test_tool-\d+$/);
    });

    test("handles empty arguments", () => {
      const response = createMockResponse([
        {
          functionCall: {
            name: "empty_tool",
            id: "call_empty",
          },
        },
      ]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result[0].arguments).toEqual({});
    });
  });

  describe("getText", () => {
    test("extracts text content from response", () => {
      const response = createMockResponse([{ text: "Hello, world!" }]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("Hello, world!");
    });

    test("concatenates multiple text parts", () => {
      const response = createMockResponse([
        { text: "Hello, " },
        { text: "world!" },
      ]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("Hello, world!");
    });

    test("returns empty string when no text parts", () => {
      const response = createMockResponse([
        {
          functionCall: {
            name: "tool",
            args: {},
          },
        },
      ]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("");
    });
  });

  describe("getUsage", () => {
    test("extracts usage tokens from response", () => {
      const response = createMockResponse([{ text: "Test" }], {
        promptTokenCount: 150,
        candidatesTokenCount: 75,
      });

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      const usage = adapter.getUsage();

      expect(usage).toEqual({
        inputTokens: 150,
        outputTokens: 75,
      });
    });
  });

  describe("toRefusalResponse", () => {
    test("creates refusal response with provided message", () => {
      const response = createMockResponse([{ text: "Original content" }]);

      const adapter = geminiAdapterFactory.createResponseAdapter(response);
      const refusal = adapter.toRefusalResponse(
        "Full refusal",
        "Tool call blocked by policy",
      );

      expect(refusal.candidates?.[0]?.content?.parts?.[0]).toEqual({
        text: "Tool call blocked by policy",
      });
      expect(refusal.candidates?.[0]?.finishReason).toBe("STOP");
    });
  });
});

describe("GeminiRequestAdapter", () => {
  describe("getModel", () => {
    test("returns original model by default", () => {
      const request = createMockRequest(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        { _model: "gemini-2.5-flash" },
      );

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      expect(adapter.getModel()).toBe("gemini-2.5-flash");
    });

    test("returns modified model after setModel", () => {
      const request = createMockRequest(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        { _model: "gemini-2.5-pro" },
      );

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      adapter.setModel("gemini-2.5-flash");
      expect(adapter.getModel()).toBe("gemini-2.5-flash");
    });
  });

  describe("isStreaming", () => {
    test("returns true when _isStreaming is true", () => {
      const request = createMockRequest(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        { _isStreaming: true },
      );

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      expect(adapter.isStreaming()).toBe(true);
    });

    test("returns false when _isStreaming is false", () => {
      const request = createMockRequest(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        { _isStreaming: false },
      );

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      expect(adapter.isStreaming()).toBe(false);
    });

    test("returns false when _isStreaming is undefined", () => {
      const request = createMockRequest([
        { role: "user", parts: [{ text: "Hello" }] },
      ]);

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      expect(adapter.isStreaming()).toBe(false);
    });
  });

  describe("getTools", () => {
    test("extracts function declarations from request", () => {
      const request = createMockRequest(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_weather",
                  description: "Get weather for a location",
                  parameters: {
                    type: "object",
                    properties: {
                      location: { type: "string" },
                    },
                  },
                },
              ],
            },
          ],
        },
      );

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      const tools = adapter.getTools();

      expect(tools).toEqual([
        {
          name: "get_weather",
          description: "Get weather for a location",
          inputSchema: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
          },
        },
      ]);
    });

    test("returns empty array when no tools", () => {
      const request = createMockRequest([
        { role: "user", parts: [{ text: "Hello" }] },
      ]);

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      expect(adapter.getTools()).toEqual([]);
    });
  });

  describe("getMessages", () => {
    test("converts function responses to common format", () => {
      const request = createMockRequest([
        { role: "user", parts: [{ text: "Get the weather" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "get_weather",
                id: "call_123",
                args: { location: "NYC" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "get_weather",
                id: "call_123",
                response: { temperature: 72, unit: "fahrenheit" },
              },
            },
          ],
        },
      ]);

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      const messages = adapter.getMessages();

      expect(messages).toHaveLength(3);
      expect(messages[2].toolCalls).toEqual([
        {
          id: "call_123",
          name: "get_weather",
          content: { temperature: 72, unit: "fahrenheit" },
          isError: false,
        },
      ]);
    });
  });

  describe("toProviderRequest", () => {
    test("applies model change to request", () => {
      const request = createMockRequest(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        { _model: "gemini-2.5-pro" },
      );

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      adapter.setModel("gemini-2.5-flash");
      const result = adapter.toProviderRequest();

      expect(result._model).toBe("gemini-2.5-flash");
    });

    test("applies tool result updates to request", () => {
      const request = createMockRequest([
        { role: "user", parts: [{ text: "Get the weather" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "get_weather",
                id: "call_123",
                args: { location: "NYC" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "get_weather",
                id: "call_123",
                response: { temperature: 72 },
              },
            },
          ],
        },
      ]);

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      adapter.updateToolResult(
        "call_123",
        '{"temperature": 75, "updated": true}',
      );
      const result = adapter.toProviderRequest();

      const userContent = result.contents?.find(
        (c) =>
          c.role === "user" && c.parts?.some((p) => "functionResponse" in p),
      );
      const functionResponsePart = userContent?.parts?.find(
        (p) => "functionResponse" in p,
      );
      expect(
        (functionResponsePart as { functionResponse: { response: unknown } })
          ?.functionResponse?.response,
      ).toEqual({
        sanitizedContent: '{"temperature": 75, "updated": true}',
      });
    });

    test("converts MCP image blocks in tool results", () => {
      const originalBrowserStreaming = config.features.browserStreamingEnabled;
      config.features.browserStreamingEnabled = true;
      try {
        const mcpImageResponse = [
          { type: "text", text: "Screenshot captured" },
          {
            type: "image",
            data: "abc123",
            mimeType: "image/png",
          },
        ] as unknown as Record<string, unknown>;

        const request = createMockRequest([
          { role: "user", parts: [{ text: "Capture a screenshot" }] },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "browser_take_screenshot",
                  id: "call_123",
                  args: {},
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "browser_take_screenshot",
                  id: "call_123",
                  response: mcpImageResponse,
                },
              },
            ],
          },
        ]);

        const adapter = geminiAdapterFactory.createRequestAdapter(request);
        const result = adapter.toProviderRequest();

        const userContent = result.contents?.find(
          (content) =>
            content.role === "user" &&
            content.parts?.some((part) => "functionResponse" in part),
        );
        const functionResponsePart = userContent?.parts?.find(
          (part) => "functionResponse" in part,
        );
        expect(
          (functionResponsePart as { functionResponse: { response: unknown } })
            ?.functionResponse?.response,
        ).toEqual({
          text: "Screenshot captured",
          images: [
            {
              inlineData: {
                mimeType: "image/png",
                data: "abc123",
              },
            },
          ],
        });
      } finally {
        config.features.browserStreamingEnabled = originalBrowserStreaming;
      }
    });

    test("strips oversized MCP image blocks in tool results", () => {
      const originalBrowserStreaming = config.features.browserStreamingEnabled;
      config.features.browserStreamingEnabled = true;
      try {
        const largeImageData = "a".repeat(140000);
        const mcpImageResponse = [
          { type: "text", text: "Screenshot captured" },
          {
            type: "image",
            data: largeImageData,
            mimeType: "image/png",
          },
        ] as unknown as Record<string, unknown>;

        const request = createMockRequest([
          { role: "user", parts: [{ text: "Capture a screenshot" }] },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "browser_take_screenshot",
                  id: "call_123",
                  args: {},
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "browser_take_screenshot",
                  id: "call_123",
                  response: mcpImageResponse,
                },
              },
            ],
          },
        ]);

        const adapter = geminiAdapterFactory.createRequestAdapter(request);
        const result = adapter.toProviderRequest();

        const userContent = result.contents?.find(
          (content) =>
            content.role === "user" &&
            content.parts?.some((part) => "functionResponse" in part),
        );
        const functionResponsePart = userContent?.parts?.find(
          (part) => "functionResponse" in part,
        );
        expect(
          (functionResponsePart as { functionResponse: { response: unknown } })
            ?.functionResponse?.response,
        ).toEqual({
          text: "Screenshot captured\n[Image omitted due to size]",
        });
      } finally {
        config.features.browserStreamingEnabled = originalBrowserStreaming;
      }
    });
  });
});

describe("geminiAdapterFactory", () => {
  describe("extractApiKey", () => {
    test("returns x-goog-api-key header", () => {
      const headers = { "x-goog-api-key": "test-api-key-123" };
      const apiKey = geminiAdapterFactory.extractApiKey(headers);
      expect(apiKey).toBe("test-api-key-123");
    });

    test("returns undefined when no api key header", () => {
      const headers = {} as Gemini.Types.GenerateContentHeaders;
      const apiKey = geminiAdapterFactory.extractApiKey(headers);
      expect(apiKey).toBeUndefined();
    });
  });

  describe("provider info", () => {
    test("has correct provider name", () => {
      expect(geminiAdapterFactory.provider).toBe("gemini");
    });

    test("has correct interaction type", () => {
      expect(geminiAdapterFactory.interactionType).toBe(
        "gemini:generateContent",
      );
    });
  });
});

describe("GeminiStreamAdapter", () => {
  describe("processChunk", () => {
    test("processes text chunks correctly", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      const chunk = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Hello, world!" }],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as GeminiStreamChunk;

      const result = adapter.processChunk(chunk);

      expect(result.isToolCallChunk).toBe(false);
      expect(adapter.state.text).toBe("Hello, world!");
    });

    test("processes function call chunks correctly", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      const chunk = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "test_tool",
                    id: "call_123",
                    args: { param: "value" },
                  },
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as unknown as GeminiStreamChunk;

      const result = adapter.processChunk(chunk);

      expect(result.isToolCallChunk).toBe(true);
      expect(adapter.state.toolCalls).toHaveLength(1);
      expect(adapter.state.toolCalls[0].name).toBe("test_tool");
    });

    test("updates usage metadata", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      const chunk = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Final" }],
            },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
        },
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as GeminiStreamChunk;

      adapter.processChunk(chunk);

      expect(adapter.state.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    test("processes inline data (image) chunks correctly", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      const chunk = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                  },
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-flash-preview-native-audio-dialog",
        responseId: "test-image-response",
      } as unknown as GeminiStreamChunk;

      const result = adapter.processChunk(chunk);

      // Should return SSE data for the image chunk
      expect(result.sseData).toBeTruthy();
      expect(result.isToolCallChunk).toBe(false);

      // Should store inline data for reconstruction
      const response = adapter.toProviderResponse();
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      expect(parts.some((p) => "inlineData" in p)).toBe(true);
    });

    test("processes mixed text and inline data chunks", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      // First chunk with text
      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Here is the generated image:" }],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-flash-preview-native-audio-dialog",
        responseId: "test-mixed-response",
      } as GeminiStreamChunk);

      // Second chunk with image
      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "imageBase64Data",
                  },
                },
              ],
            },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-flash-preview-native-audio-dialog",
        responseId: "test-mixed-response",
      } as unknown as GeminiStreamChunk);

      const response = adapter.toProviderResponse();
      const parts = response.candidates?.[0]?.content?.parts ?? [];

      // Should have both text and inline data parts
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ text: "Here is the generated image:" });
      expect(parts[1]).toHaveProperty("inlineData");
      expect(
        (parts[1] as { inlineData: { mimeType: string } }).inlineData.mimeType,
      ).toBe("image/png");
    });
  });

  describe("formatEndSSE", () => {
    test("returns correct end marker", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();
      expect(adapter.formatEndSSE()).toBe("data: [DONE]\n\n");
    });
  });

  describe("toProviderResponse", () => {
    test("reconstructs complete response from accumulated state", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      // Simulate processing chunks
      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Hello" }],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as GeminiStreamChunk);

      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: ", world!" }],
            },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as GeminiStreamChunk);

      const response = adapter.toProviderResponse();

      expect(response.candidates?.[0]?.content?.parts?.[0]).toEqual({
        text: "Hello, world!",
      });
      expect(response.usageMetadata?.promptTokenCount).toBe(10);
      expect(response.usageMetadata?.candidatesTokenCount).toBe(5);
    });
  });
});
