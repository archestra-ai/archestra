import { describe, expect, test } from "@/test";
import type { Cohere } from "@/types";
import { cohereAdapterFactory } from "./cohere";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function createMockResponse(
  content: Cohere.Types.ChatResponse["message"]["content"],
  options?: {
    toolCalls?: Cohere.Types.ChatResponse["message"]["tool_calls"];
    usage?: Partial<Cohere.Types.ChatResponse["usage"]>;
    finishReason?: Cohere.Types.ChatResponse["finish_reason"];
  },
): Cohere.Types.ChatResponse {
  return {
    id: "msg_test_123",
    message: {
      role: "assistant",
      content,
      tool_calls: options?.toolCalls,
    },
    finish_reason: options?.finishReason ?? "COMPLETE",
    usage: {
      tokens: {
        input_tokens: options?.usage?.tokens?.input_tokens ?? 100,
        output_tokens: options?.usage?.tokens?.output_tokens ?? 50,
      },
    },
  };
}

function createMockRequest(
  messages: Cohere.Types.ChatRequest["messages"],
  options?: Partial<Cohere.Types.ChatRequest>,
): Cohere.Types.ChatRequest {
  return {
    model: "command-r-plus",
    messages,
    ...options,
  };
}

// =============================================================================
// RESPONSE ADAPTER TESTS
// =============================================================================

describe("CohereResponseAdapter", () => {
  describe("getId", () => {
    test("extracts id from response", () => {
      const response = createMockResponse([{ type: "text", text: "Hello" }]);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.getId()).toBe("msg_test_123");
    });

    test("returns empty string when id is missing", () => {
      const response = {
        message: { role: "assistant", content: [] },
        finish_reason: "COMPLETE",
        usage: { tokens: { input_tokens: 0, output_tokens: 0 } },
      } as unknown as Cohere.Types.ChatResponse;

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.getId()).toBe("");
    });
  });

  describe("getText", () => {
    test("extracts text content from response", () => {
      const response = createMockResponse([
        { type: "text", text: "Hello, world!" },
      ]);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("Hello, world!");
    });

    test("concatenates multiple text blocks", () => {
      const response = createMockResponse([
        { type: "text", text: "Hello, " },
        { type: "text", text: "world!" },
      ]);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("Hello, world!");
    });

    test("returns empty string when content is empty", () => {
      const response = createMockResponse([]);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("");
    });

    test("returns empty string when content is undefined", () => {
      const response = createMockResponse(undefined);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.getText()).toBe("");
    });
  });

  describe("getToolCalls", () => {
    test("converts tool calls to common format", () => {
      const response = createMockResponse([], {
        toolCalls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location": "NYC", "unit": "celsius"}',
            },
          },
        ],
      });

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toEqual([
        {
          id: "call_123",
          name: "get_weather",
          arguments: { location: "NYC", unit: "celsius" },
        },
      ]);
    });

    test("handles multiple tool calls", () => {
      const response = createMockResponse([], {
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "tool_one",
              arguments: '{"param": "value1"}',
            },
          },
          {
            id: "call_2",
            type: "function",
            function: {
              name: "tool_two",
              arguments: '{"param": "value2"}',
            },
          },
        ],
      });

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "call_1",
        name: "tool_one",
        arguments: { param: "value1" },
      });
      expect(result[1]).toEqual({
        id: "call_2",
        name: "tool_two",
        arguments: { param: "value2" },
      });
    });

    test("handles empty arguments", () => {
      const response = createMockResponse([], {
        toolCalls: [
          {
            id: "call_empty",
            type: "function",
            function: {
              name: "empty_tool",
              arguments: "{}",
            },
          },
        ],
      });

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toEqual([
        {
          id: "call_empty",
          name: "empty_tool",
          arguments: {},
        },
      ]);
    });

    test("returns empty array when no tool calls", () => {
      const response = createMockResponse([{ type: "text", text: "Hello" }]);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.getToolCalls()).toEqual([]);
    });
  });

  describe("hasToolCalls", () => {
    test("returns true when tool calls exist", () => {
      const response = createMockResponse([], {
        toolCalls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "test", arguments: "{}" },
          },
        ],
      });

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.hasToolCalls()).toBe(true);
    });

    test("returns false when no tool calls", () => {
      const response = createMockResponse([{ type: "text", text: "Hello" }]);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      expect(adapter.hasToolCalls()).toBe(false);
    });
  });

  describe("getUsage", () => {
    test("extracts usage tokens from response", () => {
      const response = createMockResponse([{ type: "text", text: "Test" }], {
        usage: {
          tokens: { input_tokens: 150, output_tokens: 75 },
        },
      });

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      const usage = adapter.getUsage();

      expect(usage).toEqual({
        inputTokens: 150,
        outputTokens: 75,
      });
    });
  });

  describe("toRefusalResponse", () => {
    test("creates refusal response with provided message", () => {
      const response = createMockResponse([
        { type: "text", text: "Original content" },
      ]);

      const adapter = cohereAdapterFactory.createResponseAdapter(response);
      const refusal = adapter.toRefusalResponse(
        "Full refusal",
        "Tool call blocked by policy",
      );

      expect(refusal.message.content).toEqual([
        { type: "text", text: "Tool call blocked by policy" },
      ]);
      expect(refusal.finish_reason).toBe("COMPLETE");
    });
  });
});

// =============================================================================
// REQUEST ADAPTER TESTS
// =============================================================================

describe("CohereRequestAdapter", () => {
  describe("getModel", () => {
    test("returns original model by default", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        model: "command-r-plus",
      });

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      expect(adapter.getModel()).toBe("command-r-plus");
    });

    test("returns modified model after setModel", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        model: "command-r-plus",
      });

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      adapter.setModel("command-r");
      expect(adapter.getModel()).toBe("command-r");
    });
  });

  describe("isStreaming", () => {
    test("returns true when stream is true", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        stream: true,
      });

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      expect(adapter.isStreaming()).toBe(true);
    });

    test("returns false when stream is false", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        stream: false,
      });

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      expect(adapter.isStreaming()).toBe(false);
    });

    test("returns false when stream is undefined", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      expect(adapter.isStreaming()).toBe(false);
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

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
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
      const request = createMockRequest([{ role: "user", content: "Hello" }]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      expect(adapter.getTools()).toEqual([]);
    });

    test("handles multiple tools", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        tools: [
          {
            type: "function",
            function: {
              name: "tool_one",
              description: "First tool",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function",
            function: {
              name: "tool_two",
              description: "Second tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      });

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      const tools = adapter.getTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("tool_one");
      expect(tools[1].name).toBe("tool_two");
    });
  });

  describe("hasTools", () => {
    test("returns true when tools exist", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        tools: [
          {
            type: "function",
            function: {
              name: "test_tool",
              parameters: { type: "object" },
            },
          },
        ],
      });

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      expect(adapter.hasTools()).toBe(true);
    });

    test("returns false when no tools", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      expect(adapter.hasTools()).toBe(false);
    });
  });

  describe("getMessages", () => {
    test("converts tool messages to common format", () => {
      const request = createMockRequest([
        { role: "user", content: "Get the weather" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location": "NYC"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: '{"temperature": 72, "unit": "fahrenheit"}',
        },
      ] as Cohere.Types.ChatRequest["messages"]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
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

  describe("getToolResults", () => {
    test("extracts tool results from messages", () => {
      const request = createMockRequest([
        { role: "user", content: "Get the weather" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location": "NYC"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: '{"temperature": 72}',
        },
      ] as Cohere.Types.ChatRequest["messages"]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      const results = adapter.getToolResults();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: "call_123",
        name: "get_weather",
        content: { temperature: 72 },
        isError: false,
      });
    });
  });

  describe("toProviderRequest", () => {
    test("applies model change to request", () => {
      const request = createMockRequest([{ role: "user", content: "Hello" }], {
        model: "command-r-plus",
      });

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      adapter.setModel("command-r");
      const result = adapter.toProviderRequest();

      expect(result.model).toBe("command-r");
    });

    test("applies tool result updates to request", () => {
      const request = createMockRequest([
        { role: "user", content: "Get the weather" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location": "NYC"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: '{"temperature": 72}',
        },
      ] as Cohere.Types.ChatRequest["messages"]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      adapter.updateToolResult(
        "call_123",
        '{"temperature": 75, "note": "updated"}',
      );
      const result = adapter.toProviderRequest();

      const toolMessage = result.messages.find((m) => m.role === "tool") as
        | Cohere.Types.ToolMessage
        | undefined;
      expect(toolMessage?.content).toBe(
        '{"temperature": 75, "note": "updated"}',
      );
    });

    test("filters out empty assistant messages without tool calls", () => {
      const request = createMockRequest([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "" },
        { role: "user", content: "How are you?" },
      ] as Cohere.Types.ChatRequest["messages"]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      const result = adapter.toProviderRequest();

      const assistantMessages = result.messages.filter(
        (m) => m.role === "assistant",
      );
      expect(assistantMessages).toHaveLength(0);
    });

    test("keeps assistant messages with tool calls", () => {
      const request = createMockRequest([
        { role: "user", content: "Get weather" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
      ] as Cohere.Types.ChatRequest["messages"]);

      const adapter = cohereAdapterFactory.createRequestAdapter(request);
      const result = adapter.toProviderRequest();

      const assistantMessages = result.messages.filter(
        (m) => m.role === "assistant",
      );
      expect(assistantMessages).toHaveLength(1);
    });
  });
});

// =============================================================================
// STREAM ADAPTER TESTS
// =============================================================================

describe("CohereStreamAdapter", () => {
  describe("processChunk", () => {
    test("handles message-start chunk", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      const chunk = {
        type: "message-start",
        message: {
          id: "msg_123",
        },
      };

      const result = adapter.processChunk(chunk);

      expect(adapter.state.responseId).toBe("msg_123");
      expect(result.sseData).toBeTruthy();
      expect(result.isFinal).toBe(false);
    });

    test("handles content-delta chunk and accumulates text", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      const chunk = {
        type: "content-delta",
        index: 0,
        delta: {
          message: {
            content: {
              text: "Hello, ",
            },
          },
        },
      };

      adapter.processChunk(chunk);

      expect(adapter.state.text).toBe("Hello, ");
    });

    test("accumulates text across multiple content-delta chunks", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      adapter.processChunk({
        type: "content-delta",
        index: 0,
        delta: { message: { content: { text: "Hello, " } } },
      });

      adapter.processChunk({
        type: "content-delta",
        index: 0,
        delta: { message: { content: { text: "world!" } } },
      });

      expect(adapter.state.text).toBe("Hello, world!");
    });

    test("handles tool-call-start with existing ID", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      const chunk = {
        type: "tool-call-start",
        tool_call: {
          id: "existing-id",
          function: {
            name: "test_tool",
          },
        },
      };

      adapter.processChunk(chunk);

      expect(adapter.state.toolCalls).toHaveLength(1);
      expect(adapter.state.toolCalls[0].id).toBe("existing-id");
      expect(adapter.state.toolCalls[0].name).toBe("test_tool");
    });

    test("generates ID for tool call with missing ID", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      const chunk = {
        type: "tool-call-start",
        tool_call: {
          // No id provided
          function: {
            name: "test_tool",
          },
        },
      };

      adapter.processChunk(
        chunk as unknown as Parameters<typeof adapter.processChunk>[0],
      );

      expect(adapter.state.toolCalls).toHaveLength(1);
      expect(adapter.state.toolCalls[0].id).toBeTruthy();
      expect(adapter.state.toolCalls[0].id).not.toBe("");
    });

    test("generates ID for tool call with empty string ID", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      const chunk = {
        type: "tool-call-start",
        tool_call: {
          id: "",
          function: {
            name: "test_tool",
          },
        },
      };

      adapter.processChunk(chunk);

      expect(adapter.state.toolCalls).toHaveLength(1);
      expect(adapter.state.toolCalls[0].id).toBeTruthy();
      expect(adapter.state.toolCalls[0].id).not.toBe("");
    });

    test("handles tool-call-delta and accumulates arguments", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      // First, start a tool call
      adapter.processChunk({
        type: "tool-call-start",
        tool_call: {
          id: "call_123",
          function: {
            name: "test_tool",
            arguments: '{"param',
          },
        },
      });

      // Then, receive argument delta
      adapter.processChunk({
        type: "tool-call-delta",
        delta: {
          message: {
            tool_calls: {
              function: {
                arguments: '": "value"}',
              },
            },
          },
        },
      });

      expect(adapter.state.toolCalls[0].arguments).toBe('{"param": "value"}');
    });

    test("handles message-end chunk and extracts usage", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      const chunk = {
        type: "message-end",
        delta: {
          finish_reason: "COMPLETE",
          usage: {
            tokens: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        },
      };

      const result = adapter.processChunk(chunk);

      expect(result.isFinal).toBe(true);
      expect(adapter.state.stopReason).toBe("COMPLETE");
      expect(adapter.state.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    test("sets firstChunkTime on first chunk", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      expect(adapter.state.timing.firstChunkTime).toBeNull();

      adapter.processChunk({
        type: "content-start",
        index: 0,
      });

      expect(adapter.state.timing.firstChunkTime).not.toBeNull();
    });
  });

  describe("getSSEHeaders", () => {
    test("returns correct SSE headers", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();
      const headers = adapter.getSSEHeaders();

      expect(headers["Content-Type"]).toBe("text/event-stream");
      expect(headers["Cache-Control"]).toBe("no-cache");
      expect(headers.Connection).toBe("keep-alive");
    });
  });

  describe("formatTextDeltaSSE", () => {
    test("formats text delta as SSE event", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();
      const sseData = adapter.formatTextDeltaSSE("Hello");

      expect(sseData).toContain("data:");
      expect(sseData).toContain("content-delta");
      expect(sseData).toContain("Hello");
      expect(sseData).toMatch(/\n\n$/);
    });
  });

  describe("formatCompleteTextSSE", () => {
    test("returns array with content-start, content-delta, and content-end", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();
      const sseEvents = adapter.formatCompleteTextSSE("Complete text");

      expect(sseEvents).toHaveLength(3);
      expect(sseEvents[0]).toContain("content-start");
      expect(sseEvents[1]).toContain("content-delta");
      expect(sseEvents[1]).toContain("Complete text");
      expect(sseEvents[2]).toContain("content-end");
    });
  });

  describe("formatEndSSE", () => {
    test("formats end event as SSE with usage", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      // Simulate setting state
      adapter.processChunk({
        type: "message-end",
        delta: {
          finish_reason: "COMPLETE",
          usage: {
            tokens: { input_tokens: 100, output_tokens: 50 },
          },
        },
      });

      const sseData = adapter.formatEndSSE();

      expect(sseData).toContain("message-end");
      expect(sseData).toContain("COMPLETE");
      expect(sseData).toMatch(/\n\n$/);
    });
  });

  describe("toProviderResponse", () => {
    test("builds complete response from accumulated state", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      // Simulate a complete stream
      adapter.processChunk({
        type: "message-start",
        message: { id: "msg_123" },
      });
      adapter.processChunk({
        type: "content-delta",
        delta: { message: { content: { text: "Hello" } } },
      });
      adapter.processChunk({
        type: "message-end",
        delta: {
          finish_reason: "COMPLETE",
          usage: { tokens: { input_tokens: 10, output_tokens: 5 } },
        },
      });

      const response = adapter.toProviderResponse();

      expect(response.id).toBe("msg_123");
      expect(response.message.role).toBe("assistant");
      expect(response.message.content).toEqual([
        { type: "text", text: "Hello" },
      ]);
      expect(response.finish_reason).toBe("COMPLETE");
      expect(response.usage?.tokens?.input_tokens).toBe(10);
      expect(response.usage?.tokens?.output_tokens).toBe(5);
    });

    test("includes tool calls in response", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      adapter.processChunk({
        type: "tool-call-start",
        tool_call: {
          id: "call_123",
          function: {
            name: "test_tool",
            arguments: '{"param": "value"}',
          },
        },
      });

      const response = adapter.toProviderResponse();

      expect(response.message.tool_calls).toHaveLength(1);
      expect(response.message.tool_calls?.[0]).toEqual({
        id: "call_123",
        type: "function",
        function: {
          name: "test_tool",
          arguments: '{"param": "value"}',
        },
      });
    });
  });

  describe("getRawToolCallEvents", () => {
    test("returns formatted SSE events for tool calls", () => {
      const adapter = cohereAdapterFactory.createStreamAdapter();

      adapter.processChunk({
        type: "tool-call-start",
        tool_call: {
          id: "call_123",
          function: { name: "test_tool", arguments: "" },
        },
      });

      const events = adapter.getRawToolCallEvents();

      expect(events).toHaveLength(1);
      expect(events[0]).toContain("data:");
      expect(events[0]).toMatch(/\n\n$/);
    });
  });
});

// =============================================================================
// FACTORY TESTS
// =============================================================================

describe("cohereAdapterFactory", () => {
  describe("extractApiKey", () => {
    test("extracts API key from Bearer token", () => {
      const headers = { authorization: "Bearer test-api-key-123" };
      const apiKey = cohereAdapterFactory.extractApiKey(headers);
      expect(apiKey).toBe("test-api-key-123");
    });

    test("returns undefined when no Bearer prefix", () => {
      const headers = { authorization: "test-api-key-123" };
      const apiKey = cohereAdapterFactory.extractApiKey(headers);
      expect(apiKey).toBeUndefined();
    });

    test("returns undefined when no authorization header", () => {
      const headers = {} as Cohere.Types.ChatHeaders;
      const apiKey = cohereAdapterFactory.extractApiKey(headers);
      expect(apiKey).toBeUndefined();
    });
  });

  describe("provider info", () => {
    test("has correct provider name", () => {
      expect(cohereAdapterFactory.provider).toBe("cohere");
    });

    test("has correct interaction type", () => {
      expect(cohereAdapterFactory.interactionType).toBe("cohere:chat");
    });
  });

  describe("getSpanName", () => {
    test("returns correct span name", () => {
      expect(cohereAdapterFactory.getSpanName(false)).toBe("cohere.chat");
    });
  });

  describe("extractErrorMessage", () => {
    test("extracts message from Error instance", () => {
      const error = new Error("Test error message");
      const message = cohereAdapterFactory.extractErrorMessage(error);
      expect(message).toBe("Test error message");
    });

    test("extracts message from error object with message property", () => {
      const error = { message: "Object error message" };
      const message = cohereAdapterFactory.extractErrorMessage(error);
      expect(message).toBe("Object error message");
    });

    test("extracts message from nested error.message", () => {
      const error = { error: { message: "Nested error message" } };
      const message = cohereAdapterFactory.extractErrorMessage(error);
      expect(message).toBe("Nested error message");
    });

    test("converts non-object errors to string", () => {
      const message = cohereAdapterFactory.extractErrorMessage("string error");
      expect(message).toBe("string error");
    });
  });
});
