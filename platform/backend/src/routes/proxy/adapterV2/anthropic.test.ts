import { describe, expect, test } from "@/test";
import type { Anthropic } from "@/types";
import { anthropicAdapterFactory } from "./anthropic";

function createMockResponse(
  content: Anthropic.Types.MessagesResponse["content"],
): Anthropic.Types.MessagesResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "claude-3-5-sonnet-20241022",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
    },
  };
}

describe("AnthropicResponseAdapter", () => {
  describe("getToolCalls", () => {
    test("converts tool use blocks to common format", () => {
      const response = createMockResponse([
        {
          type: "tool_use",
          id: "tool_123",
          name: "github_mcp_server__list_issues",
          input: {
            repo: "archestra-ai/archestra",
            count: 5,
          },
        },
      ]);

      const adapter = anthropicAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

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
      const response = createMockResponse([
        {
          type: "tool_use",
          id: "tool_1",
          name: "tool_one",
          input: { param: "value1" },
        },
        {
          type: "tool_use",
          id: "tool_2",
          name: "tool_two",
          input: { param: "value2" },
        },
      ]);

      const adapter = anthropicAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

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
      const response = createMockResponse([
        {
          type: "tool_use",
          id: "tool_empty",
          name: "empty_tool",
          input: {},
        },
      ]);

      const adapter = anthropicAdapterFactory.createResponseAdapter(response);
      const result = adapter.getToolCalls();

      expect(result).toEqual([
        {
          id: "tool_empty",
          name: "empty_tool",
          arguments: {},
        },
      ]);
    });
  });
});
