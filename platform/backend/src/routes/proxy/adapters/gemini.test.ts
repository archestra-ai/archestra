import { FinishReason, type GenerateContentResponse } from "@google/genai";
import { onTestFinished, vi } from "vitest";
import { describe, expect, test } from "@/test";
import type { Gemini } from "@/types";
import {
  type GeminiRequestWithModel,
  geminiAdapterFactory,
  restToSdkGenerateContentParams,
} from "./gemini";
import { GeminiToolNameCodec } from "./gemini-tool-names";

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
      ...(usage?.cachedContentTokenCount !== undefined
        ? { cachedContentTokenCount: usage.cachedContentTokenCount }
        : {}),
      ...(usage?.thoughtsTokenCount !== undefined
        ? { thoughtsTokenCount: usage.thoughtsTokenCount }
        : {}),
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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
    });

    test("subtracts cachedContentTokenCount from prompt to avoid double-counting", () => {
      const response = createMockResponse([{ text: "Test" }], {
        promptTokenCount: 150,
        candidatesTokenCount: 75,
        cachedContentTokenCount: 120,
      });

      const adapter = geminiAdapterFactory.createResponseAdapter(response);

      // Gemini's cachedContentTokenCount is a SUBSET of promptTokenCount, so
      // uncached input = 150 - 120 = 30 (no double-count of the cached 120).
      expect(adapter.getUsage()).toEqual({
        inputTokens: 30,
        outputTokens: 75,
        cacheReadTokens: 120,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
    });

    test("extracts thoughtsTokenCount as reasoning tokens", () => {
      const response = createMockResponse([{ text: "Test" }], {
        promptTokenCount: 150,
        candidatesTokenCount: 75,
        thoughtsTokenCount: 60,
      });

      const adapter = geminiAdapterFactory.createResponseAdapter(response);

      expect(adapter.getUsage().reasoningTokens).toBe(60);
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

describe("Gemini createClient", () => {
  test("uses the custom base URL override", () => {
    const customBaseUrl = "https://example.test";
    const client = geminiAdapterFactory.createClient("my-gemini-key", {
      baseUrl: customBaseUrl,
      source: "api",
    }) as unknown as {
      httpOptions?: { baseUrl?: string };
    };

    expect(client.httpOptions?.baseUrl).toBe(customBaseUrl);
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
          arguments: { location: "NYC" },
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
    });

    test("strips oversized MCP image blocks in tool results", () => {
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
    });

    test("filters out content entries with empty parts", () => {
      const request = createMockRequest([
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [] },
        { role: "user", parts: [] },
        { role: "model", parts: [{ text: "Response" }] },
      ]);

      const adapter = geminiAdapterFactory.createRequestAdapter(request);
      const result = adapter.toProviderRequest();

      expect(result.contents).toHaveLength(2);
      expect(result.contents?.[0]).toEqual({
        role: "user",
        parts: [{ text: "Hello" }],
      });
      expect(result.contents?.[1]).toEqual({
        role: "model",
        parts: [{ text: "Response" }],
      });
    });
  });
});

describe("geminiAdapterFactory", () => {
  test("uses provider-compatible tool names and restores client names", async () => {
    const clientToolName = "1 report/tool";
    let providerToolName = "";
    let providerParams: Record<string, unknown> = {};
    const client = {
      models: {
        generateContent: vi.fn(async (params: Record<string, unknown>) => {
          providerParams = params;
          const config = params.config as {
            tools: Array<{
              functionDeclarations: Array<{ name: string }>;
            }>;
          };
          providerToolName = config.tools[0].functionDeclarations[0].name;
          return createMockResponse([
            {
              functionCall: {
                name: providerToolName,
                id: "call_123",
                args: { reportId: "weekly" },
              },
            },
          ]) as unknown as GenerateContentResponse;
        }),
      },
    };
    const request = createMockRequest(
      [
        { role: "user", parts: [{ text: "Create the report" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: clientToolName,
                id: "call_previous",
                args: { reportId: "daily" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: clientToolName,
                id: "call_previous",
                response: { status: "complete" },
              },
            },
          ],
        },
      ],
      {
        tools: [
          {
            functionDeclarations: [
              {
                name: clientToolName,
                description: "Create a report",
                parameters: { type: "object" },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [clientToolName],
          },
        },
      },
    );

    const response = await geminiAdapterFactory.execute(client, request);
    const toolCalls = geminiAdapterFactory
      .createResponseAdapter(response)
      .getToolCalls();

    expect(providerToolName).toMatch(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
    expect(providerToolName).not.toBe(clientToolName);
    const providerContents = providerParams.contents as Array<{
      parts: Array<{
        functionCall?: { name: string };
        functionResponse?: { name: string };
      }>;
    }>;
    expect(providerContents[1].parts[0].functionCall?.name).toBe(
      providerToolName,
    );
    expect(providerContents[2].parts[0].functionResponse?.name).toBe(
      providerToolName,
    );
    const providerConfig = providerParams.config as {
      toolConfig: {
        functionCallingConfig: { allowedFunctionNames: string[] };
      };
    };
    expect(
      providerConfig.toolConfig.functionCallingConfig.allowedFunctionNames,
    ).toEqual([providerToolName]);
    expect(toolCalls[0].name).toBe(clientToolName);
  });

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
  // The model's text streamed live and the refusal was appended after it, so
  // the record has to carry both. Reporting the refusal alone erased the
  // model's own answer — the loss that makes a refused turn unreadable after
  // the fact. The withheld function call stays withheld: it never reached the
  // client, and recording it would leave a turn owing a response nothing sends.
  describe("policy refusal", () => {
    test("toProviderResponse keeps streamed text, drops the withheld call, appends the refusal", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();
      adapter.processChunk({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "let me check" }] },
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
              parts: [
                {
                  functionCall: {
                    name: "test_tool",
                    id: "call_123",
                    args: {},
                  },
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as unknown as GeminiStreamChunk);

      adapter.formatCompleteTextSSE("blocked message");
      const response = adapter.toProviderResponse();

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      expect(
        parts.map((part) => ("text" in part ? part.text : undefined)),
      ).toEqual(["let me check", "blocked message"]);
      expect(parts.some((part) => "functionCall" in part)).toBe(false);
      expect(response.candidates?.[0]?.finishReason).toBe("STOP");
    });
  });

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

    test("restores client tool names in streamed calls", () => {
      const clientToolName = "1 report/tool";
      const request = createMockRequest(
        [{ role: "user", parts: [{ text: "Create the report" }] }],
        {
          tools: [
            {
              functionDeclarations: [
                {
                  name: clientToolName,
                  description: "Create a report",
                  parameters: { type: "object" },
                },
              ],
            },
          ],
        },
      );
      const providerRequest = new GeminiToolNameCodec(request).encodeRequest(
        request,
      );
      const providerTools = Array.isArray(providerRequest.tools)
        ? providerRequest.tools
        : [providerRequest.tools];
      const providerToolName =
        providerTools[0]?.functionDeclarations?.[0]?.name ?? "";
      const adapter = geminiAdapterFactory.createStreamAdapter(request);

      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: providerToolName,
                    id: "call_123",
                    args: { reportId: "weekly" },
                  },
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as unknown as GeminiStreamChunk);

      expect(adapter.state.toolCalls[0].name).toBe(clientToolName);
      expect(adapter.getRawToolCallEvents()[0]).toContain(clientToolName);
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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
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

    test("preserves thoughtSignature on text and function call parts", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      // Simulate thought text chunk
      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Let me think...",
                  thought: true,
                  thoughtSignature: "thought-sig-abc",
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as GeminiStreamChunk);

      // Simulate output text chunk with thoughtSignature
      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Here is the answer",
                  thoughtSignature: "output-sig-def",
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as GeminiStreamChunk);

      // Simulate function call with thoughtSignature
      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "generate_image",
                    args: { prompt: "a cat" },
                  },
                  thoughtSignature: "fc-sig-ghi",
                },
              ],
            },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as unknown as GeminiStreamChunk);

      const response = adapter.toProviderResponse();
      const parts = response.candidates?.[0]?.content?.parts ?? [];

      // Thought text part should have thought=true and thoughtSignature
      expect(parts[0]).toEqual({
        text: "Let me think...",
        thought: true,
        thoughtSignature: "thought-sig-abc",
      });

      // Output text part should have thoughtSignature
      expect(parts[1]).toEqual({
        text: "Here is the answer",
        thoughtSignature: "output-sig-def",
      });

      // Function call part should have thoughtSignature
      expect(parts[2]).toMatchObject({
        functionCall: {
          name: "generate_image",
          args: { prompt: "a cat" },
        },
        thoughtSignature: "fc-sig-ghi",
      });
    });

    test("handles response with only output text (no thought parts)", () => {
      const adapter = geminiAdapterFactory.createStreamAdapter();

      adapter.processChunk({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Simple response" }],
            },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-pro",
        responseId: "test-response",
      } as GeminiStreamChunk);

      const response = adapter.toProviderResponse();
      const parts = response.candidates?.[0]?.content?.parts ?? [];

      // Should have just the text part with no extra fields
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({ text: "Simple response" });
    });
  });
});

describe("restToSdkGenerateContentParams tool-schema sanitization", () => {
  // a non-string enum nested under a property — Gemini rejects this verbatim
  const badParamSchema = {
    type: "object",
    properties: { flag: { type: "boolean", enum: [true] } },
  };

  function flagEnum(schema: unknown): unknown {
    const props = (schema as { properties?: Record<string, unknown> })
      .properties;
    return (props?.flag as { enum?: unknown } | undefined)?.enum;
  }

  function firstFd(params: ReturnType<typeof restToSdkGenerateContentParams>): {
    parameters?: unknown;
    parametersJsonSchema?: unknown;
    response?: unknown;
    responseJsonSchema?: unknown;
  } {
    const tools = params.config?.tools as
      | Array<{ functionDeclarations: Array<Record<string, unknown>> }>
      | undefined;
    const fd = tools?.[0]?.functionDeclarations?.[0];
    if (!fd) throw new Error("expected a function declaration");
    return fd;
  }

  test("sanitizes all four schema fields of a function declaration", () => {
    const tools: Gemini.Types.Tool[] = [
      {
        functionDeclarations: [
          {
            name: "do_thing",
            description: "does a thing",
            parameters: structuredClone(badParamSchema),
            parametersJsonSchema: structuredClone(badParamSchema),
            response: structuredClone(badParamSchema),
            responseJsonSchema: structuredClone(badParamSchema),
          },
        ],
      },
    ];

    const fd = firstFd(
      restToSdkGenerateContentParams({ contents: [] }, "gemini-2.5-pro", tools),
    );

    expect(flagEnum(fd.parameters)).toBeUndefined();
    expect(flagEnum(fd.parametersJsonSchema)).toBeUndefined();
    expect(flagEnum(fd.response)).toBeUndefined();
    expect(flagEnum(fd.responseJsonSchema)).toBeUndefined();
  });

  test("leaves a declaration without parameters untouched", () => {
    const tools: Gemini.Types.Tool[] = [
      { functionDeclarations: [{ name: "no_args", description: "no args" }] },
    ];

    const fd = firstFd(
      restToSdkGenerateContentParams({ contents: [] }, "gemini-2.5-pro", tools),
    );

    expect(fd.parameters).toBeUndefined();
  });
});

describe("GeminiRequestAdapter tool result updates", () => {
  /**
   * A `functionResponse` without an `id` is the common case — the AI SDK's
   * Gemini provider never sends one. The id the guardrail reads and the id the
   * replacement is written under must still agree.
   */
  function requestWithUnidentifiedToolResult(): GeminiRequestWithModel {
    return createMockRequest([
      { role: "user", parts: [{ text: "Read my mail" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "read_email", args: {} } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "read_email",
              response: { body: "SECRET" },
            },
          },
        ],
      },
    ]);
  }

  test("replaces a tool result whose functionResponse carries no id", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });

    const adapter = geminiAdapterFactory.createRequestAdapter(
      requestWithUnidentifiedToolResult(),
    );

    const [toolCall] = adapter
      .getMessages()
      .flatMap((message) => message.toolCalls ?? []);
    expect(toolCall).toBeTruthy();

    // Policy evaluation queries the database between reading the request and
    // writing the replacement back, so the two passes never share a timestamp.
    vi.advanceTimersByTime(5);
    adapter.applyToolResultUpdates({ [toolCall.id]: "[REPLACED]" });

    const contents = adapter.toProviderRequest().contents ?? [];
    const responses = contents
      .flatMap((content) => content.parts ?? [])
      .flatMap((part) =>
        "functionResponse" in part && part.functionResponse
          ? [part.functionResponse.response]
          : [],
      );

    expect(responses).toEqual([{ sanitizedContent: "[REPLACED]" }]);
    expect(JSON.stringify(responses)).not.toContain("SECRET");
  });

  test("resolves the same id from getMessages and getToolResults", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });

    const adapter = geminiAdapterFactory.createRequestAdapter(
      requestWithUnidentifiedToolResult(),
    );

    const fromMessages = adapter
      .getMessages()
      .flatMap((message) => message.toolCalls ?? [])
      .map((toolCall) => toolCall.id);
    vi.advanceTimersByTime(5);
    const fromToolResults = adapter
      .getToolResults()
      .map((toolResult) => toolResult.id);

    // Anchored to the derived value, not just to each other: if the
    // functionResponse guard stopped matching id-less responses both passes
    // would return nothing and agree vacuously.
    expect(fromMessages).toEqual(["gemini-tool-2-0"]);
    expect(fromToolResults).toEqual(fromMessages);
  });
});
