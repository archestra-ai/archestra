import { describe, expect, test, vi } from "vitest";
import { unwrapCompactionCarriersFromRequest } from "@/openappa/compaction-carrier";
import { CommonToolCallSchema, type OpenAi } from "@/types";
import { ResponsesRequestSchema } from "@/types/llm-providers/openai/api";
import {
  discardUnadmittedResponsesOutput,
  openAiResponsesAdapterFactory,
  openAiResponsesCompactAdapterFactory,
  ResponsesStreamIncompleteError,
} from "./openai-responses";
import { responsesToOpenaiChat } from "./openai-responses-translator";
import { perplexityResponsesAdapterFactory } from "./perplexity-responses";

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

describe("failed final Responses hosted snapshots", () => {
  test.each([
    "failed",
    "incomplete",
  ] as const)("drops ambiguous pre-created message snapshots for %s", (status) => {
    const response: OpenAi.Types.ResponsesResponse = {
      id: "resp_held",
      object: "response",
      created_at: 1,
      model: "model",
      status,
      output_text: "Progress. UNADMITTED_SAME_MESSAGE_CONTINUATION",
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      error:
        status === "failed"
          ? { code: "server_error", message: "upstream failed" }
          : null,
      incomplete_details:
        status === "incomplete" ? { reason: "max_output_tokens" } : null,
      usage: {
        input_tokens: 3,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 5,
      },
      output: [
        {
          id: "message-before-search",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Progress. UNADMITTED_SAME_MESSAGE_CONTINUATION",
              annotations: [],
            },
          ],
        },
        {
          id: "search",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "unadmitted source" },
        },
      ],
    };
    const safe = discardUnadmittedResponsesOutput(response);
    expect(safe).toEqual({ ...response, output: [], output_text: "" });
    expect(JSON.stringify(safe)).not.toContain("UNADMITTED");
    expect(response.output).toHaveLength(2);
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

describe("OpenAI Responses execution terminal guard", () => {
  test.each([
    false,
    true,
  ])("rejects clean EOF without a terminal (partial=%s)", async (partial) => {
    const chunks: OpenAi.Types.ResponseChunk[] = partial
      ? [
          {
            type: "response.output_text.delta",
            item_id: "msg_partial",
            output_index: 0,
            content_index: 0,
            sequence_number: 1,
            delta: "Partial answer",
          } as never,
        ]
      : [];
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    }));
    const stream = await openAiResponsesAdapterFactory.executeStream(
      { responses: { create } },
      { model: "test-model", input: "Test" },
    );
    const received: OpenAi.Types.ResponseChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of stream) received.push(chunk);
      })(),
    ).rejects.toBeInstanceOf(ResponsesStreamIncompleteError);
    expect(received).toEqual(chunks);
    expect(create).toHaveBeenCalledOnce();
  });

  test.each([
    "completed",
    "failed",
    "incomplete",
  ] as const)("preserves a genuine %s terminal, including compaction output", async (status) => {
    const terminal = {
      type: `response.${status}`,
      sequence_number: 1,
      response: {
        id: "resp_terminal",
        model: "test-model",
        status,
        output:
          status === "completed"
            ? [
                {
                  type: "compaction",
                  id: "cmp_1",
                  encrypted_content: "fixture",
                },
              ]
            : [],
      },
    } as never;
    const stream = await openAiResponsesAdapterFactory.executeStream(
      {
        responses: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              yield terminal;
            },
          }),
        },
      },
      { model: "test-model", input: "Test" },
    );
    const received: OpenAi.Types.ResponseChunk[] = [];
    for await (const chunk of stream) received.push(chunk);
    expect(received).toEqual([terminal]);
  });

  test("does not reclassify upstream iterator errors or impose the guard on aliases", async () => {
    const originalError = new Error("Provider connection failed");
    const throwingClient = {
      responses: {
        create: async () => ({
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw originalError;
              },
            };
          },
        }),
      },
    };
    const stream = await openAiResponsesAdapterFactory.executeStream(
      throwingClient,
      { model: "test-model", input: "Test" },
    );
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          throw new Error("Unexpected provider output");
        }
      })(),
    ).rejects.toBe(originalError);
    const alias = {
      ...openAiResponsesAdapterFactory,
      provider: "github-copilot" as const,
    };
    const empty = await alias.executeStream(
      {
        responses: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {},
          }),
        },
      },
      { model: "test-model", input: "Test" },
    );
    const received: OpenAi.Types.ResponseChunk[] = [];
    for await (const chunk of empty) received.push(chunk);
    expect(received).toEqual([]);
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
  test.each([
    ["true", { is_error: true }, true],
    ["false", { is_error: false }, false],
    ["absent", {}, false],
    ["string true", { is_error: "true" }, false],
    ["string false", { is_error: "false" }, false],
    ["number", { is_error: 1 }, false],
    ["null", { is_error: null }, false],
    ["object", { is_error: { value: true } }, false],
  ] as const)("reads only boolean compatible status (%s), preserving it through rewrites", (_label, extension, isError) => {
    for (const type of [
      "function_call_output",
      "custom_tool_call_output",
    ] as const) {
      const output = {
        type,
        call_id: "call_status",
        output: '{"is_error":true,"error":"untrusted body is not status"}\r\n',
        ...extension,
        transport_extra: { opaque: "keep exactly" },
      };
      // The wire schema accepts extensions without coercing or rejecting them.
      const request = ResponsesRequestSchema.parse({
        model: "test-model",
        input: [
          type === "function_call_output"
            ? {
                type: "function_call",
                call_id: output.call_id,
                name: "tool",
                arguments: "{}",
              }
            : {
                type: "custom_tool_call",
                call_id: output.call_id,
                name: "tool",
                input: "exact custom input\r\n",
              },
          output,
        ],
      }) as unknown as OpenAi.Types.ResponsesRequest;
      for (const factory of [
        openAiResponsesAdapterFactory,
        openAiResponsesCompactAdapterFactory,
      ]) {
        const adapter = factory.createRequestAdapter(request);
        expect(adapter.getToolResults()[0]).toMatchObject({
          id: output.call_id,
          content: output.output,
          isError,
        });
        expect(adapter.getMessages()[0].toolCalls?.[0]).toMatchObject({
          id: output.call_id,
          content: output.output,
          isError,
        });
        expect(adapter.toProviderRequest().input).toEqual(request.input);
        adapter.applyToolResultUpdates({ [output.call_id]: "approved\r\n" });
        const rewritten = adapter.toProviderRequest();
        expect(rewritten.input).toEqual([
          (request.input as unknown[])[0],
          { ...output, output: "approved\r\n" },
        ]);
        // Reading a rewritten/remapped request must retain the transport status.
        const remapped = factory.createRequestAdapter(
          rewritten as OpenAi.Types.ResponsesRequest,
        );
        expect(remapped.getToolResults()[0].isError).toBe(isError);
        expect(remapped.getMessages()[0].toolCalls?.[0].isError).toBe(isError);
        expect(request.input).toEqual([
          (request.input as unknown[])[0],
          output,
        ]);
      }
    }
  });

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

describe("OpenAiResponsesResponseAdapter.withReplacedText", () => {
  // The wire/SDK convenience string `output_text` aggregates the raw output
  // text at the top level; replacing `output` while spreading the original
  // response would leave the withheld text readable there.
  test("replaces the top-level output_text convenience string along with output", () => {
    const rawText = "withheld raw text";
    const adapter = openAiResponsesAdapterFactory.createResponseAdapter({
      id: "resp_1",
      object: "response",
      created_at: 0,
      model: "gpt-5.3-codex",
      status: "completed",
      output_text: rawText,
      output: [
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: rawText, annotations: [] }],
        },
      ],
    } as never);

    const replaced = adapter.withReplacedText?.("approved replacement") as
      | { output_text?: string }
      | undefined;

    expect(replaced?.output_text).toBe("approved replacement");
    expect(JSON.stringify(replaced)).not.toContain(rawText);
  });
});

describe("OpenAiResponsesStreamAdapter.toProviderResponse", () => {
  test.each([
    "incomplete",
    "failed",
  ] as const)("formatToolCallsSSE([]) removes executable fragments without changing a %s terminal", (status) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const reasoning = { id: "rs_kept", type: "reasoning", summary: [] };
    const call = {
      id: "fc_partial",
      type: "function_call",
      call_id: "partial_call",
      name: "read",
      arguments: '{"path":',
      status: "incomplete",
    };
    const custom = {
      id: "ct_partial",
      type: "custom_tool_call",
      call_id: "partial_custom",
      name: "apply_patch",
      input: "*** Begin Patch",
      status: "incomplete",
    };
    for (const [output_index, item] of [reasoning, call, custom].entries()) {
      adapter.processChunk({
        type: "response.output_item.added",
        sequence_number: output_index * 2,
        output_index,
        item,
      } as never);
      adapter.processChunk({
        type: "response.output_item.done",
        sequence_number: output_index * 2 + 1,
        output_index,
        item,
      } as never);
    }
    const response = {
      id: "resp_no_dispatch",
      object: "response",
      created_at: 123,
      model: "test-model",
      status,
      // Missing non-tool items must be recovered even from nonempty output.
      output: [call, custom],
      error:
        status === "failed"
          ? { code: "server_error", message: "Failed" }
          : null,
      incomplete_details:
        status === "incomplete" ? { reason: "max_messages" } : null,
      usage: null,
    };
    const terminal = adapter.processChunk({
      type: `response.${status}`,
      sequence_number: 6,
      response,
    } as never);
    expect(terminal).toMatchObject({ sseData: null, isFinal: true });
    const frames = adapter.formatToolCallsSSE?.([]) ?? [];
    expect(frames.map((frame) => parseSse(frame))).toEqual([
      expect.objectContaining({
        type: `response.${status}`,
        response: { ...response, output: [reasoning] },
      }),
    ]);
    expect(adapter.toProviderResponse()).toEqual({
      ...response,
      output: [reasoning],
    });
    expect(adapter.state.toolCalls).toEqual([]);
    expect(adapter.getRawToolCallEvents()).toEqual([]);

    // With only calls in the output, an empty rewrite must stay empty on read.
    const onlyCalls = openAiResponsesAdapterFactory.createStreamAdapter();
    onlyCalls.processChunk({
      type: "response.output_item.added",
      sequence_number: 0,
      output_index: 0,
      item: call,
    } as never);
    onlyCalls.processChunk({
      type: "response.output_item.done",
      sequence_number: 1,
      output_index: 0,
      item: call,
    } as never);
    onlyCalls.processChunk({
      type: `response.${status}`,
      sequence_number: 2,
      response: { ...response, output: [] },
    } as never);
    onlyCalls.formatToolCallsSSE?.([]);
    expect(onlyCalls.toProviderResponse()).toEqual({ ...response, output: [] });
  });

  test("preserves a failed terminal with null usage rather than inventing completion", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const response = {
      id: "resp_failure",
      object: "response",
      created_at: 123,
      model: "test-model",
      status: "failed",
      output: [],
      error: { code: "server_error", message: "Provider failed" },
      incomplete_details: null,
      usage: null,
    };
    adapter.processChunk({
      type: "response.failed",
      sequence_number: 1,
      response,
    } as never);

    expect(adapter.toProviderResponse()).toEqual(response);
    expect(adapter.state.usage).toBeNull();
  });

  test.each([
    "completed",
    "incomplete",
    "failed",
  ] as const)("preserves the %s terminal envelope and accumulated output", (status) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const reasoning = {
      id: "reasoning_1",
      type: "reasoning",
      summary: [],
    };
    adapter.processChunk({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item: reasoning,
    } as never);
    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_partial",
      output_index: 1,
      content_index: 0,
      sequence_number: 2,
      delta: "Partial answer",
    } as never);
    const response = {
      id: "resp_terminal",
      object: "response",
      created_at: 123,
      model: "test-model",
      status,
      output: [],
      incomplete_details:
        status === "incomplete" ? { reason: "max_messages" } : null,
      error:
        status === "failed"
          ? { code: "server_error", message: "Provider failed" }
          : null,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 17,
      },
      store: false,
    };
    const terminal = adapter.processChunk({
      type: `response.${status}`,
      sequence_number: 3,
      response,
    } as never);

    expect(terminal.isFinal).toBe(true);
    expect(
      parseSse(
        terminal.sseData ?? adapter.getRawToolCallEvents().at(-1) ?? null,
      ),
    ).toMatchObject({
      type: `response.${status}`,
      response,
    });
    expect(adapter.toProviderResponse()).toEqual({
      ...response,
      output: [
        reasoning,
        {
          id: "msg_partial",
          type: "message",
          role: "assistant",
          status: status === "completed" ? "completed" : "incomplete",
          content: [
            { type: "output_text", text: "Partial answer", annotations: [] },
          ],
        },
      ],
    });
    expect(adapter.state.stopReason).toBe(
      status === "completed"
        ? "stop"
        : status === "failed"
          ? "error"
          : "max_messages",
    );
    expect(adapter.state.usage).toMatchObject({
      inputTokens: 7,
      cacheReadTokens: 3,
      outputTokens: 7,
      reasoningTokens: 5,
    });
  });

  test.each([
    "completed",
    "incomplete",
    "failed",
  ] as const)("keeps rich %s output and terminal type during tool rewrites", (status) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const call = {
      id: "fc_1",
      call_id: "call_1",
      type: "function_call",
      name: "read",
      arguments: "{}",
      status: "completed",
    };
    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: call,
    } as never);
    const response = {
      id: "resp_tools",
      object: "response",
      created_at: 123,
      model: "test-model",
      status,
      output: [call],
      incomplete_details:
        status === "incomplete" ? { reason: "max_messages" } : null,
      error:
        status === "failed"
          ? { code: "server_error", message: "Provider failed" }
          : null,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const terminal = adapter.processChunk({
      type: `response.${status}`,
      sequence_number: 2,
      response,
    } as never);
    expect(terminal).toMatchObject({
      sseData: null,
      isToolCallChunk: true,
      isFinal: true,
    });
    expect(adapter.toProviderResponse()).toEqual(response);
    expect(parseSse(adapter.getRawToolCallEvents().at(-1) ?? null)).toEqual({
      type: `response.${status}`,
      sequence_number: 2,
      response,
    });

    const frames = adapter.formatToolCallsSSE?.([
      { id: "call_1", name: "notice", arguments: "{}" },
    ]);
    const rewritten = parseSse(frames?.at(-1) ?? null);
    expect(rewritten).toMatchObject({
      type: `response.${status}`,
      response: {
        ...response,
        output:
          status === "completed"
            ? [expect.objectContaining({ name: "notice" })]
            : [],
      },
    });
    expect(adapter.toProviderResponse()).toEqual(
      (rewritten as { response: unknown }).response,
    );
    if (status !== "completed") expect(adapter.state.toolCalls).toEqual([]);
  });

  test.each([
    "incomplete",
    "failed",
  ] as const)("an intentional policy refusal replaces %s output without retaining failure details", (status) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.processChunk({
      type: `response.${status}`,
      sequence_number: 1,
      response: {
        id: "resp_refused",
        object: "response",
        created_at: 123,
        model: "test-model",
        status,
        output: [{ type: "reasoning", id: "withheld_reasoning", summary: [] }],
        incomplete_details: { reason: "max_messages" },
        error: { code: "server_error", message: "Provider failed" },
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    } as never);
    adapter.prepareResponseReplacement?.();
    adapter.formatCompleteTextSSE("Policy refusal");
    const persisted = adapter.toProviderResponse();
    expect(persisted).toMatchObject({
      id: "resp_refused",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    expect(persisted).not.toHaveProperty("error");
    expect(persisted).not.toHaveProperty("incomplete_details");
    expect(JSON.stringify(persisted)).not.toContain("withheld_reasoning");
    expect(persisted.output[0]).toMatchObject({
      content: [expect.objectContaining({ text: "Policy refusal" })],
    });
  });

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

  test("non-streaming calls retain declared namespaces without guessing ambiguous names", () => {
    const call = {
      type: "function_call",
      id: "item-native",
      call_id: "native-call",
      name: "spawn_agent",
      arguments: '{"message":"Research"}',
    };
    const request = {
      model: "test-model",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "collaboration",
              tools: [{ type: "function", name: "spawn_agent" }],
            },
          ],
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;
    const response = {
      id: "response-native",
      model: "test-model",
      status: "completed",
      output: [call],
    } as unknown as OpenAi.Types.ResponsesResponse;
    const adapter = openAiResponsesAdapterFactory.createResponseAdapter(
      response,
      request,
    );
    expect(adapter.getToolCalls()[0]).toMatchObject({
      name: "spawn_agent",
      namespace: "collaboration",
    });
    expect(adapter.getOriginalResponse().output[0]).toMatchObject({
      namespace: "collaboration",
    });
    expect(response.output[0]).not.toHaveProperty("namespace");
    const explicit = openAiResponsesAdapterFactory.createResponseAdapter(
      {
        ...response,
        output: [{ ...call, namespace: "multi_agent_v1" }],
      } as never,
      request,
    );
    expect(explicit.getToolCalls()[0]).toMatchObject({
      namespace: "multi_agent_v1",
    });
    const ambiguous = openAiResponsesAdapterFactory.createResponseAdapter(
      response,
      {
        ...request,
        tools: [{ type: "function", name: "spawn_agent" }],
      } as never,
    );
    expect(ambiguous.getToolCalls()[0]).not.toHaveProperty("namespace");
  });

  test("stamps a unique additional_tools namespace onto a call the model left bare", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter({
      model: "gpt-6-luna",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "collaboration",
              tools: [{ type: "function", name: "spawn_agent" }],
            },
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "function", name: "exec_command" }],
            },
            {
              type: "namespace",
              name: "other",
              tools: [{ type: "function", name: "spawn_agent" }],
            },
          ],
        },
      ],
    } as never);
    // spawn_agent is declared in two namespaces, so it must not be guessed.
    // Rebuild with a unique collaboration declaration for the dispatch case.
    const dispatch = openAiResponsesAdapterFactory.createStreamAdapter({
      model: "gpt-6-luna",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "collaboration",
              description: "Tools for spawning and managing sub-agents.",
              tools: [{ type: "function", name: "spawn_agent" }],
            },
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "custom", name: "exec_command" }],
            },
          ],
        },
      ],
    } as never);

    const bareSpawn = {
      id: "fc_spawn",
      call_id: "call_spawn",
      type: "function_call",
      name: "spawn_agent",
      arguments: "",
      status: "in_progress",
    };
    dispatch.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: bareSpawn,
    } as never);
    dispatch.processChunk({
      type: "response.function_call_arguments.delta",
      item_id: "fc_spawn",
      output_index: 0,
      sequence_number: 2,
      delta: '{"message":"investigate"}',
    } as never);
    dispatch.processChunk({
      type: "response.function_call_arguments.done",
      item_id: "fc_spawn",
      output_index: 0,
      sequence_number: 3,
      name: "spawn_agent",
      arguments: '{"message":"investigate"}',
    } as never);
    dispatch.processChunk({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 4,
      item: {
        ...bareSpawn,
        arguments: '{"message":"investigate"}',
        status: "completed",
      },
    } as never);
    dispatch.processChunk({
      type: "response.completed",
      sequence_number: 5,
      response: {
        id: "resp_spawn",
        object: "response",
        status: "completed",
        model: "gpt-6-luna",
        output: [
          {
            id: "fc_spawn",
            call_id: "call_spawn",
            type: "function_call",
            name: "spawn_agent",
            arguments: '{"message":"investigate"}',
            status: "completed",
          },
        ],
      },
    } as never);

    expect(dispatch.state.toolCalls).toEqual([
      {
        id: "call_spawn",
        name: "spawn_agent",
        arguments: '{"message":"investigate"}',
        namespace: "collaboration",
      },
    ]);
    const replay = dispatch
      .getRawToolCallEvents()
      .map((frame) =>
        JSON.parse(
          (typeof frame === "string"
            ? frame
            : new TextDecoder().decode(frame)
          ).replace(/^data: /, ""),
        ),
      );
    const added = replay.find(
      (event) => event.type === "response.output_item.added",
    );
    const argumentsDone = replay.find(
      (event) => event.type === "response.function_call_arguments.done",
    );
    const itemDone = replay.find(
      (event) => event.type === "response.output_item.done",
    );
    const completed = replay.find(
      (event) => event.type === "response.completed",
    );
    expect(added.item.namespace).toBe("collaboration");
    expect(argumentsDone).not.toHaveProperty("namespace");
    expect(itemDone.item.namespace).toBe("collaboration");
    expect(completed.response.output[0].namespace).toBe("collaboration");
    expect(dispatch.toProviderResponse().output[0]).toMatchObject({
      name: "spawn_agent",
      namespace: "collaboration",
    });

    const released = (
      dispatch.formatToolCallsSSE?.(dispatch.state.toolCalls) ?? []
    ).map((frame) =>
      JSON.parse(
        (typeof frame === "string"
          ? frame
          : new TextDecoder().decode(frame)
        ).replace(/^data: /, ""),
      ),
    );
    expect(
      released.find((event) => event.type === "response.output_item.done")
        ?.item,
    ).toMatchObject({ name: "spawn_agent", namespace: "collaboration" });
    expect(
      released.find((event) => event.type === "response.completed")?.response
        .output[0],
    ).toMatchObject({ name: "spawn_agent", namespace: "collaboration" });

    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: bareSpawn,
    } as never);
    expect(adapter.state.toolCalls[0]).not.toHaveProperty("namespace");
  });

  test("keeps a namespace that arrives only on output_item.done when synthesizing the stored turn", () => {
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
      },
    } as never);
    adapter.processChunk({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 2,
      item: {
        id: "fc_1",
        call_id: "call_spawn",
        type: "function_call",
        name: "spawn_agent",
        arguments: '{"message":"go"}',
        namespace: "collaboration",
        status: "completed",
      },
    } as never);
    adapter.processChunk({
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "resp_empty",
        object: "response",
        status: "completed",
        model: "gpt-6-luna",
        output: [],
      },
    } as never);

    expect(adapter.state.toolCalls[0]).toMatchObject({
      name: "spawn_agent",
      namespace: "collaboration",
    });
    expect(adapter.toProviderResponse().output).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
      }),
    );
  });

  test.each([
    "function_call",
    "custom_tool_call",
  ])("backfills late %s identity without mutating source or retained events", (type) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const added = {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "item_late",
        call_id: "call_late",
        type,
        name: "",
        ...(type === "function_call" ? { arguments: "" } : { input: "" }),
        status: "in_progress",
      },
    };
    const done = {
      ...added,
      type: "response.output_item.done",
      sequence_number: 2,
      item: { ...added.item, status: "completed" },
    };
    const originals = structuredClone([added, done]);
    adapter.processChunk(added as never);
    adapter.processChunk(done as never);
    const retained = adapter.state.rawToolCallEvents;
    expect(retained[0]).toBe(added);
    expect(retained[1]).toBe(done);

    adapter.processChunk({
      ...done,
      sequence_number: 3,
      item: { ...done.item, name: "read_file", namespace: "functions" },
    } as never);

    expect([added, done]).toEqual(originals);
    expect(retained).toEqual(originals);
    expect(adapter.state.rawToolCallEvents).not.toBe(retained);
    expect(adapter.state.rawToolCallEvents[0]).not.toBe(added);
    expect(adapter.state.rawToolCallEvents[1]).not.toBe(done);
    const enriched = adapter
      .getRawToolCallEvents()
      .map((frame) =>
        JSON.parse(
          (typeof frame === "string"
            ? frame
            : new TextDecoder().decode(frame)
          ).replace(/^data: /, ""),
        ),
      );
    expect(enriched).toHaveLength(3);
    for (const event of enriched) {
      expect(event.item).toMatchObject({
        type,
        name: "read_file",
        namespace: "functions",
      });
    }
    expect(adapter.toProviderResponse().output[0]).toMatchObject({
      type,
      name: "read_file",
      namespace: "functions",
    });
    const events = adapter.state.rawToolCallEvents;
    adapter.processChunk(enriched[2] as never);
    expect(adapter.state.rawToolCallEvents).toBe(events);
  });

  test.each([
    undefined,
    "collaboration",
  ])("normalizes a declared qualified retry name with namespace %s", (namespace) => {
    const request = {
      model: "test-model",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "collaboration",
              tools: [{ type: "function", name: "spawn_agent" }],
            },
          ],
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;
    const item = {
      type: "function_call",
      id: "item-qualified",
      call_id: "call-qualified",
      name: "collaboration.spawn_agent",
      arguments: '{"message":"Research"}',
      ...(namespace ? { namespace } : {}),
    };
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter(request);
    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item,
    } as never);
    expect(adapter.state.toolCalls[0]).toMatchObject({
      name: "spawn_agent",
      namespace: "collaboration",
    });
    expect(adapter.state.rawToolCallEvents[0]).toMatchObject({
      item: { name: "spawn_agent", namespace: "collaboration" },
    });
    const response = {
      id: "response-qualified",
      model: "test-model",
      status: "completed",
      output: [item],
    } as never;
    expect(
      openAiResponsesAdapterFactory
        .createResponseAdapter(response, request)
        .getToolCalls()[0],
    ).toMatchObject({ name: "spawn_agent", namespace: "collaboration" });
    const flat = {
      ...request,
      tools: [{ type: "function", name: "collaboration.spawn_agent" }],
    } as never;
    expect(
      openAiResponsesAdapterFactory
        .createResponseAdapter(response, flat)
        .getToolCalls()[0],
    ).toMatchObject({ name: "collaboration.spawn_agent" });
  });

  test("does not replace a namespace the model already named", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter({
      model: "gpt-6-luna",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "collaboration",
              tools: [{ type: "function", name: "spawn_agent" }],
            },
          ],
        },
      ],
    } as never);
    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "fc_1",
        call_id: "call_spawn",
        type: "function_call",
        name: "spawn_agent",
        arguments: "{}",
        namespace: "multi_agent_v1",
        status: "in_progress",
      },
    } as never);

    expect(adapter.state.toolCalls[0]?.namespace).toBe("multi_agent_v1");
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

  test.each([
    ["full", false],
    ["empty", false],
    ["absent", false],
    ["full", true],
    ["empty", true],
    ["absent", true],
  ] as const)("held notice uses frozen pre-hosted output with %s terminal output (unfinished second=%s)", (terminalOutput, unfinishedSecond) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      for (const factory of [
        openAiResponsesAdapterFactory,
        perplexityResponsesAdapterFactory,
      ]) {
        const adapter = factory.createStreamAdapter();
        adapter.withholdHostedToolCalls?.();
        const firstText = unfinishedSecond ? "A" : "Safe before search. ";
        const safeText = unfinishedSecond ? "AB" : firstText;
        const marker = "UNADMITTED_SAME_MESSAGE_MARKER";
        const metadata = {
          id: "resp_shared_held",
          object: "response",
          model: "compatible-model",
          created_at: 123,
          metadata: { source: "compatible client" },
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        };
        adapter.processChunk({
          type: "response.created",
          sequence_number: 0,
          response: { ...metadata, status: "in_progress", output: [] },
        } as never);
        const message = {
          id: "msg_shared_held",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: `${firstText}${marker}`,
              annotations: [],
            },
          ],
        };
        adapter.processChunk({
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 1,
          item: { ...message, status: "in_progress", content: [] },
        } as never);
        const forwarded = adapter.processChunk({
          type: "response.output_text.delta",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: firstText,
          sequence_number: 2,
        } as never);
        expect(parseSse(forwarded.sseData)).toMatchObject({ delta: firstText });
        const firstDone = {
          ...message,
          content: [{ type: "output_text", text: firstText, annotations: [] }],
        };
        const secondStart = {
          ...message,
          id: "msg_unfinished",
          phase: "final_answer",
          status: "in_progress",
          content: [],
        };
        const secondDone = {
          ...secondStart,
          status: "completed",
          content: [
            { type: "output_text", text: `B${marker}`, annotations: [] },
          ],
        };
        if (unfinishedSecond) {
          adapter.processChunk({
            type: "response.output_item.done",
            output_index: 0,
            sequence_number: 3,
            item: firstDone,
          } as never);
          adapter.processChunk({
            type: "response.output_item.added",
            output_index: 1,
            sequence_number: 4,
            item: secondStart,
          } as never);
          const second = adapter.processChunk({
            type: "response.output_text.delta",
            item_id: secondStart.id,
            output_index: 1,
            content_index: 0,
            sequence_number: 5,
            delta: "B",
          } as never);
          expect(parseSse(second.sseData)).toMatchObject({ delta: "B" });
          expect(adapter.state.text).toBe("AB");
        }
        const continuedMessage = unfinishedSecond ? secondDone : message;
        const continuedIndex = unfinishedSecond ? 1 : 0;
        const hostedIndex = unfinishedSecond ? 2 : 1;
        const executable = {
          type: "function_call",
          id: "fc_unadmitted",
          call_id: "call_unadmitted",
          name: "unadmitted_tool",
          arguments: "{}",
          status: "completed",
        };
        for (const chunk of [
          {
            type: "response.output_item.added",
            output_index: hostedIndex,
            sequence_number: 6,
            item: searchItem,
          },
          {
            type: "response.output_text.delta",
            item_id: continuedMessage.id,
            output_index: continuedIndex,
            content_index: 0,
            sequence_number: 7,
            delta: marker,
          },
          {
            type: "response.output_item.done",
            output_index: continuedIndex,
            sequence_number: 8,
            item: continuedMessage,
          },
          {
            type: "response.output_item.added",
            output_index: hostedIndex + 1,
            sequence_number: 9,
            item: executable,
          },
        ]) {
          expect(adapter.processChunk(chunk as never).sseData).toBeNull();
        }
        const terminal = adapter.processChunk({
          type: "response.completed",
          sequence_number: 10,
          response: {
            ...metadata,
            status: "completed",
            output_text: `${safeText}${marker}`,
            ...(terminalOutput === "absent"
              ? {}
              : {
                  output:
                    terminalOutput === "empty"
                      ? []
                      : unfinishedSecond
                        ? [firstDone, secondDone, searchItem, executable]
                        : [message, searchItem, executable],
                }),
          },
        } as never);
        expect(terminal).toMatchObject({ sseData: null, isFinal: true });
        clock.mockReturnValue(9_000_000);
        const notice = { id: "ws_1", name: "notice", arguments: "{}" };
        const frames = adapter.formatHeldHostedToolCallsSSE?.([notice]) ?? [];
        const persisted = adapter.toProviderResponse();
        expect(persisted).toMatchObject({
          ...metadata,
          status: "completed",
          output_text: safeText,
        });
        expect(persisted.output).toEqual([
          expect.objectContaining({
            id: message.id,
            type: "message",
            content: [
              { type: "output_text", text: firstText, annotations: [] },
            ],
          }),
          ...(unfinishedSecond
            ? [
                {
                  ...secondStart,
                  content: [
                    { type: "output_text", text: "B", annotations: [] },
                  ],
                },
              ]
            : []),
          expect.objectContaining({
            type: "function_call",
            call_id: notice.id,
            name: notice.name,
          }),
        ]);
        expect(parseSse(frames.at(-1) ?? null)).toMatchObject({
          type: "response.completed",
          response: persisted,
        });
        const readback = factory.createResponseAdapter(persisted);
        expect(readback.getText()).toBe(unfinishedSecond ? "A\nB" : safeText);
        expect(readback.getToolCalls()).toEqual([
          { id: notice.id, name: notice.name, kind: "function", arguments: {} },
        ]);
        expect(frames.join("")).not.toContain(marker);
        expect(JSON.stringify(persisted)).not.toContain(marker);
        expect(frames.join("")).not.toContain("unadmitted_tool");
        expect(adapter.state.text).toBe(safeText);
        expect(adapter.state.toolCalls).toEqual([notice]);
        expect(adapter.getRawToolCallEvents()).toEqual([]);
        expect(adapter.getHostedToolCalls?.()).toEqual([]);
        expect(secondStart.content).toEqual([]);
        expect(secondStart.status).toBe("in_progress");
      }
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    ["OpenAI", openAiResponsesAdapterFactory],
    ["Perplexity compatible alias", perplexityResponsesAdapterFactory],
  ] as const)("%s preserves observed metadata before clearing a held fallback", (_provider, factory) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      for (const terminalWithoutOutput of [false, true]) {
        const adapter = factory.createStreamAdapter();
        adapter.withholdHostedToolCalls?.();
        const envelope = {
          id: "resp_observed",
          object: "response",
          created_at: 123,
          model: "compatible-model",
          metadata: { source: "compatible client" },
          reasoning: { effort: "low" },
          status: "in_progress",
          output_text: "UNADMITTED_OBSERVED_OUTPUT",
          output: [],
        };
        const preamble = adapter.processChunk({
          type: "response.created",
          sequence_number: 0,
          response: envelope,
        } as never);
        expect(parseSse(preamble.sseData)).toMatchObject({
          response: { created_at: envelope.created_at, model: envelope.model },
        });
        for (const chunk of turn.slice(0, -1)) adapter.processChunk(chunk);
        if (terminalWithoutOutput) {
          const { output: _output, ...metadata } = envelope;
          adapter.processChunk({
            type: "response.completed",
            sequence_number: 6,
            response: { ...metadata, status: "completed" },
          } as never);
        }
        clock.mockReturnValue(9_000_000);
        const notice = { id: "ws_1", name: "notice", arguments: "{}" };
        const frames = adapter.formatHeldHostedToolCallsSSE?.([notice]) ?? [];
        const response = adapter.toProviderResponse();
        expect(response).toMatchObject({
          id: envelope.id,
          created_at: envelope.created_at,
          model: envelope.model,
          metadata: envelope.metadata,
          reasoning: envelope.reasoning,
          status: "completed",
          output_text: "Let me look. ",
        });
        expect(response.output).toEqual([
          expect.objectContaining({
            type: "message",
            content: [
              { type: "output_text", text: "Let me look. ", annotations: [] },
            ],
          }),
          expect.objectContaining({
            type: "function_call",
            call_id: notice.id,
            name: notice.name,
            arguments: notice.arguments,
          }),
        ]);
        expect(parseSse(frames.at(-1) ?? null)).toMatchObject({
          type: "response.completed",
          response,
        });
        expect(JSON.stringify(response)).not.toContain("Rust 1.98");
        expect(JSON.stringify(response)).not.toContain("UNADMITTED");
        expect(adapter.state.toolCalls).toEqual([notice]);
        expect(adapter.state.text).toBe("Let me look. ");
        expect(adapter.getHostedToolCalls?.()).toEqual([]);
        expect(adapter.getRawToolCallEvents()).toEqual([]);
      }
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    "incomplete",
    "failed",
  ] as const)("preserves a withheld %s terminal unless policy explicitly replaces the turn", (status) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.withholdHostedToolCalls?.();
    for (const chunk of turn.slice(0, -1)) adapter.processChunk(chunk);
    const response = {
      id: "resp_search_failed",
      object: "response",
      created_at: 123,
      model: "test-model",
      status,
      output: [searchItem, answerItem],
      incomplete_details:
        status === "incomplete" ? { reason: "max_messages" } : null,
      error:
        status === "failed"
          ? { code: "server_error", message: "Provider failed" }
          : null,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const terminal = adapter.processChunk({
      type: `response.${status}`,
      sequence_number: 6,
      response,
    } as never);
    expect(terminal).toMatchObject({
      sseData: null,
      isToolCallChunk: true,
      isFinal: true,
    });
    expect(adapter.toProviderResponse()).toEqual(response);
    expect(
      parseSse(adapter.getRawToolCallEvents().at(-1) ?? null),
    ).toMatchObject({
      type: `response.${status}`,
      response,
    });

    const frames = adapter.formatHeldHostedToolCallsSSE?.([
      { id: "ws_1", name: "notice", arguments: "{}" },
    ]);
    const replaced = adapter.toProviderResponse();
    expect(parseSse(frames?.at(-1) ?? null)).toMatchObject({
      type: "response.completed",
      response: replaced,
    });
    expect(replaced).toMatchObject({
      id: response.id,
      status: "completed",
      error: null,
      incomplete_details: null,
      usage: response.usage,
    });
    expect(JSON.stringify(replaced)).not.toContain("Rust 1.98");
  });

  test("forwards a search-backed turn as it arrives when nothing rules on it", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();

    const forwarded = turn.map(
      (chunk) => adapter.processChunk(chunk).sseData !== null,
    );

    expect(forwarded).toEqual(turn.map(() => true));
    expect(adapter.getHostedToolCalls?.()).toEqual([]);
  });

  test.each([
    "incomplete",
    "failed",
  ] as const)("discards a hosted-derived continuation of the same pre-hosted message on %s", (status) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.withholdHostedToolCalls?.();
    const message = {
      id: "msg_shared",
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: [
        { type: "output_text", text: "Safe before search. ", annotations: [] },
      ],
    };
    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: message.content[0].text,
      sequence_number: 1,
    } as never);
    adapter.processChunk({
      type: "response.output_item.done",
      output_index: 0,
      item: message,
      sequence_number: 2,
    } as never);
    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 1,
      item: searchItem,
      sequence_number: 3,
    } as never);
    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: "UNADMITTED_SAME_MESSAGE_MARKER",
      sequence_number: 4,
    } as never);
    const response = {
      id: "resp_shared",
      object: "response",
      model: "test-model",
      created_at: 123,
      status,
      output: [
        {
          ...message,
          content: [
            {
              ...message.content[0],
              text: "Safe before search. UNADMITTED_SAME_MESSAGE_MARKER",
            },
          ],
        },
        searchItem,
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      incomplete_details:
        status === "incomplete" ? { reason: "max_messages" } : null,
      error:
        status === "failed"
          ? { code: "server_error", message: "Provider failed" }
          : null,
    };
    adapter.processChunk({
      type: `response.${status}`,
      sequence_number: 5,
      response,
    } as never);
    const frames = adapter.formatToolCallsSSE?.([]) ?? [];
    expect(frames).toHaveLength(1);
    expect(parseSse(frames[0])).toMatchObject({
      type: `response.${status}`,
      response: { ...response, output: [message] },
    });
    expect(adapter.toProviderResponse()).toMatchObject({
      ...response,
      output: [message],
    });
    expect(JSON.stringify(adapter.toProviderResponse())).not.toContain(
      "UNADMITTED_",
    );
    expect(frames.join("")).not.toContain("Rust 1.98");
    expect(adapter.state.text).toBe("Safe before search. ");
    expect(adapter.state.toolCalls).toEqual([]);
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
    const prefix = "started subagent ABC-1234";
    adapter.setTextSuffix?.(() => prefix);
    adapter.withholdHostedToolCalls?.();
    for (const chunk of turn) adapter.processChunk(chunk);
    const notice = {
      id: "ws_1",
      name: "archestra__get_remedy_plans",
      arguments: "{}",
    };

    const frames = adapter.formatHeldHostedToolCallsSSE?.([notice]) ?? [];

    expect(frameTypes(frames).at(-1)).toBe("response.completed");
    const response = adapter.toProviderResponse();
    const output = response.output;
    const completedFrame = JSON.parse(
      String(frames.at(-1)).replace(/^data: /, ""),
    ) as { response: typeof response };
    expect(completedFrame.response).toEqual(response);
    expect(JSON.stringify(completedFrame.response)).toContain(prefix);
    expect(output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
    ]);
    expect(output[1]).toMatchObject({
      call_id: "ws_1",
      name: "archestra__get_remedy_plans",
    });
    const addedFrame = frames
      .map(
        (frame) =>
          JSON.parse(String(frame).replace(/^data: /, "")) as {
            type: string;
            output_index?: number;
            item?: { id?: string };
          },
      )
      .find((frame) => frame.type === "response.output_item.added");
    expect(addedFrame?.output_index).toBe(1);
    expect(addedFrame?.item?.id).toBe(output[1]?.id);
    expect(
      openAiResponsesAdapterFactory.createResponseAdapter(response).getText(),
    ).toBe(`${prefix}\n\nLet me look. `);
    expect(adapter.state.text).toBe("Let me look. ");
    expect(adapter.state.toolCalls).toEqual([notice]);
  });

  test.each([
    "before",
    "after",
  ] as const)("retains compaction context only when observed %s the hosted call", (position) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const proof = "protected child context";
    const compaction = {
      type: "compaction",
      encrypted_content: "opaque-provider-ciphertext",
    };
    adapter.setCompactionContext?.(proof);
    adapter.withholdHostedToolCalls?.();
    if (position === "before") {
      adapter.processChunk({
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 0,
        item: compaction,
      } as unknown as Chunk);
    }
    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 1,
      item: { ...searchItem, status: "in_progress" },
    } as unknown as Chunk);
    adapter.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_search",
        object: "response",
        status: "completed",
        model: "gpt-5.2",
        output: [compaction, searchItem],
      },
    } as unknown as Chunk);

    const frames =
      adapter.formatHeldHostedToolCallsSSE?.([
        {
          id: "ws_1",
          name: "archestra__get_remedy_plans",
          arguments: "{}",
        },
      ]) ?? [];
    const completion = JSON.parse(
      String(frames.at(-1)).replace(/^data: /, ""),
    ) as { response: { output: unknown[] } };
    const clientResponse = structuredClone(completion.response);
    const recordedResponse = adapter.toProviderResponse();

    expect(
      unwrapCompactionCarriersFromRequest({ input: clientResponse.output }),
    ).toEqual(position === "before" ? [proof] : []);
    expect(clientResponse).toEqual(recordedResponse);
    if (position === "before") {
      expect(recordedResponse.output).toContainEqual(compaction);
    } else {
      expect(recordedResponse.output).not.toContainEqual(compaction);
    }
  });
});
