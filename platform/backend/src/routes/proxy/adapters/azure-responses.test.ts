import type OpenAIProvider from "openai";
import { describe, expect, test } from "vitest";
import { azureResponsesAdapterFactory } from "./azure-responses";

describe("azureResponsesAdapterFactory", () => {
  test("derives the /openai base URL for Azure responses requests", () => {
    const client = azureResponsesAdapterFactory.createClient(
      "Bearer my-azure-key",
      {
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-5.2-chat",
        defaultHeaders: {},
        source: "api",
      },
    ) as OpenAIProvider & {
      _options?: { baseURL?: string; defaultHeaders?: Record<string, string> };
    };

    expect(client._options?.baseURL).toBe(
      "https://my-resource.openai.azure.com/openai",
    );
    expect(client._options?.defaultQuery).toEqual({
      "api-version": "2025-04-01-preview",
    });
    expect(client._options?.defaultHeaders?.["api-key"]).toBe("my-azure-key");
    expect(client._options?.apiKey).toBe("my-azure-key");
  });

  test("uses Azure resource-level /openai base URLs for responses requests", () => {
    const client = azureResponsesAdapterFactory.createClient("my-azure-key", {
      baseUrl: "https://my-resource.openai.azure.com/openai",
      defaultHeaders: {},
      source: "api",
    }) as OpenAIProvider & {
      _options?: { baseURL?: string; defaultQuery?: Record<string, string> };
    };

    expect(client._options?.baseURL).toBe(
      "https://my-resource.openai.azure.com/openai",
    );
    expect(client._options?.defaultQuery).toEqual({
      "api-version": "2025-04-01-preview",
    });
  });

  test("uses Azure OpenAI v1 base URLs without api-version", () => {
    const client = azureResponsesAdapterFactory.createClient("my-azure-key", {
      baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
      defaultHeaders: {},
      source: "api",
    }) as OpenAIProvider & {
      _options?: { baseURL?: string; defaultQuery?: Record<string, string> };
    };

    expect(client._options?.baseURL).toBe(
      "https://my-resource.services.ai.azure.com/openai/v1",
    );
    expect(client._options?.defaultQuery).toBeUndefined();
  });

  test("reads messages that omit `type` (the AI SDK's easy input message shape)", () => {
    // The Responses API defaults an input item's `type` to "message", and the AI
    // SDK relies on that, sending bare `{role, content}`. Dropping those left
    // getMessages() empty, so trusted-data / Dual LLM policy evaluation ran
    // against an empty conversation instead of the user's actual prompt.
    const adapter = azureResponsesAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        { role: "user", content: "what is my account balance?" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "checking" }],
        },
      ],
    } as never);

    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "what is my account balance?" },
      { role: "assistant", content: "checking" },
    ]);
  });

  test("maps response tools and tool outputs from the request", () => {
    const adapter = azureResponsesAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello from responses" }],
        },
        {
          type: "function_call",
          id: "fc_123",
          call_id: "call_123",
          name: "read_file",
          arguments: '{"file_path":"/tmp/test"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_123",
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
            properties: {
              file_path: { type: "string" },
            },
          },
        },
      ],
    });

    const result = {
      id: "call_123",
      name: "read_file",
      arguments: { file_path: "/tmp/test" },
      content: '{"value":1}',
      isError: false,
    };
    // The output is paired with the call behind it: that is the shape
    // trusted-data / Dual LLM policy evaluation reads, and without it the
    // conversation looks tool-free to the evaluator.
    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "hello from responses" },
      { role: "tool", content: '{"value":1}', toolCalls: [result] },
    ]);
    expect(adapter.getToolResults()).toEqual([result]);
    expect(adapter.getTools()).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
        },
      },
    ]);
  });

  test("falls back to unknown when a function_call_output has no matching function_call", () => {
    const adapter = azureResponsesAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "function_call_output",
          call_id: "call_missing",
          output: '{"value":1}',
        },
      ],
    });

    expect(adapter.getToolResults()).toEqual([
      {
        id: "call_missing",
        name: "unknown",
        content: '{"value":1}',
        isError: false,
      },
    ]);
    // Still untrusted data: the default trusted-data policies apply to it.
    expect(adapter.getMessages()).toEqual([
      {
        role: "tool",
        content: '{"value":1}',
        toolCalls: [
          {
            id: "call_missing",
            name: "unknown",
            content: '{"value":1}',
            isError: false,
          },
        ],
      },
    ]);
  });

  // Codex calls a namespaced tool by its bare name and names the namespace
  // beside it; the pair is the tool's identity, so trusted-data evaluation
  // must see both.
  test("carries the namespace a paired history call named", () => {
    const adapter = azureResponsesAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "function_call",
          call_id: "call_gw",
          name: "archestra__search_tools",
          namespace: "mcp__gw",
          arguments: '{"query":"issues"}',
        },
        {
          type: "function_call_output",
          call_id: "call_gw",
          output: "matching tools",
        },
      ],
    } as never);
    const expected = {
      id: "call_gw",
      name: "archestra__search_tools",
      namespace: "mcp__gw",
      arguments: { query: "issues" },
      content: "matching tools",
      isError: false,
    };

    expect(adapter.getToolResults()).toEqual([expected]);
    expect(adapter.getMessages()).toEqual([
      { role: "tool", content: "matching tools", toolCalls: [expected] },
    ]);
  });

  test("forwards a tool result a sanitizer reduced to nothing", () => {
    const adapter = azureResponsesAdapterFactory.createRequestAdapter({
      model: "gpt-4.1",
      input: [
        {
          type: "function_call",
          call_id: "call_secret",
          name: "read_file",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_secret",
          output: "the secret",
        },
      ],
    } as never);

    adapter.applyToolResultUpdates({ call_secret: "" });

    expect(adapter.toProviderRequest().input).toContainEqual({
      type: "function_call_output",
      call_id: "call_secret",
      output: "",
    });
  });

  test("extracts text and tool calls from a responses payload", () => {
    const adapter = azureResponsesAdapterFactory.createResponseAdapter({
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
          arguments: '{"file_path":"/tmp/test"}',
          status: "completed",
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Azure responses works",
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 19,
      },
    } as unknown as Parameters<
      typeof azureResponsesAdapterFactory.createResponseAdapter
    >[0]);

    expect(adapter.getText()).toBe("Azure responses works");
    expect(adapter.getToolCalls()).toEqual([
      {
        id: "call_1",
        name: "read_file",
        arguments: { file_path: "/tmp/test" },
      },
    ]);
    expect(adapter.getUsage()).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    expect(adapter.getFinishReasons()).toEqual(["tool_calls"]);
  });

  test("replaces a non-streaming governed response with admitted text", () => {
    const adapter = azureResponsesAdapterFactory.createResponseAdapter({
      id: "resp_replace",
      object: "response",
      created_at: 123,
      model: "gpt-4.1",
      status: "completed",
      output: [
        {
          id: "msg_raw",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "RAW CHILD RETURN", annotations: [] },
          ],
        },
      ],
    } as never);

    const replaced = adapter.withReplacedText?.("ADMITTED CHILD RETURN");

    expect(replaced).toMatchObject({
      id: "resp_replace",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ADMITTED CHILD RETURN" }],
        },
      ],
    });
    expect(JSON.stringify(replaced)).not.toContain("RAW CHILD RETURN");
  });

  test("keeps the namespace a call names", () => {
    const adapter = azureResponsesAdapterFactory.createResponseAdapter({
      id: "resp_ns",
      object: "response",
      created_at: 123,
      model: "gpt-4.1",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_gw",
          name: "archestra__run_tool",
          namespace: "mcp__gw",
          arguments: '{"tool_name":"github__issue_write"}',
          status: "completed",
        },
      ],
    } as never);

    expect(adapter.getToolCalls()).toEqual([
      {
        id: "call_gw",
        name: "archestra__run_tool",
        namespace: "mcp__gw",
        arguments: { tool_name: "github__issue_write" },
      },
    ]);
  });

  test("keeps the namespace a streamed call names", () => {
    const adapter = azureResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_gw",
        name: "archestra__run_tool",
        namespace: "mcp__gw",
        arguments: "",
        status: "in_progress",
      },
    } as never);
    adapter.processChunk({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: '{"tool_name":"github__issue_write"}',
      sequence_number: 1,
    } as never);

    expect(adapter.state.toolCalls).toEqual([
      {
        id: "call_gw",
        name: "archestra__run_tool",
        namespace: "mcp__gw",
        arguments: '{"tool_name":"github__issue_write"}',
      },
    ]);
  });

  test("passes through Azure responses streaming events and completes on response.completed", () => {
    const adapter = azureResponsesAdapterFactory.createStreamAdapter();

    const delta = adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "Hello",
      logprobs: [],
    });

    expect(delta.isFinal).toBe(false);
    expect(delta.sseData).toContain('"type":"response.output_text.delta"');

    const completed = adapter.processChunk({
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
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 5,
        },
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(completed.isFinal).toBe(true);
    expect(adapter.toProviderResponse()).toMatchObject({
      id: "resp_123",
      model: "gpt-4.1",
      status: "completed",
    });
    expect(adapter.formatEndSSE()).toBe("data: [DONE]\n\n");
  });

  test("accumulates streamed function call arguments across delta events", () => {
    const adapter = azureResponsesAdapterFactory.createStreamAdapter();

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
      delta: '{"file',
      sequence_number: 1,
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    adapter.processChunk({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: '_path":"/tmp/test"}',
      sequence_number: 2,
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(adapter.toProviderResponse().output).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"file_path":"/tmp/test"}',
      }),
    );
  });

  test("omits empty assistant message from synthesized fallback response when only tool calls are present", () => {
    const adapter = azureResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_only",
        type: "function_call",
        call_id: "call_only",
        name: "read_file",
        arguments: '{"file_path":"/tmp/test"}',
        status: "in_progress",
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(adapter.toProviderResponse().output).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: "call_only",
        name: "read_file",
      }),
    ]);
  });

  test("keeps accumulated output when the completed envelope carries none", () => {
    // Reasoning turns finish with an empty `output` even though the text
    // arrived over `response.output_text.delta`. Persisting the envelope
    // verbatim dropped the whole assistant side, leaving LLM Logs with
    // "No message" to render.
    const adapter = azureResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_text.delta",
      delta: "the answer",
    } as never);
    adapter.processChunk({
      type: "response.completed",
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: "gpt-4.1",
        status: "completed",
        output: [],
      },
    } as never);

    const persisted = adapter.toProviderResponse();

    expect(persisted.id).toBe("resp_1");
    expect(persisted.output).toHaveLength(1);
    expect(JSON.stringify(persisted.output)).toContain("the answer");
  });

  test("adds the stream prefix when the completed response has no text block", () => {
    const adapter = azureResponsesAdapterFactory.createStreamAdapter();
    const prefix = "started subagent ABC-1234";
    adapter.setTextSuffix?.(() => prefix);
    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "answer",
    } as never);

    const completed = adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: "gpt-4.1",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [],
          },
        ],
      },
    } as never);
    const completion = JSON.parse(
      String(completed.sseData).replace(/^data: /, ""),
    ) as { response: { output: unknown[] } };

    expect(JSON.stringify(completion.response.output)).toContain(prefix);
    expect(completion.response.output).toHaveLength(2);
  });
});
