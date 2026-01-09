import config from "@/config";
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

function createMockRequest(
  messages: Anthropic.Types.MessagesRequest["messages"],
  options?: Partial<Anthropic.Types.MessagesRequest>,
): Anthropic.Types.MessagesRequest {
  const { max_tokens, ...rest } = options ?? {};
  return {
    model: "claude-3-5-sonnet-20241022",
    messages,
    max_tokens: max_tokens ?? 1024,
    ...rest,
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

describe("AnthropicRequestAdapter", () => {
  describe("toProviderRequest", () => {
    test("converts MCP image blocks in tool results", () => {
      const originalBrowserStreaming = config.features.browserStreamingEnabled;
      config.features.browserStreamingEnabled = true;
      try {
        const messages = [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_123",
                name: "browser_take_screenshot",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_123",
                content: [
                  { type: "text", text: "Screenshot captured" },
                  {
                    type: "image",
                    data: "abc123",
                    mimeType: "image/png",
                  },
                ],
              },
            ],
          },
        ] as unknown as Anthropic.Types.MessagesRequest["messages"];

        const request = createMockRequest(messages);
        const adapter = anthropicAdapterFactory.createRequestAdapter(request);
        const result = adapter.toProviderRequest();

        const userMessage = result.messages.find(
          (message) => message.role === "user",
        );
        const userContent = Array.isArray(userMessage?.content)
          ? userMessage.content
          : [];
        const toolResultBlock = userContent.find(
          (block) => block.type === "tool_result",
        ) as { content?: unknown } | undefined;

        expect(toolResultBlock?.content).toEqual([
          { type: "text", text: "Screenshot captured" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc123",
            },
          },
        ]);
      } finally {
        config.features.browserStreamingEnabled = originalBrowserStreaming;
      }
    });

    test("strips oversized MCP image blocks in tool results", () => {
      const originalBrowserStreaming = config.features.browserStreamingEnabled;
      config.features.browserStreamingEnabled = true;
      try {
        const largeImageData = "a".repeat(140000);
        const messages = [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_123",
                name: "browser_take_screenshot",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_123",
                content: [
                  { type: "text", text: "Screenshot captured" },
                  {
                    type: "image",
                    data: largeImageData,
                    mimeType: "image/png",
                  },
                ],
              },
            ],
          },
        ] as unknown as Anthropic.Types.MessagesRequest["messages"];

        const request = createMockRequest(messages);
        const adapter = anthropicAdapterFactory.createRequestAdapter(request);
        const result = adapter.toProviderRequest();

        const userMessage = result.messages.find(
          (message) => message.role === "user",
        );
        const userContent = Array.isArray(userMessage?.content)
          ? userMessage.content
          : [];
        const toolResultBlock = userContent.find(
          (block) => block.type === "tool_result",
        ) as { content?: unknown } | undefined;

        expect(toolResultBlock?.content).toEqual([
          { type: "text", text: "Screenshot captured" },
          { type: "text", text: "[Image omitted due to size]" },
        ]);
      } finally {
        config.features.browserStreamingEnabled = originalBrowserStreaming;
      }
    });
  });
});
