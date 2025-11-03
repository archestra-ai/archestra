import { toolCallsToCommon, toolResultsToMessages } from "./openai";

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
});
