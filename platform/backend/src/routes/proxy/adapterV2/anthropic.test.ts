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
  describe("toProviderRequest - tool results handling", () => {
    test("handles empty tool results (no tool_result blocks)", () => {
      const messages = [
        { role: "user", content: "Hello" },
      ] as Anthropic.Types.MessagesRequest["messages"];

      const request = createMockRequest(messages);
      const adapter = anthropicAdapterFactory.createRequestAdapter(request);
      const result = adapter.toProviderRequest();

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    test("preserves successful tool results in user message with tool_result blocks", () => {
      const messages = [
        { role: "user", content: "List issues" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_123",
              name: "github_mcp_server__list_issues",
              input: { repo: "archestra-ai/archestra", count: 5 },
            },
          ],
        },
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
      ] as unknown as Anthropic.Types.MessagesRequest["messages"];

      const request = createMockRequest(messages);
      const adapter = anthropicAdapterFactory.createRequestAdapter(request);
      const result = adapter.toProviderRequest();

      expect(result.messages).toHaveLength(3);
      const toolResultMessage = result.messages[2];
      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const content = toolResultMessage.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;
      expect(content[0].type).toBe("tool_result");
      expect(content[0].tool_use_id).toBe("tool_123");
      expect(content[0].is_error).toBe(false);
    });

    test("preserves error tool results with is_error flag", () => {
      const messages = [
        { role: "user", content: "List issues" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_456",
              name: "github_mcp_server__list_issues",
              input: {},
            },
          ],
        },
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
      ] as unknown as Anthropic.Types.MessagesRequest["messages"];

      const request = createMockRequest(messages);
      const adapter = anthropicAdapterFactory.createRequestAdapter(request);
      const result = adapter.toProviderRequest();

      const toolResultMessage = result.messages[2];
      const content = toolResultMessage.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;
      expect(content[0].type).toBe("tool_result");
      expect(content[0].tool_use_id).toBe("tool_456");
      expect(content[0].content).toBe("Error: GitHub API rate limit exceeded");
      expect(content[0].is_error).toBe(true);
    });

    test("handles multiple tool results in single user message", () => {
      const messages = [
        { role: "user", content: "Do multiple things" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "test_tool",
              input: {},
            },
            {
              type: "tool_use",
              id: "tool_2",
              name: "test_tool",
              input: {},
            },
          ],
        },
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
      ] as unknown as Anthropic.Types.MessagesRequest["messages"];

      const request = createMockRequest(messages);
      const adapter = anthropicAdapterFactory.createRequestAdapter(request);
      const result = adapter.toProviderRequest();

      const toolResultMessage = result.messages[2];
      const content = toolResultMessage.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;

      expect(content).toHaveLength(2);
      expect(content[0].tool_use_id).toBe("tool_1");
      expect(content[0].is_error).toBe(false);
      expect(content[1].tool_use_id).toBe("tool_2");
      expect(content[1].is_error).toBe(true);
    });

    test("updateToolResult modifies existing tool result content", () => {
      const messages = [
        { role: "user", content: "Get data" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_123",
              name: "fetch_data",
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
              content: '{"original": "data"}',
              is_error: false,
            },
          ],
        },
      ] as unknown as Anthropic.Types.MessagesRequest["messages"];

      const request = createMockRequest(messages);
      const adapter = anthropicAdapterFactory.createRequestAdapter(request);
      adapter.updateToolResult(
        "tool_123",
        '{"modified": "data", "extra": "field"}',
      );
      const result = adapter.toProviderRequest();

      const toolResultMessage = result.messages[2];
      const content = toolResultMessage.content as Array<{
        type: string;
        content?: string;
      }>;
      expect(content[0].content).toBe('{"modified": "data", "extra": "field"}');
    });
  });

  describe("toProviderRequest - MCP image handling", () => {
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
