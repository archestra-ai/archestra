import { describe, expect, test, vi } from "vitest";
import { unwrapCompactionCarriersFromRequest } from "@/openappa/compaction-carrier";
import { CommonToolCallSchema, type OpenAi } from "@/types";
import {
  openAiResponsesAdapterFactory,
  openAiResponsesCompactAdapterFactory,
} from "./openai-responses";
import { responsesToOpenaiChat } from "./openai-responses-translator";

describe("CommonToolCallSchema", () => {
  test("requires a string input for discriminated custom calls", () => {
    const base = { id: "call_1", name: "apply_patch" };

    expect(
      CommonToolCallSchema.safeParse({
        ...base,
        kind: "custom",
        arguments: { input: "*** Begin Patch" },
      }).success,
    ).toBe(true);
    expect(
      CommonToolCallSchema.safeParse({
        ...base,
        kind: "custom",
        arguments: { input: 42 },
      }).success,
    ).toBe(false);
    expect(
      CommonToolCallSchema.safeParse({
        ...base,
        kind: "custom",
        arguments: {},
      }).success,
    ).toBe(false);
    expect(
      CommonToolCallSchema.safeParse({
        ...base,
        kind: "custom",
        arguments: { input: "*** Begin Patch", arbitrary: true },
      }).success,
    ).toBe(false);
    // Existing adapters that predate the explicit variant remain function calls.
    expect(
      CommonToolCallSchema.safeParse({ ...base, arguments: {} }).success,
    ).toBe(true);
  });
});

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

describe("OpenAI Responses compaction", () => {
  const proof =
    "started subagent ABC-1234\n[appa] child trajectory appact2-c2lnbmVk.cafebabe.";

  test("wraps the done item and completed output with the same opaque context", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.setCompactionContext?.(proof);
    const item = {
      id: "cmp_1",
      type: "compaction" as const,
      encrypted_content: "opaque-provider-ciphertext",
    };
    const done = adapter.processChunk({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item,
    });
    const completed = adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_compact",
        object: "response",
        created_at: 1,
        model: "gpt-5.6-sol",
        output: [item],
        status: "completed",
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3,
        },
      } as never,
    });

    const doneFrame = parseSse(done.sseData) as { item: typeof item };
    const completedFrame = parseSse(completed.sseData) as {
      response: { output: Array<typeof item> };
    };
    const doneRequest = { input: [doneFrame.item] };
    const completedRequest = { input: [completedFrame.response.output[0]] };
    const recordedRequest = { input: [adapter.toProviderResponse().output[0]] };
    expect(unwrapCompactionCarriersFromRequest(doneRequest)).toEqual([proof]);
    expect(unwrapCompactionCarriersFromRequest(completedRequest)).toEqual([
      proof,
    ]);
    expect(unwrapCompactionCarriersFromRequest(recordedRequest)).toEqual([]);
    expect(doneRequest.input[0]).toEqual(item);
    expect(completedRequest.input[0]).toEqual(item);
    expect(recordedRequest.input[0]).toEqual(item);
    expect(adapter.state.text).toBe("");
  });

  test("calls the SDK compact method with only supported request fields", async () => {
    const response = {
      id: "resp_compact",
      object: "response.compaction" as const,
      created_at: 1,
      output: [],
      usage: {
        input_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 3,
      },
    };
    const compact = vi.fn().mockResolvedValue(response);
    const request = {
      model: "gpt-5.6-sol",
      input: "history",
      instructions: "compact",
      previous_response_id: "resp_previous",
      prompt_cache_key: "cache-key",
      stream: true,
      tools: [{ type: "function", name: "must-not-leak" }],
    } as never;

    await expect(
      openAiResponsesCompactAdapterFactory.execute(
        { responses: { compact } },
        request,
      ),
    ).resolves.toBe(response);
    expect(compact).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      input: "history",
      instructions: "compact",
      previous_response_id: "resp_previous",
      prompt_cache_key: "cache-key",
    });
  });
});

function parseSse(data: string | Uint8Array | null): unknown {
  if (data === null) throw new Error("expected an SSE event");
  const text = typeof data === "string" ? data : Buffer.from(data).toString();
  return JSON.parse(text.replace(/^data: /, "").trim());
}

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

  // A custom tool is called with free-form text rather than JSON arguments
  // (Codex's apply_patch is one). Its output is a tool result the same way a
  // function's is, so a proxy that read only function_call_output would hand
  // the custom tool's output back to the model ungoverned.
  test("pairs a custom_tool_call_output with the custom_tool_call behind it", () => {
    const request = {
      model: "gpt-5.3-codex",
      input: [
        { role: "user", content: [{ type: "input_text", text: "patch it" }] },
        {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "call_patch",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_patch",
          output: "raw patch result",
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const adapter = openAiResponsesAdapterFactory.createRequestAdapter(request);

    expect(adapter.getToolResults()).toEqual([
      {
        id: "call_patch",
        name: "apply_patch",
        arguments: { input: "*** Begin Patch" },
        content: "raw patch result",
        isError: false,
      },
    ]);
    expect(adapter.getMessages()).toContainEqual({
      role: "tool",
      content: "raw patch result",
      toolCalls: [
        {
          id: "call_patch",
          name: "apply_patch",
          arguments: { input: "*** Begin Patch" },
          content: "raw patch result",
          isError: false,
        },
      ],
    });
  });

  // Codex calls a namespaced tool by its bare name and names the namespace
  // beside it; the pair is the tool's identity, so trusted-data evaluation
  // and the plugins must see both.
  test("carries the namespace a paired history call named", () => {
    const request = {
      model: "gpt-5.5",
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
    } as unknown as OpenAi.Types.ResponsesRequest;

    const adapter = openAiResponsesAdapterFactory.createRequestAdapter(request);
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

  // A sanitizer that reduces sensitive output to nothing HAS replaced it.
  // Treating the empty string as "no replacement" forwards the original,
  // handing the model exactly what was withheld.
  test("an approved replacement of the empty string still replaces the output", () => {
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
          output: "SECRET",
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const adapter = openAiResponsesAdapterFactory.createRequestAdapter(request);
    adapter.applyToolResultUpdates({ call_1: "" });

    const forwarded = adapter.toProviderRequest();

    expect(JSON.stringify(forwarded)).not.toContain("SECRET");
    expect(
      (forwarded.input as Array<{ type?: string; output?: unknown }>).find(
        (item) => item.type === "function_call_output",
      ),
    ).toMatchObject({ call_id: "call_1", output: "" });
  });

  test("a custom_tool_call_output is replaced too", () => {
    const request = {
      model: "gpt-5.3-codex",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_patch",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_patch",
          output: "SECRET",
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const adapter = openAiResponsesAdapterFactory.createRequestAdapter(request);
    adapter.applyToolResultUpdates({ call_patch: "sanitized patch result" });

    const forwarded = adapter.toProviderRequest();

    expect(JSON.stringify(forwarded)).not.toContain("SECRET");
    expect(
      (forwarded.input as Array<{ type?: string; output?: unknown }>).find(
        (item) => item.type === "custom_tool_call_output",
      ),
    ).toMatchObject({ output: "sanitized patch result" });
  });
});

describe("OpenAiResponsesResponseAdapter.getToolCalls", () => {
  // A custom tool call is still a call this proxy releases or refuses. Reading
  // only function_call items would let one past policy entirely.
  test("extracts a custom_tool_call, carrying its free-form input as the one argument", () => {
    const adapter = openAiResponsesAdapterFactory.createResponseAdapter({
      id: "resp_1",
      object: "response",
      created_at: 0,
      model: "gpt-5.3-codex",
      status: "completed",
      output: [
        {
          id: "ctc_1",
          call_id: "call_patch",
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch",
          status: "completed",
        },
        {
          id: "fc_1",
          call_id: "call_read",
          type: "function_call",
          name: "read_file",
          arguments: '{"path":"/tmp/x"}',
          status: "completed",
          // Codex declares some tools in namespaces; the call names its own.
          namespace: "functions",
        },
      ],
    } as never);

    expect(adapter.getToolCalls()).toEqual([
      {
        id: "call_patch",
        name: "apply_patch",
        arguments: { input: "*** Begin Patch" },
        kind: "custom",
      },
      {
        id: "call_read",
        name: "read_file",
        arguments: { path: "/tmp/x" },
        kind: "function",
        namespace: "functions",
      },
    ]);
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

  test("keeps the namespace a streamed call names, for the plugins that record it", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "fc_1",
        call_id: "call_spawn",
        type: "function_call",
        name: "spawn_agent",
        arguments: "",
        status: "in_progress",
        namespace: "multi_agent_v1",
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(adapter.state.toolCalls).toEqual([
      {
        id: "call_spawn",
        name: "spawn_agent",
        arguments: "",
        namespace: "multi_agent_v1",
      },
    ]);
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

  test("omits a filtered call from the final completion while preserving a released sibling", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const allowed = {
      id: "call_read",
      name: "read",
      arguments: '{"path":"README.md"}',
      namespace: "functions",
    };
    const filtered = {
      id: "call_foreign",
      name: "archestra__execute_remedy_plan",
      arguments: '{"offer_id":"foreign"}',
      namespace: "mcp__foreign",
    };
    const output = [
      {
        id: "fc_read",
        call_id: allowed.id,
        type: "function_call",
        name: allowed.name,
        namespace: allowed.namespace,
        arguments: allowed.arguments,
        status: "completed",
      },
      {
        id: "fc_foreign",
        call_id: filtered.id,
        type: "function_call",
        name: filtered.name,
        namespace: filtered.namespace,
        arguments: filtered.arguments,
        status: "completed",
      },
    ];

    adapter.processChunk({
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp_mixed",
        object: "response",
        status: "completed",
        model: "gpt-5.3-codex",
        output,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    const frames = adapter.formatToolCallsSSE?.([allowed]) ?? [];
    const response = adapter.toProviderResponse();

    expect(response.output).toHaveLength(1);
    expect(response.output[0]).toMatchObject({
      call_id: allowed.id,
      name: allowed.name,
      namespace: allowed.namespace,
    });
    expect(response.output).not.toContainEqual(
      expect.objectContaining({ call_id: filtered.id }),
    );
    expect(response.usage).toMatchObject({ total_tokens: 5 });
    const terminalFrame = frames.at(-1);
    if (!terminalFrame) throw new Error("expected final completion frame");
    const terminalText =
      typeof terminalFrame === "string"
        ? terminalFrame
        : new TextDecoder().decode(terminalFrame);
    const completion = JSON.parse(terminalText.replace(/^data: /, "")) as {
      response: { output: unknown };
    };
    expect(completion.response.output).toEqual(response.output);
  });
});

describe("OpenAiResponsesStreamAdapter hosted tool calls", () => {
  type Chunk = Parameters<
    ReturnType<
      typeof openAiResponsesAdapterFactory.createStreamAdapter
    >["processChunk"]
  >[0];
  const searchItem = {
    id: "ws_1",
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "latest rust" },
  };
  const answerItem = {
    id: "msg_2",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Rust 1.98", annotations: [] }],
  };
  const turn = [
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "Let me look. ",
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 2,
      item: { ...searchItem, status: "in_progress" },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 3,
      item: searchItem,
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_2",
      output_index: 2,
      content_index: 0,
      sequence_number: 4,
      delta: "Rust 1.98",
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      sequence_number: 5,
      item: answerItem,
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: {
        id: "resp_search",
        object: "response",
        status: "completed",
        model: "gpt-5.2",
        output: [
          { id: "msg_1", type: "message", role: "assistant", content: [] },
          searchItem,
          answerItem,
        ],
      },
    },
  ] as unknown as Chunk[];
  const frameTypes = (frames: (string | Uint8Array)[]) =>
    frames.map(
      (frame) => JSON.parse(String(frame).replace(/^data: /, "")).type,
    );

  test("forwards a search-backed turn as it arrives when nothing rules on it", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();

    const forwarded = turn.map(
      (chunk) => adapter.processChunk(chunk).sseData !== null,
    );

    expect(forwarded).toEqual(turn.map(() => true));
    expect(adapter.getHostedToolCalls?.()).toEqual([]);
  });

  test("withholds everything from the search on, and releases it in order", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.withholdHostedToolCalls?.();

    const forwarded = turn.map(
      (chunk) => adapter.processChunk(chunk).sseData !== null,
    );

    expect(forwarded).toEqual([true, false, false, false, false, false]);
    expect(adapter.getHostedToolCalls?.()).toEqual([
      {
        id: "ws_1",
        name: "web_search",
        arguments: searchItem.action,
        output: JSON.stringify([searchItem, answerItem]),
      },
    ]);
    expect(frameTypes(adapter.getRawToolCallEvents())).toEqual(
      turn.slice(1).map((chunk) => chunk.type),
    );
  });

  test("a held turn reaches the client as the notice, without what the search brought in", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.withholdHostedToolCalls?.();
    for (const chunk of turn) adapter.processChunk(chunk);
    const notice = {
      id: "ws_1",
      name: "archestra__get_remedy_plans",
      arguments: "{}",
    };

    const frames = adapter.formatHeldHostedToolCallsSSE?.([notice]) ?? [];

    expect(frameTypes(frames).at(-1)).toBe("response.completed");
    const output = adapter.toProviderResponse().output;
    expect(output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
    ]);
    expect(output[1]).toMatchObject({
      call_id: "ws_1",
      name: "archestra__get_remedy_plans",
    });
    expect(adapter.state.text).toBe("Let me look. ");
    expect(adapter.state.toolCalls).toEqual([notice]);
  });
});
