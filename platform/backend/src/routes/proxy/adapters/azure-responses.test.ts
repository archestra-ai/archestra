import type OpenAIProvider from "openai";
import { describe, expect, test } from "@/test";
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

    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "hello from responses" },
      { role: "tool", content: '{"value":1}' },
    ]);
    expect(adapter.getToolResults()).toEqual([
      {
        id: "call_123",
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
    });
    expect(adapter.getFinishReasons()).toEqual(["tool_calls"]);
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
});
