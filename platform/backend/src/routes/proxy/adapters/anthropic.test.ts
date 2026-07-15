import AnthropicProvider from "@anthropic-ai/sdk";
import { ArchestraInternalErrorCode } from "@archestra/shared";
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
  // Claude Code sends large max_tokens (e.g. 32000) non-streaming. Such a
  // request would exceed the SDK's ~10-minute non-streaming limit, so — rather
  // than attempt it non-streaming (which the client's explicit timeout would
  // cap) — the proxy serves it over the streaming Messages API and returns the
  // accumulated final Message. The result is forwarded, never 500-ed. Uses the
  // real client so the real routing decision runs; only the stream transport is
  // stubbed.
  test("serves a large-max_tokens request over the streaming API and forwards the result", async () => {
    const client = anthropicAdapterFactory.createClient("test-key", {
      source: "api",
    }) as AnthropicProvider;

    const finalMessage = createMockResponse([
      { type: "text", text: "ok", citations: null },
    ]);
    const stream = vi.spyOn(client.messages, "stream").mockReturnValue({
      finalMessage: () => Promise.resolve(finalMessage),
    } as unknown as ReturnType<typeof client.messages.stream>);
    const create = vi.spyOn(client.messages, "create");

    const response = await anthropicAdapterFactory.execute(
      client,
      createMockRequest([{ role: "user", content: "hi" }], {
        model: "claude-opus-4-20250514",
        max_tokens: 64000,
      }),
    );

    // Routed to streaming (max_tokens=64000 > the ~21k non-streaming limit),
    // never the non-streaming path.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(response.content[0]).toMatchObject({ type: "text", text: "ok" });
  });
});

describe("anthropicAdapterFactory balance-too-low message", () => {
  // The SDK nests the provider body as error.error.{type,message}.
  function sdkError(
    status: number,
    type: string,
    message: string,
  ): { status: number; error: { error: { type: string; message: string } } } {
    return { status, error: { error: { type, message } } };
  }

  test("returns one unified message for both out-of-credit and usage-limit blocks", () => {
    const creditError = sdkError(
      402,
      "billing_error",
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    );
    // A usage/spend cap: HTTP 400 with a non-standard `api_validation_error`
    // type, so it's detected off the body message.
    const limitError = sdkError(
      400,
      "api_validation_error",
      "You have reached your specified API usage limits.",
    );

    for (const error of [creditError, limitError]) {
      expect(anthropicAdapterFactory.extractInternalCode(error)).toBe(
        ArchestraInternalErrorCode.ProviderInsufficientBalance,
      );
    }

    const creditMessage =
      anthropicAdapterFactory.extractErrorMessage(creditError);
    const limitMessage =
      anthropicAdapterFactory.extractErrorMessage(limitError);

    // Same message for both; no Anthropic raw text / Console steering.
    expect(creditMessage).toBe(limitMessage);
    expect(creditMessage).toMatch(/remaining usage balance is too low/i);
    expect(creditMessage).toMatch(/please contact your administrator/i);
    expect(creditMessage).not.toMatch(/Plans & Billing/i);
  });

  test("does not flag an ordinary error, relays its message verbatim", () => {
    const error = sdkError(
      400,
      "invalid_request_error",
      'messages: roles must alternate between "user" and "assistant"',
    );
    expect(anthropicAdapterFactory.extractInternalCode(error)).toBeUndefined();
    expect(anthropicAdapterFactory.extractErrorMessage(error)).toContain(
      "roles must alternate",
    );
  });
});

describe("anthropicAdapterFactory.execute - long-request routing", () => {
  const messages = [
    { role: "user", content: "hi" },
  ] as Anthropic.Types.MessagesRequest["messages"];

  test("routes to non-streaming create() when the request fits the non-streaming limit", async () => {
    const response = createMockResponse([{ type: "text", text: "ok" }]);
    const create = vi.fn().mockResolvedValue(response);
    const stream = vi.fn();
    // The SDK guard returns a timeout (does not throw) → request fits.
    const calculateNonstreamingTimeout = vi.fn().mockReturnValue(600000);
    const client = {
      calculateNonstreamingTimeout,
      messages: { create, stream },
    };

    const result = await anthropicAdapterFactory.execute(
      client,
      createMockRequest(messages, { max_tokens: 1024 }),
    );

    expect(result).toBe(response);
    expect(create).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
    // The routing decision is keyed on the request's own max_tokens.
    expect(calculateNonstreamingTimeout).toHaveBeenCalledWith(1024);
  });

  test("routes to the streaming API and returns the final message when the request is too long for non-streaming", async () => {
    const response = createMockResponse([{ type: "text", text: "done" }]);
    const create = vi.fn();
    const finalMessage = vi.fn().mockResolvedValue(response);
    const stream = vi.fn().mockReturnValue({ finalMessage });
    // The SDK guard throws → max_tokens implies a >10-minute completion.
    const calculateNonstreamingTimeout = vi.fn(() => {
      throw new Error(
        "Streaming is required for operations that may take longer than 10 minutes",
      );
    });
    const client = {
      calculateNonstreamingTimeout,
      messages: { create, stream },
    };

    const result = await anthropicAdapterFactory.execute(
      client,
      createMockRequest(messages, { max_tokens: 64000 }),
    );

    // Same shape a non-streaming create() would have returned.
    expect(result).toBe(response);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(finalMessage).toHaveBeenCalledTimes(1);
    // The non-streaming path is skipped entirely for long requests.
    expect(create).not.toHaveBeenCalled();
  });
});

describe("anthropicAdapterFactory - unsupported sampling params", () => {
  const messages = [
    { role: "user", content: "hi" },
  ] as Anthropic.Types.MessagesRequest["messages"];

  // Shape of the Anthropic 400 for a model that rejects a sampling param.
  function deprecatedTemperatureError() {
    return new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."},"request_id":"req_x"}',
    );
  }

  test("execute strips the rejected param and retries once, preserving others", async () => {
    const response = createMockResponse([{ type: "text", text: "ok" }]);
    const create = vi
      .fn()
      .mockRejectedValueOnce(deprecatedTemperatureError())
      .mockResolvedValueOnce(response);
    const client = { messages: { create } };

    const result = await anthropicAdapterFactory.execute(
      client,
      createMockRequest(messages, { temperature: 0.7, top_p: 0.9 }),
    );

    expect(result).toBe(response);
    expect(create).toHaveBeenCalledTimes(2);
    // First attempt carried temperature; the retry dropped it.
    expect(create.mock.calls[0][0]).toMatchObject({ temperature: 0.7 });
    expect(create.mock.calls[1][0]).not.toHaveProperty("temperature");
    // top_p wasn't named in the error, so it survives the retry.
    expect(create.mock.calls[1][0]).toMatchObject({ top_p: 0.9 });
  });

  test("execute does not retry when the rejected param wasn't set", async () => {
    const create = vi.fn().mockRejectedValue(deprecatedTemperatureError());
    const client = { messages: { create } };

    await expect(
      anthropicAdapterFactory.execute(client, createMockRequest(messages)),
    ).rejects.toThrow("temperature");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("execute rethrows unrelated errors without retrying", async () => {
    const create = vi.fn().mockRejectedValue(new Error("overloaded_error"));
    const client = { messages: { create } };

    await expect(
      anthropicAdapterFactory.execute(
        client,
        createMockRequest(messages, { temperature: 0.5 }),
      ),
    ).rejects.toThrow("overloaded_error");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("executeStream applies the same fallback and keeps stream: true", async () => {
    async function* emptyStream(): AsyncGenerator<never> {}
    const create = vi
      .fn()
      .mockRejectedValueOnce(deprecatedTemperatureError())
      .mockResolvedValueOnce(emptyStream());
    const client = { messages: { create } };

    await anthropicAdapterFactory.executeStream(
      client,
      createMockRequest(messages, { temperature: 0.7 }),
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("temperature");
    expect(create.mock.calls[1][0]).toMatchObject({ stream: true });
  });
});
