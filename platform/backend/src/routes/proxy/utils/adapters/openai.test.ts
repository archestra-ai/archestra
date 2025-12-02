import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import {
  convertToolResultsToToon,
  toolCallsToCommon,
  toolResultsToMessages,
} from "./openai";

// Mock the TokenPriceModel to avoid database dependency
vi.mock("@/models", () => ({
  TokenPriceModel: {
    findByModel: vi.fn().mockResolvedValue({
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
    }),
  },
}));

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
          name: "test_tool",
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
          name: "test_tool",
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
          name: "test_tool",
          content: "simple text",
          isError: false,
        },
        {
          id: "call_2",
          name: "test_tool",
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

  describe("convertToolResultsToToon", () => {
    test("TOON encodes inner JSON in string content blocks array format", async () => {
      const { encode: toonEncode } = await import("@toon-format/toon");

      const issuesData = {
        issues: [
          { id: 1, number: 101, state: "OPEN", title: "Bug report" },
          { id: 2, number: 102, state: "CLOSED", title: "Feature request" },
        ],
      };
      // This is the format from MCP SDK: content is a string containing JSON array of content blocks
      // e.g., '[{"type":"text","text":"{\"issues\":[...]}"}]'
      const contentBlocksArray = [
        { type: "text", text: JSON.stringify(issuesData) },
      ];

      const messages = [
        {
          role: "tool" as const,
          tool_call_id: "call_01HsTdb6Nyjwvc17W5mxg8Sy",
          content: JSON.stringify(contentBlocksArray), // For some reason content is string as well in MCP responses I inspected.
        },
      ];
      const result = await convertToolResultsToToon(messages, "gpt-4");

      // Compare toon-encoded response with expected toon-encoded issues
      const toolMessage = result.messages[0];
      const parsedContent = JSON.parse(
        (toolMessage as { content: string }).content,
      );
      const expectedToonEncodedIssues = toonEncode(issuesData);
      // The inner text should match the separately TOON encoded issues
      expect(parsedContent[0].text).toBe(expectedToonEncodedIssues);
    });

    test("leaves content blocks unchanged when inner text is not JSON", async () => {
      // Plain text content that is NOT JSON
      const plainTextContent =
        "This is a plain text response, not JSON at all.";
      const contentBlocksArray = [{ type: "text", text: plainTextContent }];
      const originalContentString = JSON.stringify(contentBlocksArray);

      const messages = [
        {
          role: "tool" as const,
          tool_call_id: "call_plaintext",
          content: originalContentString,
        },
      ];

      const result = await convertToolResultsToToon(messages, "gpt-4");

      // The content should be unchanged since inner text is not JSON
      const toolMessage = result.messages[0];
      expect(toolMessage.role).toBe("tool");

      // Content should remain exactly the same
      expect((toolMessage as { content: string }).content).toBe(
        originalContentString,
      );

      // Double check by parsing - the inner text should be unchanged
      const parsedContent = JSON.parse(
        (toolMessage as { content: string }).content,
      );
      expect(parsedContent[0].text).toBe(plainTextContent);
    });
  });
});
