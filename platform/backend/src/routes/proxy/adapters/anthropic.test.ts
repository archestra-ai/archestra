import AnthropicProvider from "@anthropic-ai/sdk";
import { vi } from "vitest";
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

  describe("getUsage", () => {
    test("captures the 1h portion of the cache-creation split", () => {
      const response = {
        ...createMockResponse([{ type: "text", text: "hi" }]),
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 1000,
          cache_creation: {
            ephemeral_1h_input_tokens: 400,
            ephemeral_5m_input_tokens: 600,
          },
        },
      } as Anthropic.Types.MessagesResponse;

      const adapter = anthropicAdapterFactory.createResponseAdapter(response);

      expect(adapter.getUsage()).toEqual({
        inputTokens: 5,
        outputTokens: 10,
        cacheReadTokens: 2000,
        cacheWriteTokens: 1000,
        cacheWrite1hTokens: 400,
      });
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
    });

    test("strips oversized MCP image blocks in tool results", () => {
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
    });
  });
});

describe("anthropicAdapterFactory.executeStream", () => {
  function sseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  // builds a real Anthropic client whose transport returns a canned SSE body,
  // so the real SDK stream parsing runs without hitting the network.
  function clientWithSseBody(body: string): AnthropicProvider {
    const fakeFetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof globalThis.fetch;
    return new AnthropicProvider({ apiKey: "test-key", fetch: fakeFetch });
  }

  // partial_json fragments that concatenate into more than one JSON value. The
  // SDK's messages.stream() helper eagerly partial-parses the accumulated buffer
  // and throws on this; the raw create() stream must tolerate it.
  test("does not throw when tool input deltas concatenate into two JSON values", async () => {
    const body =
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet-20241022",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "do_thing",
          input: {},
        },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"unit":"c"}' },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 2 },
      }) +
      sseEvent("message_stop", { type: "message_stop" });

    const client = clientWithSseBody(body);
    const stream = await anthropicAdapterFactory.executeStream(
      client,
      createMockRequest([{ role: "user", content: "hi" }]),
    );

    const adapter = anthropicAdapterFactory.createStreamAdapter();
    for await (const event of stream) {
      adapter.processChunk(event);
    }

    const response = adapter.toProviderResponse();
    const toolUse = response.content.find((block) => block.type === "tool_use");
    expect(toolUse).toBeDefined();
    // malformed accumulated arguments fall back to empty input rather than crashing.
    expect((toolUse as { input: unknown }).input).toEqual({});
  });

  test("parses tool input from well-formed incremental deltas", async () => {
    const body =
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet-20241022",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_2",
          name: "do_thing",
          input: {},
        },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"SF"}' },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("message_stop", { type: "message_stop" });

    const client = clientWithSseBody(body);
    const stream = await anthropicAdapterFactory.executeStream(
      client,
      createMockRequest([{ role: "user", content: "hi" }]),
    );

    const adapter = anthropicAdapterFactory.createStreamAdapter();
    for await (const event of stream) {
      adapter.processChunk(event);
    }

    const response = adapter.toProviderResponse();
    const toolUse = response.content.find((block) => block.type === "tool_use");
    expect((toolUse as { input: unknown }).input).toEqual({ city: "SF" });
  });
});

describe("AnthropicStreamAdapter content block forwarding", () => {
  type Chunk = Parameters<
    ReturnType<
      typeof anthropicAdapterFactory.createStreamAdapter
    >["processChunk"]
  >[0];

  // Claude Code streams with interleaved thinking; thinking events must reach
  // the client immediately (it replays them, signed, on the next turn), while
  // client tool_use events stay held back for policy evaluation.
  test("forwards thinking events and holds back tool_use events", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();

    const thinkingStart = adapter.processChunk({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    } as Chunk);
    expect(thinkingStart.sseData).toContain("content_block_start");
    expect(thinkingStart.isToolCallChunk).toBe(false);

    const thinkingDelta = adapter.processChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me think" },
    } as Chunk);
    expect(thinkingDelta.sseData).toContain("thinking_delta");

    const signatureDelta = adapter.processChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-abc" },
    } as Chunk);
    expect(signatureDelta.sseData).toContain("signature_delta");

    const toolStart = adapter.processChunk({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "do_thing",
        input: {},
      },
    } as Chunk);
    expect(toolStart.sseData).toBeNull();
    expect(toolStart.isToolCallChunk).toBe(true);

    const toolDelta = adapter.processChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' },
    } as Chunk);
    expect(toolDelta.sseData).toBeNull();
    expect(toolDelta.isToolCallChunk).toBe(true);
    expect(adapter.state.toolCalls[0].arguments).toBe('{"city":"SF"}');
  });

  test("forwards server_tool_use input deltas without polluting client tool calls", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();

    // a held-back client tool call, then a server tool block
    adapter.processChunk({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "do_thing",
        input: {},
      },
    } as Chunk);

    const serverStart = adapter.processChunk({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: {},
      },
    } as Chunk);
    expect(serverStart.sseData).toContain("server_tool_use");
    expect(serverStart.isToolCallChunk).toBe(false);

    const serverDelta = adapter.processChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
    } as Chunk);
    expect(serverDelta.sseData).toContain("input_json_delta");
    expect(serverDelta.isToolCallChunk).toBe(false);
    // the server tool's input must not leak into the client tool call
    expect(adapter.state.toolCalls).toHaveLength(1);
    expect(adapter.state.toolCalls[0].arguments).toBe("");
  });
});

describe("AnthropicStreamAdapter policy refusal terminal", () => {
  type Chunk = Parameters<
    ReturnType<
      typeof anthropicAdapterFactory.createStreamAdapter
    >["processChunk"]
  >[0];

  // Reproduces the reported incident: a blocked tool-call turn must not end the
  // stream with the upstream "tool_use" stop reason, or Claude Code reads the
  // text-only refusal as a malformed tool call and retries it.
  function streamBlockedToolTurn() {
    const adapter = anthropicAdapterFactory.createStreamAdapter();
    // A text block streams live at index 0...
    adapter.processChunk({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as Chunk);
    adapter.processChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "let me check" },
    } as Chunk);
    adapter.processChunk({
      type: "content_block_stop",
      index: 0,
    } as Chunk);
    // ...then a tool_use block at index 1 is buffered (held back)...
    adapter.processChunk({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "list",
        input: {},
      },
    } as Chunk);
    adapter.processChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":1}' },
    } as Chunk);
    adapter.processChunk({
      type: "content_block_stop",
      index: 1,
    } as Chunk);
    // ...and the upstream turn ends with a tool_use stop reason.
    adapter.processChunk({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    } as Chunk);
    return adapter;
  }

  test("formatEndSSE closes a refused stream as end_turn, not the upstream tool_use", () => {
    const adapter = streamBlockedToolTurn();

    adapter.formatCompleteTextSSE(
      "Archestra LLM Proxy blocked unsafe tool call",
    );
    const endEvents = adapter.formatEndSSE();

    expect(endEvents).toContain('"stop_reason":"end_turn"');
    expect(endEvents).not.toContain('"stop_reason":"tool_use"');
  });

  test("refusal text block is placed after already-streamed blocks (no index reuse)", () => {
    const adapter = streamBlockedToolTurn();

    const refusalEvents = adapter.formatCompleteTextSSE("blocked").join("");

    // index 0 was already streamed (the text block); the refusal must use index 1.
    expect(refusalEvents).toContain('"index":1');
    expect(refusalEvents).not.toContain('"index":0');
  });

  test("toProviderResponse persists the refusal, not the blocked tool call", () => {
    const adapter = streamBlockedToolTurn();

    adapter.formatCompleteTextSSE("blocked message");
    const response = adapter.toProviderResponse();

    expect(response.stop_reason).toBe("end_turn");
    expect(response.content).toEqual([
      { type: "text", text: "blocked message", citations: null },
    ]);
    expect(response.content.some((block) => block.type === "tool_use")).toBe(
      false,
    );
  });
});

describe("anthropicAdapterFactory.execute", () => {
  // The SDK refuses non-streaming requests whose max_tokens implies a >10 min
  // completion ("Streaming is required for operations that may take longer
  // than 10 minutes") unless the client carries an explicit timeout. Claude
  // Code sends max_tokens=32000 non-streaming; the proxy must forward it,
  // not 500.
  test("forwards large non-streaming max_tokens instead of tripping the SDK guard", async () => {
    const client = anthropicAdapterFactory.createClient("test-key", {
      source: "api",
    }) as AnthropicProvider;

    // Stub the transport: the guard under test runs synchronously inside
    // messages.create before any network I/O.
    const post = vi
      .spyOn(client as unknown as { post: () => unknown }, "post")
      .mockResolvedValue(
        createMockResponse([{ type: "text", text: "ok", citations: null }]),
      );

    const response = await anthropicAdapterFactory.execute(
      client,
      createMockRequest([{ role: "user", content: "hi" }], {
        model: "claude-opus-4-20250514",
        max_tokens: 64000,
      }),
    );

    expect(post).toHaveBeenCalled();
    expect(response.content[0]).toMatchObject({ type: "text", text: "ok" });
  });
});
