import { describe, expect, test } from "@/test";
import type { OpenRouter } from "@/types";
import { openrouterAdapterFactory } from "./openrouter";

function createMockResponse(
  message: OpenRouter.Types.ChatCompletionsResponse["choices"][0]["message"],
  usage?: Partial<OpenRouter.Types.Usage>,
): OpenRouter.Types.ChatCompletionsResponse {
  return {
    id: "gen-test-id",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "anthropic/claude-3-haiku",
    choices: [
      {
        index: 0,
        message: {
          content: message.content ?? null,
          role: message.role,
          tool_calls: message.tool_calls,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 100,
      completion_tokens: usage?.completion_tokens ?? 50,
      total_tokens:
        (usage?.prompt_tokens ?? 100) + (usage?.completion_tokens ?? 50),
    },
  };
}

function createMockRequest(
  messages: OpenRouter.Types.ChatCompletionsRequest["messages"],
  options?: Partial<OpenRouter.Types.ChatCompletionsRequest>,
): OpenRouter.Types.ChatCompletionsRequest {
  return {
    model: "anthropic/claude-3-haiku",
    messages,
    ...options,
  };
}

describe("OpenRouterResponseAdapter", () => {
  describe("getToolCalls", () => {
    test("converts function tool calls to common format", () => {
      const response = createMockResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "test_tool",
              arguments: '{"param1": "value1", "param2": 42}',
            },
          },
        ],
      });

      const adapter = openrouterAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toEqual([
        {
          id: "call_123",
          name: "test_tool",
          arguments: { param1: "value1", param2: 42 },
        },
      ]);
    });

    test("handles invalid JSON in arguments gracefully", () => {
      const response = createMockResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_789",
            type: "function",
            function: {
              name: "broken_tool",
              arguments: "invalid json{",
            },
          },
        ],
      });

      const adapter = openrouterAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toEqual([
        {
          id: "call_789",
          name: "broken_tool",
          arguments: {},
        },
      ]);
    });
  });

  describe("getText", () => {
    test("extracts text content from response", () => {
      const response = createMockResponse({
        role: "assistant",
        content: "Hello, world!",
      });

      const adapter = openrouterAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("Hello, world!");
    });
  });

  describe("getUsage", () => {
    test("extracts usage tokens from response", () => {
      const response = createMockResponse(
        { role: "assistant", content: "Test" },
        { prompt_tokens: 150, completion_tokens: 75 },
      );

      const adapter = openrouterAdapterFactory.createResponseAdapter(response);
      const usage = adapter.getUsage();

      expect(usage).toEqual({
        inputTokens: 150,
        outputTokens: 75,
      });
    });
  });
});

describe("OpenRouterRequestAdapter", () => {
  describe("getModel", () => {
    test("returns original model by default", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        model: "openai/gpt-4o",
      });

      const adapter = openrouterAdapterFactory.createRequestAdapter(request);
      expect(adapter.getModel()).toBe("openai/gpt-4o");
    });
  });

  describe("getTools", () => {
    test("extracts function tools from request", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
              },
            },
          },
        ],
      });

      const adapter = openrouterAdapterFactory.createRequestAdapter(request);
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
  });
});

describe("openrouterAdapterFactory", () => {
  describe("extractApiKey", () => {
    test("removes Bearer prefix from authorization header", () => {
      const headers = { authorization: "Bearer sk-or-v1-key-123" };
      const apiKey = openrouterAdapterFactory.extractApiKey(headers);
      expect(apiKey).toBe("sk-or-v1-key-123");
    });

    test("returns key as-is if no Bearer prefix", () => {
      const headers = { authorization: "sk-or-v1-key-123" };
      const apiKey = openrouterAdapterFactory.extractApiKey(headers);
      expect(apiKey).toBe("sk-or-v1-key-123");
    });
  });

  describe("provider info", () => {
    test("has correct provider name", () => {
      expect(openrouterAdapterFactory.provider).toBe("openrouter");
    });

    test("has correct interaction type", () => {
      expect(openrouterAdapterFactory.interactionType).toBe(
        "openrouter:chatCompletions",
      );
    });
  });
});

describe("OpenRouterStreamAdapter", () => {
  describe("processChunk", () => {
    test("processes text chunks correctly", () => {
      const adapter = openrouterAdapterFactory.createStreamAdapter();

      const chunk: any = {
        id: "gen-123",
        object: "chat.completion.chunk",
        created: Date.now() / 1000,
        model: "anthropic/claude-3-haiku",
        choices: [
          {
            index: 0,
            delta: { content: "Hello, " },
            finish_reason: null,
          } as any,
        ],
      };

      const result = adapter.processChunk(chunk);

      expect(result.sseData).toContain("Hello, ");
      expect(result.isToolCallChunk).toBe(false);
      expect(adapter.state.text).toBe("Hello, ");

      // Second chunk
      adapter.processChunk({
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { content: "world!" },
            finish_reason: "stop",
          } as any,
        ],
      });

      expect(adapter.state.text).toBe("Hello, world!");
      expect(adapter.state.stopReason).toBe("stop");
    });

    test("accumulates tool calls from delta chunks", () => {
      const adapter = openrouterAdapterFactory.createStreamAdapter();

      // First chunk: start of tool call
      adapter.processChunk({
        id: "gen-123",
        object: "chat.completion.chunk",
        created: Date.now() / 1000,
        model: "anthropic/claude-3-haiku",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          } as any,
        ],
      });

      // Second chunk: arguments part 1
      adapter.processChunk({
        id: "gen-123",
        object: "chat.completion.chunk",
        created: Date.now() / 1000,
        model: "anthropic/claude-3-haiku",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"location":' },
                },
              ],
            },
            finish_reason: null,
          } as any,
        ],
      });

      // Third chunk: arguments part 2
      adapter.processChunk({
        id: "gen-123",
        object: "chat.completion.chunk",
        created: Date.now() / 1000,
        model: "anthropic/claude-3-haiku",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: ' "NYC"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          } as any,
        ],
      });

      expect(adapter.state.toolCalls).toHaveLength(1);
      expect(adapter.state.toolCalls[0]).toEqual({
        id: "call_abc",
        name: "get_weather",
        arguments: '{"location": "NYC"}',
      });
      expect(adapter.state.stopReason).toBe("tool_calls");
    });

    test("extracts final usage from chunk", () => {
      const adapter = openrouterAdapterFactory.createStreamAdapter();

      const chunk: any = {
        id: "gen-123",
        object: "chat.completion.chunk",
        created: Date.now() / 1000,
        model: "anthropic/claude-3-haiku",
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 60,
          total_tokens: 180,
        },
      };

      adapter.processChunk(chunk);

      expect(adapter.state.usage).toEqual({
        inputTokens: 120,
        outputTokens: 60,
      });
    });
  });

  describe("toProviderResponse", () => {
    test("reconstructs full response from accumulated state", () => {
      const adapter = openrouterAdapterFactory.createStreamAdapter();

      // Accumulate some state manually for brevity
      adapter.state.responseId = "gen-accumulated";
      adapter.state.model = "anthropic/claude-3-haiku";
      adapter.state.text = "Accumulated text";
      adapter.state.toolCalls = [
        { id: "tc-1", name: "tool1", arguments: "{}" },
      ];
      adapter.state.usage = { inputTokens: 50, outputTokens: 20 };
      adapter.state.stopReason = "stop";

      const response = adapter.toProviderResponse();

      expect(response.id).toBe("gen-accumulated");
      expect(response.choices[0].message.content).toBe("Accumulated text");
      expect(response.choices[0].message.tool_calls?.[0].id).toBe("tc-1");
      expect(response.usage?.prompt_tokens).toBe(50);
      expect(response.usage?.completion_tokens).toBe(20);
    });
  });

  describe("formatEndSSE", () => {
    test("returns correct end marker", () => {
      const adapter = openrouterAdapterFactory.createStreamAdapter();
      expect(adapter.formatEndSSE()).toBe("data: [DONE]\n\n");
    });
  });
});
