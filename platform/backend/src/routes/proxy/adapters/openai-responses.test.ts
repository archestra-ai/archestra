import { describe, expect, test } from "vitest";
import type { OpenAi } from "@/types";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { responsesToOpenaiChat } from "./openai-responses-translator";

describe("responsesToOpenaiChat", () => {
  test("translates AI SDK easy-input messages for the model router", () => {
    const request = {
      model: "openai:gpt-5.6-sol",
      input: [
        { role: "developer", content: "Follow repository instructions." },
        {
          role: "user",
          content: [{ type: "input_text", text: "Open the pull request." }],
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    expect(responsesToOpenaiChat(request).chatBody.messages).toEqual([
      { role: "system", content: "Follow repository instructions." },
      { role: "user", content: "Open the pull request." },
    ]);
  });
});

describe("OpenAiResponsesRequestAdapter.getMessages", () => {
  // The AI SDK emits Responses "easy input" messages: role/content with no
  // `type`. getMessages() feeds trusted-data / Dual LLM policy evaluation, so
  // dropping these would silently bypass those policies for routed chats.
  test("includes easy-input message items that omit a top-level type", () => {
    const request = {
      model: "gpt-5.5-pro",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const messages = openAiResponsesAdapterFactory
      .createRequestAdapter(request)
      .getMessages();

    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("still includes typed message items", () => {
    const request = {
      model: "gpt-5.5-pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "typed" }],
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const messages = openAiResponsesAdapterFactory
      .createRequestAdapter(request)
      .getMessages();

    expect(messages).toEqual([{ role: "user", content: "typed" }]);
  });

  // Tool results ride as function_call_output items paired to a function_call
  // by call_id. Trusted-data / Dual LLM evaluation reads CommonMessage.toolCalls,
  // so results that don't surface there silently bypass sanitization policies.
  test("surfaces function_call_output items as tool calls paired by call_id", () => {
    const request = {
      model: "gpt-5.6-sol",
      input: [
        { role: "user", content: [{ type: "input_text", text: "search it" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "duckduckgo__search",
          arguments: '{"query":"mcp security"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "raw web content",
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const messages = openAiResponsesAdapterFactory
      .createRequestAdapter(request)
      .getMessages();

    expect(messages).toEqual([
      { role: "user", content: "search it" },
      {
        role: "tool",
        content: "raw web content",
        toolCalls: [
          {
            id: "call_1",
            name: "duckduckgo__search",
            arguments: { query: "mcp security" },
            content: "raw web content",
            isError: false,
          },
        ],
      },
    ]);
  });

  test("keeps an orphaned function_call_output visible under the unknown name", () => {
    const request = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "function_call_output",
          call_id: "call_pruned",
          output: { data: "still untrusted" },
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const messages = openAiResponsesAdapterFactory
      .createRequestAdapter(request)
      .getMessages();

    expect(messages).toEqual([
      {
        role: "tool",
        content: '{"data":"still untrusted"}',
        toolCalls: [
          {
            id: "call_pruned",
            name: "unknown",
            arguments: undefined,
            content: '{"data":"still untrusted"}',
            isError: false,
          },
        ],
      },
    ]);
  });
});

describe("OpenAiResponsesResponseAdapter.getToolCalls", () => {
  test("preserves a Codex namespace for policy and APPA lookup", () => {
    const response = {
      id: "resp_native_tool",
      model: "gpt-5.6-sol",
      status: "completed",
      output: [
        {
          id: "fc_native_tool",
          type: "function_call",
          call_id: "call_native_tool",
          namespace: "functions",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } as unknown as OpenAi.Types.ResponsesResponse;

    expect(
      openAiResponsesAdapterFactory
        .createResponseAdapter(response)
        .getToolCalls(),
    ).toEqual([
      {
        id: "call_native_tool",
        name: "functions.exec_command",
        arguments: { cmd: "pwd" },
      },
    ]);
  });

  test("uses the canonical global MCP name for a namespaced Codex call", () => {
    const response = {
      id: "resp_native_mcp",
      model: "gpt-5.6-sol",
      status: "completed",
      output: [
        {
          id: "fc_native_mcp",
          type: "function_call",
          call_id: "call_native_mcp",
          namespace: "mcp__catalog",
          name: "read",
          arguments: '{"path":"README.md"}',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } as unknown as OpenAi.Types.ResponsesResponse;

    expect(
      openAiResponsesAdapterFactory
        .createResponseAdapter(response)
        .getToolCalls(),
    ).toEqual([
      {
        id: "call_native_mcp",
        name: "mcp__catalog__read",
        arguments: { path: "README.md" },
      },
    ]);
  });

  test("fails closed for provider-originated Responses MCP calls", () => {
    const requestAdapter = openAiResponsesAdapterFactory.createRequestAdapter({
      model: "gpt-5.4",
      input: "read the public source",
      tools: [
        {
          type: "mcp",
          server_label: "fixture",
          allowed_tools: ["read_source"],
        },
      ],
    } as never);
    expect(requestAdapter.getTools()).toEqual([
      { name: "mcp__fixture__read_source", inputSchema: {} },
    ]);

    const responseAdapter = openAiResponsesAdapterFactory.createResponseAdapter(
      {
        id: "resp_mcp",
        model: "gpt-5.4",
        status: "completed",
        output: [
          {
            id: "mcp_1",
            type: "mcp_call",
            server_label: "fixture",
            name: "read_source",
            arguments: '{"kind":"public"}',
            status: "completed",
          },
        ],
      } as never,
    );
    expect(() => responseAdapter.getToolCalls()).toThrow(
      "Unsupported Responses tool item",
    );
  });
});

describe("OpenAiResponsesRequestAdapter.toProviderRequest", () => {
  // Sanitized Dual LLM summaries flow back through applyToolResultUpdates and
  // must replace the raw output the upstream model would otherwise read.
  test("replaces function_call_output content for updated tool call ids", () => {
    const request = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "duckduckgo__search",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "raw web content",
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const adapter = openAiResponsesAdapterFactory.createRequestAdapter(request);
    adapter.applyToolResultUpdates({ call_1: "sanitized summary" });

    const forwarded = adapter.toProviderRequest();
    const outputs = (
      forwarded.input as Array<{ type?: string; output?: unknown }>
    ).filter((item) => item.type === "function_call_output");

    expect(outputs).toEqual([
      expect.objectContaining({
        call_id: "call_1",
        output: "sanitized summary",
      }),
    ]);
  });

  test("keeps custom calls and outputs native while exposing their result to policy", () => {
    const request = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_patch",
          namespace: "functions",
          name: "apply_patch",
          input: "*** Begin Patch",
          provider_extension: { preserve: true },
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_patch",
          output: "raw patch result",
          provider_extension: { preserve: true },
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const adapter = openAiResponsesAdapterFactory.createRequestAdapter(request);
    adapter.applyToolResultUpdates({ call_patch: "sanitized patch result" });

    expect(adapter.getMessages()).toContainEqual({
      role: "tool",
      content: "raw patch result",
      toolCalls: [
        {
          id: "call_patch",
          name: "functions.apply_patch",
          arguments: { input: "*** Begin Patch" },
          content: "raw patch result",
          isError: false,
        },
      ],
    });
    expect(adapter.toProviderRequest().input).toContainEqual({
      type: "custom_tool_call_output",
      call_id: "call_patch",
      output: "sanitized patch result",
      provider_extension: { preserve: true },
    });
  });
});

describe("OpenAiResponsesResponseAdapter custom calls", () => {
  test("rewrites a custom call without flattening its payload", () => {
    const response = {
      id: "resp_custom",
      model: "gpt-5.6-sol",
      status: "completed",
      output: [
        {
          id: "ctc_custom",
          type: "custom_tool_call",
          call_id: "call_custom",
          namespace: "functions",
          name: "apply_patch",
          input: "*** Begin Patch",
          provider_extension: { opaque: "preserved" },
        },
      ],
    } as unknown as OpenAi.Types.ResponsesResponse;

    const rewritten = openAiResponsesAdapterFactory
      .createResponseAdapter(response)
      .withRewrittenToolCalls?.([
        {
          id: "call_custom",
          name: "functions.apply_patch",
          arguments: '{"input":"rewritten patch"}',
        },
      ]);

    const adapter =
      openAiResponsesAdapterFactory.createResponseAdapter(response);
    expect(adapter.getToolCalls()).toEqual([
      {
        id: "call_custom",
        name: "functions.apply_patch",
        arguments: { input: "*** Begin Patch" },
      },
    ]);
    expect(adapter.getFinishReasons()).toEqual(["tool_calls"]);
    expect(rewritten?.output).toEqual([
      {
        id: "ctc_custom",
        type: "custom_tool_call",
        call_id: "call_custom",
        namespace: "functions",
        name: "apply_patch",
        input: "rewritten patch",
        provider_extension: { opaque: "preserved" },
      },
    ]);
  });

  test("rejects an unsupported native tool item instead of treating it as text", () => {
    const response = {
      id: "resp_unsupported",
      model: "gpt-5.6-sol",
      status: "completed",
      output: [
        {
          id: "tsc_1",
          type: "tool_search_call",
          call_id: "call_search",
          arguments: "{}",
        },
      ],
    } as unknown as OpenAi.Types.ResponsesResponse;

    expect(() =>
      openAiResponsesAdapterFactory
        .createResponseAdapter(response)
        .getToolCalls(),
    ).toThrow("cannot bypass policy");
  });
});

describe("OpenAiResponsesStreamAdapter.toProviderResponse", () => {
  // Reasoning turns (`store: false`) finish with `response.completed` carrying
  // an empty `output`, even though the text arrived in delta chunks. Persisting
  // that envelope verbatim dropped the assistant side of the interaction, so
  // LLM Logs had nothing to render for the turn.
  // A refusal appends one more output-text delta, which clients concatenate —
  // so the client holds the model's text AND the refusal. Recording the refusal
  // alone deleted the model's own answer from the turn.
  test("a refusal keeps the streamed output text", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "let me check",
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    adapter.formatCompleteTextSSE("blocked message");
    const response = adapter.toProviderResponse();

    const message = response.output.find((item) => item.type === "message");
    const firstBlock =
      message && "content" in message ? message.content[0] : undefined;
    expect(
      firstBlock && "text" in firstBlock ? firstBlock.text : undefined,
    ).toBe("let me checkblocked message");
  });

  test("restores accumulated output when the completed envelope is empty", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "Three r's.",
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-5.6",
        store: false,
        output: [],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
        },
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    const persisted = adapter.toProviderResponse();

    // The upstream envelope is kept (ids, echoed request config)...
    expect(persisted).toMatchObject({ id: "resp_1", store: false });
    // ...but the assistant turn is no longer lost.
    expect(persisted.output).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "assistant",
        content: [
          expect.objectContaining({ type: "output_text", text: "Three r's." }),
        ],
      }),
    );
  });

  test("keeps the upstream output when the completed envelope carries it", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "streamed",
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    const upstreamOutput = [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "upstream", annotations: [] }],
      },
    ];

    adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_2",
        object: "response",
        status: "completed",
        model: "gpt-5.6",
        output: upstreamOutput,
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(adapter.toProviderResponse().output).toEqual(upstreamOutput);
  });

  test("buffers completion behind tool calls until policy evaluation finishes", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "item_1",
        call_id: "call_1",
        type: "function_call",
        name: "update_plan",
        arguments: "{}",
        status: "in_progress",
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    const completed = adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_tools",
        object: "response",
        status: "completed",
        model: "gpt-5.3-codex",
        output: [
          {
            id: "item_1",
            call_id: "call_1",
            type: "function_call",
            name: "update_plan",
            arguments: "{}",
            status: "completed",
          },
        ],
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(completed).toMatchObject({
      sseData: null,
      isToolCallChunk: true,
      isFinal: true,
    });
    const released = adapter.getRawToolCallEvents().join("");
    expect(released.indexOf("response.output_item.added")).toBeLessThan(
      released.indexOf("response.completed"),
    );
  });

  test("rejects streamed provider-originated MCP calls", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const item = {
      id: "mcp_1",
      type: "mcp_call",
      server_label: "fixture",
      name: "read_source",
      arguments: '{"kind":"public"}',
      status: "in_progress",
    };
    expect(() =>
      adapter.processChunk({
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item,
      } as unknown as Parameters<typeof adapter.processChunk>[0]),
    ).toThrow("Unsupported Responses tool item");
  });

  test("holds nameless tool-search bookkeeping and rejects server execution", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const partial = adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "tool_search_1",
        call_id: "call_tool_search_1",
        type: "tool_search_call",
        arguments: { query: "filesystem" },
        status: "in_progress",
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(partial).toMatchObject({
      sseData: null,
      isToolCallChunk: true,
      isFinal: false,
    });
    expect(() =>
      adapter.processChunk({
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 2,
        item: {
          id: "tool_search_1",
          call_id: "call_tool_search_1",
          type: "tool_search_call",
          arguments: { query: "filesystem" },
          execution: "server",
          status: "completed",
        },
      } as unknown as Parameters<typeof adapter.processChunk>[0]),
    ).toThrow(
      "tool_search_call; fields: arguments,call_id,execution,id; execution: server",
    );
  });

  test("buffers terminal client tool-search bookkeeping until native issuance", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const added = adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "tool_search_1",
        call_id: "call_tool_search_1",
        type: "tool_search_call",
        arguments: { query: "filesystem" },
        execution: "client",
        status: "in_progress",
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    const done = adapter.processChunk({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 2,
      item: {
        id: "tool_search_1",
        call_id: "call_tool_search_1",
        type: "tool_search_call",
        arguments: { query: "filesystem" },
        execution: "client",
        status: "completed",
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(added.sseData).toBeNull();
    expect(done).toMatchObject({
      sseData: expect.stringContaining('"execution":"client"'),
      isToolCallChunk: true,
      isFinal: false,
    });
    expect(adapter.state.toolCalls).toEqual([]);
  });

  test("preserves actual nameless search beside reasoning and message output", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const search = {
      id: "tsc_actual_1",
      call_id: "call_actual_search_1",
      type: "tool_search_call",
      arguments: { query: "gateway tools" },
      execution: "client",
      status: "completed",
    };
    const added = adapter.processChunk({
      type: "response.output_item.added",
      output_index: 2,
      sequence_number: 2,
      item: { ...search, status: "in_progress" },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    const done = adapter.processChunk({
      type: "response.output_item.done",
      output_index: 2,
      sequence_number: 3,
      item: search,
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    const completed = adapter.processChunk({
      type: "response.completed",
      sequence_number: 4,
      response: {
        id: "resp_actual_search",
        object: "response",
        model: "gpt-5.4",
        status: "completed",
        output: [
          { id: "rs_1", type: "reasoning", summary: [] },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Searching." }],
          },
          search,
        ],
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(added.sseData).toBeNull();
    expect(done.isToolCallChunk).toBe(true);
    expect(completed).toMatchObject({ isFinal: true, isToolCallChunk: false });
    expect(adapter.state.toolCalls).toEqual([]);
    expect(adapter.toProviderResponse().output).toContainEqual(search);
  });

  test("buffers and re-emits custom calls without fabricating function frames", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const customItem = {
      id: "ctc_custom",
      type: "custom_tool_call",
      call_id: "call_custom",
      namespace: "functions",
      name: "apply_patch",
      input: "*** Begin Patch",
      provider_extension: { opaque: "preserved" },
    };

    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: customItem,
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    const completion = adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_custom",
        object: "response",
        status: "completed",
        model: "gpt-5.6",
        output: [customItem],
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(completion).toMatchObject({ sseData: null, isToolCallChunk: true });
    if (!adapter.formatToolCallsSSE) {
      throw new Error("Responses stream adapter cannot re-emit tool calls");
    }
    const released = adapter
      .formatToolCallsSSE([
        {
          id: "call_custom",
          name: "functions.apply_patch",
          arguments: '{"input":"rewritten patch"}',
        },
      ])
      .join("");

    expect(released).toContain('"type":"custom_tool_call"');
    expect(released).not.toContain("response.function_call_arguments");
    expect(released).toContain('"provider_extension":{"opaque":"preserved"}');
    expect(adapter.state.toolCalls).toEqual([
      {
        id: "call_custom",
        name: "functions.apply_patch",
        arguments: '{"input":"*** Begin Patch"}',
        originalItem: customItem,
      },
    ]);
    expect(adapter.toProviderResponse()).toMatchObject({
      status: "completed",
      output: [
        {
          ...customItem,
          input: "rewritten patch",
        },
      ],
    });
  });
});
