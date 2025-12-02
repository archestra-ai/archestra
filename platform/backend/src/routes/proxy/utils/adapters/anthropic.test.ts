import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import {
  convertToolResultsToToon,
  toolCallsToCommon,
  toolResultsToMessages,
} from "./anthropic";

// Mock the TokenPriceModel to avoid database dependency
vi.mock("@/models", () => ({
  TokenPriceModel: {
    findByModel: vi.fn().mockResolvedValue({
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
    }),
  },
}));

describe("Anthropic MCP Adapters", () => {
  describe("toolCallsToCommon", () => {
    test("converts tool use blocks to common format", () => {
      const toolUseBlocks = [
        {
          id: "tool_123",
          name: "github_mcp_server__list_issues",
          input: {
            repo: "archestra-ai/archestra",
            count: 5,
          },
        },
      ];

      const result = toolCallsToCommon(toolUseBlocks);

      expect(result).toEqual([
        {
          id: "tool_123",
          name: "github_mcp_server__list_issues",
          arguments: {
            repo: "archestra-ai/archestra",
            count: 5,
          },
        },
      ]);
    });

    test("handles multiple tool use blocks", () => {
      const toolUseBlocks = [
        {
          id: "tool_1",
          name: "tool_one",
          input: { param: "value1" },
        },
        {
          id: "tool_2",
          name: "tool_two",
          input: { param: "value2" },
        },
      ];

      const result = toolCallsToCommon(toolUseBlocks);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "tool_1",
        name: "tool_one",
        arguments: { param: "value1" },
      });
      expect(result[1]).toEqual({
        id: "tool_2",
        name: "tool_two",
        arguments: { param: "value2" },
      });
    });

    test("handles empty input", () => {
      const toolUseBlocks = [
        {
          id: "tool_empty",
          name: "empty_tool",
          input: {},
        },
      ];

      const result = toolCallsToCommon(toolUseBlocks);

      expect(result).toEqual([
        {
          id: "tool_empty",
          name: "empty_tool",
          arguments: {},
        },
      ]);
    });
  });

  describe("toolResultsToMessages", () => {
    test("returns empty array for no results", () => {
      const messages = toolResultsToMessages([]);
      expect(messages).toEqual([]);
    });

    test("converts successful tool results to user message with tool_result blocks", () => {
      const results = [
        {
          id: "tool_123",
          name: "github_mcp_server__list_issues",
          content: {
            issues: [
              { number: 1, title: "First issue" },
              { number: 2, title: "Second issue" },
            ],
          },
          isError: false,
        },
      ];

      const messages = toolResultsToMessages(results);

      expect(messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_123",
              content:
                '{"issues":[{"number":1,"title":"First issue"},{"number":2,"title":"Second issue"}]}',
              is_error: false,
            },
          ],
        },
      ]);
    });

    test("converts error tool results to user message", () => {
      const results = [
        {
          id: "tool_456",
          name: "github_mcp_server__list_issues",
          content: null,
          isError: true,
          error: "GitHub API rate limit exceeded",
        },
      ];

      const messages = toolResultsToMessages(results);

      expect(messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_456",
              content: "Error: GitHub API rate limit exceeded",
              is_error: true,
            },
          ],
        },
      ]);
    });

    test("handles multiple tool results in single message", () => {
      const results = [
        {
          id: "tool_1",
          name: "test_tool",
          content: "success",
          isError: false,
        },
        {
          id: "tool_2",
          name: "test_tool",
          content: null,
          isError: true,
          error: "Failed",
        },
      ];

      const messages = toolResultsToMessages(results);

      expect(messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: '"success"',
              is_error: false,
            },
            {
              type: "tool_result",
              tool_use_id: "tool_2",
              content: "Error: Failed",
              is_error: true,
            },
          ],
        },
      ]);
    });

    test("handles tool result without error message", () => {
      const results = [
        {
          id: "tool_no_msg",
          name: "test_tool",
          content: null,
          isError: true,
        },
      ];

      const messages = toolResultsToMessages(results);

      expect(messages[0].content[0].content).toBe(
        "Error: Tool execution failed",
      );
    });
  });

  describe("convertToolResultsToToon", () => {
    test("TOON encodes inner JSON in string content blocks array format", async () => {
      // Import toonEncode to verify the encoding
      const { encode: toonEncode } = await import("@toon-format/toon");

      // The actual data we want to compress
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
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "toolu_01HsTdb6Nyjwvc17W5mxg8Sy",
              content: JSON.stringify(contentBlocksArray), // For some reason content is string as well in MCP responses I inspected.
            },
          ],
        },
      ];

      const result = await convertToolResultsToToon(messages, "claude-3-opus");

      // Compare toon-encoded response with expected toon-encoded issues
      const toolResult = (
        result.messages[0].content as Array<{ type: string; content: string }>
      )[0];
      const parsedContent = JSON.parse(toolResult.content);

      const expectedToonEncodedIssues = toonEncode(issuesData);

      expect(parsedContent[0].text).toBe(expectedToonEncodedIssues);
    });

    test("leaves content blocks unchanged when inner text is not JSON", async () => {
      const plainTextContent =
        "This is a plain text response, not JSON at all.";
      const contentBlocksArray = [{ type: "text", text: plainTextContent }];
      const originalContentString = JSON.stringify(contentBlocksArray);

      const messages = [
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "toolu_plaintext",
              content: originalContentString,
            },
          ],
        },
      ];

      const result = await convertToolResultsToToon(messages, "claude-3-opus");

      // The content should be unchanged since inner text is not JSON
      const userMessage = result.messages[0];
      const toolResult = (
        userMessage.content as Array<{ type: string; content: string }>
      )[0];

      // Content should remain exactly the same
      expect(toolResult.content).toBe(originalContentString);

      // Double check by parsing - the inner text should be unchanged
      const parsedContent = JSON.parse(toolResult.content);
      expect(parsedContent[0].text).toBe(plainTextContent);
    });
  });
});
