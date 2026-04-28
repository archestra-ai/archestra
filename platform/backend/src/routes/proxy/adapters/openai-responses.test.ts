import { describe, expect, test } from "@/test";
import { openaiAdapterFactory } from "./openai";

describe("openaiAdapterFactory (Responses API dispatch)", () => {
  // ===========================================================================
  // Request Adapter — Responses API input format
  // ===========================================================================

  test("maps tools and tool outputs from Responses API request", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"/tmp"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"value":1}',
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          strict: true,
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "hello" },
      {
        role: "tool",
        content: '{"value":1}',
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            content: { value: 1 },
            isError: false,
          },
        ],
      },
    ]);
    expect(adapter.getToolResults()).toEqual([
      {
        id: "call_1",
        name: "read_file",
        content: '{"value":1}',
        isError: false,
      },
    ]);
    expect(adapter.getTools()).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ]);
    expect(adapter.hasTools()).toBe(true);
    expect(adapter.getProviderMessages()).toEqual([]);
  });

  test("handles string input in Responses request", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: "Hello world",
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "Hello world" },
    ]);
    expect(adapter.getToolResults()).toEqual([]);
  });

  test("falls back to unknown when function_call_output has no matching function_call", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "function_call_output",
          call_id: "call_missing",
          output: '{"value":1}',
        },
      ],
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    expect(adapter.getToolResults()).toEqual([
      {
        id: "call_missing",
        name: "unknown",
        content: '{"value":1}',
        isError: false,
      },
    ]);
  });

  test("applyToonCompression is a no-op", async () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"value":1}',
        },
      ],
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    const stats = await adapter.applyToonCompression("gpt-4.1");

    expect(stats.hadToolResults).toBe(false);
    expect(stats.wasEffective).toBe(false);
    expect(stats.tokensBefore).toBe(0);
    expect(stats.tokensAfter).toBe(0);
    expect(stats.costSavings).toBe(0);
  });

  test("toProviderRequest applies tool result updates", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"/tmp"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "original output",
        },
      ],
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    adapter.applyToolResultUpdates({ call_1: "updated output" });

    const providerRequest = adapter.toProviderRequest() as unknown as {
      input: Array<{ type: string; call_id?: string; output?: string }>;
    };

    const outputItem = providerRequest.input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "call_1",
    );
    expect(outputItem?.output).toBe("updated output");
  });

  // ===========================================================================
  // Response Adapter — Responses API payload
  // ===========================================================================

  test("extracts text and tool calls from a Responses payload", () => {
    const adapter = openaiAdapterFactory.createResponseAdapter({
      id: "resp_123",
      object: "response",
      created_at: 123,
      model: "gpt-4.1",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"/tmp"}',
          status: "completed",
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createResponseAdapter
    >[0]);

    expect(adapter.getText()).toBe("Done");
    expect(adapter.getToolCalls()).toEqual([
      { id: "call_1", name: "read_file", arguments: { path: "/tmp" } },
    ]);
    expect(adapter.getUsage()).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(adapter.getFinishReasons()).toEqual(["tool_calls"]);
  });

  // ===========================================================================
  // Stream Adapter — Responses API streaming events
  // ===========================================================================

  test("processes streaming events and completes on response.completed", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter({
      model: "gpt-4.1",
      input: "test",
      instructions: "be helpful",
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createStreamAdapter
    >[0]);

    const deltaResult = adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "Hello",
      logprobs: [],
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(deltaResult.isFinal).toBe(false);
    expect(deltaResult.sseData).toContain(
      '"type":"response.output_text.delta"',
    );

    const completedResult = adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_123",
        object: "response",
        created_at: 123,
        model: "gpt-4.1",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hello", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 1,
          total_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(completedResult.isFinal).toBe(true);
    expect(adapter.state.text).toBe("Hello");
    expect(adapter.formatEndSSE()).toBe("data: [DONE]\n\n");
  });

  test("accumulates streamed function call arguments across delta events", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter({
      model: "gpt-4.1",
      input: "test",
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createStreamAdapter
    >[0]);

    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: "",
        status: "in_progress",
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    adapter.processChunk({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: '{"path',
      sequence_number: 1,
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    adapter.processChunk({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: '":"/tmp"}',
      sequence_number: 2,
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(
      (adapter.toProviderResponse() as unknown as { output: unknown[] }).output,
    ).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"/tmp"}',
      }),
    );
  });
  // Guardrail path — getMessages() must populate toolCalls so trusted-data
  // evaluation can detect untrusted context and block subsequent tool calls
  //

  test("getMessages populates toolCalls on function_call_output so trusted-data evaluation detects untrusted context", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4o",
      input: [
        { type: "message", role: "user", content: "Search for open issues." },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "search_issues",
          arguments: '{"q":"repo:acme/app is:open"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: '[{"number":1,"title":"Bug","state":"open"}]',
        },
        {
          type: "message",
          role: "user",
          content: "Now search for closed ones.",
        },
      ],
      tools: [
        {
          type: "function",
          name: "search_issues",
          description: "Search GitHub issues",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    const messages = adapter.getMessages();

    // The function_call_output message must carry toolCalls so that
    // evaluateIfContextIsTrusted finds tool results and can mark the context
    // as untrusted before checking tool invocation policies.
    const toolMessage = messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.toolCalls).toHaveLength(1);
    expect(toolMessage?.toolCalls?.[0]).toEqual({
      id: "call_abc",
      name: "search_issues",
      content: [{ number: 1, title: "Bug", state: "open" }],
      isError: false,
    });

    // function_call items are not exposed as messages
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    // user messages are preserved
    expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("getMessages resolves name as unknown when function_call_output has no matching function_call", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4o",
      input: [
        {
          type: "function_call_output",
          call_id: "call_orphan",
          output: '{"value":1}',
        },
      ],
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    const messages = adapter.getMessages();
    expect(messages[0].toolCalls?.[0].name).toBe("unknown");
    expect(messages[0].toolCalls?.[0].id).toBe("call_orphan");
  });

  // ===========================================================================
  // Factory dispatch — detects format from request shape
  // ===========================================================================

  test("routes ChatCompletions request to ChatCompletions adapter", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(adapter.getMessages()).toEqual([{ role: "user", content: "hello" }]);
    expect(Array.isArray(adapter.getProviderMessages())).toBe(true);
    expect((adapter.getProviderMessages() as unknown[]).length).toBe(1);
  });

  test("routes Responses API request to Responses adapter", () => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: "Hello",
      instructions: "Be helpful",
    } as unknown as Parameters<
      typeof openaiAdapterFactory.createRequestAdapter
    >[0]);

    expect(adapter.getMessages()).toEqual([{ role: "user", content: "Hello" }]);
    expect(adapter.getProviderMessages()).toEqual([]);
  });
});
