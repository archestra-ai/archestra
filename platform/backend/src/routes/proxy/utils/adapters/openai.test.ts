import { describe, expect, test } from "@/test";
import {
  getOptimizedModel,
  toolCallsToCommon,
  toolResultsToMessages,
} from "./openai";

describe("OpenAI MCP Adapters", () => {
  describe("toolCallsToCommon", () => {
    test("converts function tool calls to common format", () => {
      const toolCalls = [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "test_tool",
            arguments: '{"param1": "value1", "param2": 42}',
          },
        },
      ];

      const result = toolCallsToCommon(toolCalls);

      expect(result).toEqual([
        {
          id: "call_123",
          name: "test_tool",
          arguments: { param1: "value1", param2: 42 },
        },
      ]);
    });

    test("converts custom tool calls to common format", () => {
      const toolCalls = [
        {
          id: "call_456",
          type: "custom",
          custom: {
            name: "custom_tool",
            input: '{"data": "test"}',
          },
        },
      ];

      const result = toolCallsToCommon(toolCalls);

      expect(result).toEqual([
        {
          id: "call_456",
          name: "custom_tool",
          arguments: { data: "test" },
        },
      ]);
    });

    test("handles invalid JSON in arguments gracefully", () => {
      const toolCalls = [
        {
          id: "call_789",
          type: "function",
          function: {
            name: "broken_tool",
            arguments: "invalid json{",
          },
        },
      ];

      const result = toolCallsToCommon(toolCalls);

      expect(result).toEqual([
        {
          id: "call_789",
          name: "broken_tool",
          arguments: {},
        },
      ]);
    });

    test("handles unknown tool type", () => {
      const toolCalls = [
        {
          id: "call_unknown",
          type: "unknown",
        },
      ];

      const result = toolCallsToCommon(toolCalls);

      expect(result).toEqual([
        {
          id: "call_unknown",
          name: "unknown",
          arguments: {},
        },
      ]);
    });
  });

  describe("toolResultsToMessages", () => {
    test("converts successful tool results to messages", () => {
      const results = [
        {
          id: "call_123",
          content: { result: "success", data: [1, 2, 3] },
          isError: false,
        },
      ];

      const messages = toolResultsToMessages(results);

      expect(messages).toEqual([
        {
          role: "tool",
          tool_call_id: "call_123",
          content: '{"result":"success","data":[1,2,3]}',
        },
      ]);
    });

    test("converts error tool results to messages", () => {
      const results = [
        {
          id: "call_456",
          content: null,
          isError: true,
          error: "Tool execution failed",
        },
      ];

      const messages = toolResultsToMessages(results);

      expect(messages).toEqual([
        {
          role: "tool",
          tool_call_id: "call_456",
          content: "Error: Tool execution failed",
        },
      ]);
    });

    test("handles multiple tool results", () => {
      const results = [
        {
          id: "call_1",
          content: "simple text",
          isError: false,
        },
        {
          id: "call_2",
          content: null,
          isError: true,
          error: "Network timeout",
        },
      ];

      const messages = toolResultsToMessages(results);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: '"simple text"',
      });
      expect(messages[1]).toEqual({
        role: "tool",
        tool_call_id: "call_2",
        content: "Error: Network timeout",
      });
    });
  });

  describe("getOptimizedModel", () => {
    test("returns original model when it's already cheap", () => {
      const result = getOptimizedModel("gpt-4o-mini", undefined, [
        { role: "user", content: "hi" },
      ]);
      expect(result).toBe("gpt-4o-mini");
    });

    test("returns mini for expensive models with short context", () => {
      const result = getOptimizedModel("gpt-4o", undefined, [
        { role: "user", content: "hi" },
      ]);
      expect(result).toBe("gpt-4o-mini");
    });

    test("returns original model when it has long context", () => {
      const longContent = "word ".repeat(50000);
      const result = getOptimizedModel("gpt-4o", undefined, [
        { role: "user", content: longContent },
      ]);
      expect(result).toBe("gpt-4o");
    });

    test("returns original model when it has attachments", () => {
      const result = getOptimizedModel("gpt-4o", undefined, [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,...", detail: "auto" },
            },
          ],
        },
      ]);
      expect(result).toBe("gpt-4o");
    });

    test("returns original model when unknown model", () => {
      const result = getOptimizedModel("gpt-unknown", undefined, [
        { role: "user", content: "hi" },
      ]);
      expect(result).toBe("gpt-unknown");
    });
  });
});
