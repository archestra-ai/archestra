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

describe("OpenAiResponsesStreamAdapter call accumulation", () => {
  test("keeps ordered slots and exact bytes through interleaved function deltas", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const calls = adapter.state.toolCalls;
    const argumentsByCall = Array.from(
      { length: 32 },
      (_, index) => ` { "index" : ${index}, "escaped" : "\\u0041" }\n`,
    );
    for (const [index] of argumentsByCall.entries()) {
      expect(
        adapter.processChunk({
          type: "response.output_item.added",
          output_index: 31 - index,
          sequence_number: index,
          item: {
            id: `item_${index}`,
            call_id: `call_${index}`,
            type: "function_call",
            name: `tool_${index}`,
            arguments: "",
            namespace: index % 2 ? "other" : "functions",
          },
        } as never),
      ).toMatchObject({ sseData: null, isToolCallChunk: true, isFinal: false });
    }
    const slots = [...calls];
    for (let offset = 0; offset < argumentsByCall[0].length + 1; offset++) {
      for (let index = argumentsByCall.length - 1; index >= 0; index--) {
        const delta = argumentsByCall[index][offset];
        if (delta === undefined) continue;
        adapter.processChunk({
          type: "response.function_call_arguments.delta",
          item_id: `item_${index}`,
          output_index: 31 - index,
          sequence_number: offset * 32 + index + 32,
          delta,
        } as never);
      }
    }
    expect(adapter.state.toolCalls).toBe(calls);
    for (const [index, slot] of slots.entries()) {
      expect(calls[index]).toBe(slot);
      expect(slot).toMatchObject({
        id: `call_${index}`,
        arguments: argumentsByCall[index],
      });
    }
    const completed = adapter.processChunk({
      type: "response.completed",
      sequence_number: 10000,
      response: {
        id: "resp_interleaved",
        model: "test-model",
        output: [],
        provider_extension: { retained: true },
      },
    } as never);
    expect(completed).toMatchObject({
      sseData: null,
      isToolCallChunk: true,
      isFinal: true,
    });
    const response = adapter.toProviderResponse();
    expect(response).toMatchObject({ provider_extension: { retained: true } });
    expect(response.output).toEqual(
      argumentsByCall.map((argumentsText, index) =>
        expect.objectContaining({
          call_id: `call_${index}`,
          name: `tool_${index}`,
          arguments: argumentsText,
          namespace: index % 2 ? "other" : "functions",
        }),
      ),
    );
  });

  test("materializes tiny custom-input deltas only when arguments are read", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 0,
      item: {
        type: "custom_tool_call",
        id: "item_patch",
        call_id: "call_patch",
        name: "apply_patch",
        input: "prefix\n",
      },
    } as never);
    const calls = adapter.state.toolCalls;
    const call = calls[0];
    const input = '"\\\r\n\t\u0000\ud83d\ude80'.repeat(256);
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    let beforeRead = -1;
    let afterReads = -1;
    let parseCount = -1;
    let argumentsText = "";
    try {
      for (const [sequence, delta] of input.split("").entries()) {
        adapter.processChunk({
          type: "response.custom_tool_call_input.delta",
          item_id: "item_patch",
          output_index: 0,
          sequence_number: sequence + 1,
          delta,
        } as never);
      }
      beforeRead = stringify.mock.calls.length;
      argumentsText = call.arguments;
      void call.arguments;
      afterReads = stringify.mock.calls.length;
      parseCount = parse.mock.calls.length;
    } finally {
      stringify.mockRestore();
      parse.mockRestore();
    }
    expect(beforeRead).toBe(0);
    expect(afterReads).toBe(1);
    expect(parseCount).toBe(0);
    expect(adapter.state.toolCalls).toBe(calls);
    expect(calls[0]).toBe(call);
    expect(argumentsText).toBe(JSON.stringify({ input: `prefix\n${input}` }));
    expect(adapter.toProviderResponse().output[0]).toMatchObject({
      type: "custom_tool_call",
      input: `prefix\n${input}`,
    });
  });

  test.each([
    "function_call",
    "custom_tool_call",
  ])("preserves %s snapshot replacement and empty partial-done fallback", (type) => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const item = {
      id: "item_snapshot",
      call_id: "call_snapshot",
      type,
      name: "tool",
      ...(type === "function_call"
        ? { arguments: "initial" }
        : { input: "initial" }),
    };
    adapter.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item,
    } as never);
    const calls = adapter.state.toolCalls;
    const call = calls[0];
    const doneType =
      type === "function_call"
        ? "response.function_call_arguments.done"
        : "response.custom_tool_call_input.done";
    adapter.processChunk({
      type: doneType,
      item_id: item.id,
      output_index: 0,
      sequence_number: 2,
      name: "tool",
      ...(type === "function_call"
        ? { arguments: "replacement" }
        : { input: "replacement" }),
    } as never);
    expect(call.arguments).toBe(
      type === "function_call"
        ? "replacement"
        : JSON.stringify({ input: "replacement" }),
    );
    adapter.processChunk({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 3,
      item: {
        ...item,
        name: "",
        ...(type === "function_call" ? { arguments: "" } : { input: "" }),
      },
    } as never);
    expect(call.arguments).toBe(
      type === "function_call"
        ? "replacement"
        : JSON.stringify({ input: "replacement" }),
    );
    // An argument/input done snapshot is authoritative, even when empty.
    adapter.processChunk({
      type: doneType,
      item_id: item.id,
      output_index: 0,
      sequence_number: 4,
      name: "tool",
      ...(type === "function_call" ? { arguments: "" } : { input: "" }),
    } as never);
    expect(call.arguments).toBe(
      type === "function_call" ? "" : JSON.stringify({ input: "" }),
    );
    adapter.processChunk({
      type:
        type === "function_call"
          ? "response.function_call_arguments.delta"
          : "response.custom_tool_call_input.delta",
      item_id: item.id,
      output_index: 0,
      sequence_number: 5,
      delta: "tail",
    } as never);
    expect(call.arguments).toBe(
      type === "function_call" ? "tail" : JSON.stringify({ input: "tail" }),
    );
    expect(adapter.state.toolCalls).toBe(calls);
    expect(calls[0]).toBe(call);
  });

  test("backfills only indexed frames and preserves extensions and duplicate item slots", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const unrelated = {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        type: "function_call",
        id: "item_unrelated",
        call_id: "call_unrelated",
        name: "other",
        arguments: "{}",
      },
    };
    adapter.processChunk(unrelated as never);
    const readUnrelatedItem = vi.fn(() => unrelated.item);
    // A traversal of unrelated held frames is a deterministic regression,
    // without depending on timing or the engine's string representation.
    adapter.state.rawToolCallEvents[0] = {
      ...unrelated,
      get item() {
        return readUnrelatedItem();
      },
    };
    const added = {
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 2,
      provider_event_extension: "event-bytes",
      item: {
        type: "function_call",
        id: "item_late",
        call_id: "call_late",
        name: "",
        arguments: ' { "bytes" : "\\u0042" } ',
        provider_item_extension: { opaque: true },
      },
    };
    adapter.processChunk(added as never);
    const retained = adapter.state.rawToolCallEvents;
    adapter.processChunk({
      ...added,
      type: "response.output_item.done",
      sequence_number: 3,
      item: {
        ...added.item,
        name: "read_file",
        namespace: "functions",
        arguments: "",
      },
    } as never);
    expect(readUnrelatedItem).not.toHaveBeenCalled();
    expect(retained[1]).toBe(added);
    expect(added.item).not.toHaveProperty("namespace");
    expect(adapter.state.rawToolCallEvents[1]).toMatchObject({
      provider_event_extension: "event-bytes",
      item: {
        name: "read_file",
        namespace: "functions",
        arguments: added.item.arguments,
        provider_item_extension: { opaque: true },
      },
    });
    const slot = adapter.state.toolCalls[1];
    adapter.processChunk({ ...added, sequence_number: 4 } as never);
    expect(adapter.state.toolCalls).toHaveLength(2);
    expect(adapter.state.toolCalls[1]).toBe(slot);
    expect(slot).toMatchObject({
      name: "read_file",
      namespace: "functions",
      arguments: added.item.arguments,
    });
  });

  test("retains first-match custom-kind semantics for duplicate call IDs at release", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    for (const [index, type] of [
      "custom_tool_call",
      "function_call",
    ].entries()) {
      adapter.processChunk({
        type: "response.output_item.added",
        output_index: index,
        sequence_number: index,
        item: {
          type,
          id: `item_duplicate_${index}`,
          call_id: "call_duplicate",
          name: index === 0 ? "apply_patch" : "other",
          ...(index === 0 ? { input: "patch" } : { arguments: "{}" }),
        },
      } as never);
    }
    expect(adapter.state.toolCalls.map((call) => call.name)).toEqual([
      "apply_patch",
      "other",
    ]);
    // The partial completion does not carry either call, so kind selection
    // must use the first streamed duplicate rather than Map's last value.
    adapter.processChunk({
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "resp_partial_duplicates",
        model: "test-model",
        output: [
          {
            type: "reasoning",
            id: "reasoning",
            summary: [],
            provider_extension: "opaque",
          },
        ],
      },
    } as never);
    const frames = (
      adapter.formatToolCallsSSE?.([
        { id: "call_duplicate", name: "other", arguments: "{}" },
      ]) ?? []
    ).map(
      (frame) =>
        parseSse(frame) as {
          type: string;
          response?: { output: unknown[] };
        },
    );
    expect(frames.map((frame) => frame.type)).toContain(
      "response.function_call_arguments.delta",
    );
    expect(frames.map((frame) => frame.type)).not.toContain(
      "response.custom_tool_call_input.delta",
    );
    expect(frames.at(-1)?.response?.output[0]).toMatchObject({
      provider_extension: "opaque",
    });
  });

  test("uses the first rewritten duplicate for kind and the last for completion replacement", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const item = {
      type: "custom_tool_call",
      id: "item_duplicate",
      call_id: "call_duplicate",
      name: "apply_patch",
      input: "original patch\r\n",
      provider_extension: "opaque",
    };
    adapter.processChunk({
      type: "response.completed",
      sequence_number: 1,
      response: { id: "resp_duplicates", model: "test-model", output: [item] },
    } as never);
    const frames = (
      adapter.formatToolCallsSSE?.([
        { id: item.call_id, name: "notice", arguments: "{}" },
        {
          id: item.call_id,
          name: item.name,
          arguments: JSON.stringify({ input: "original patch\r\n" }),
        },
      ]) ?? []
    ).map((frame) => parseSse(frame) as { type: string });
    expect(
      frames.filter((frame) => frame.type === "response.output_item.added"),
    ).toHaveLength(2);
    expect(frames.map((frame) => frame.type)).not.toContain(
      "response.custom_tool_call_input.delta",
    );
    expect(adapter.toProviderResponse().output).toEqual([item]);
  });

  test("discards custom slots and raw inputs when a hosted turn is withheld", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    adapter.withholdHostedToolCalls?.();
    const chunks = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          id: "web_search",
          type: "web_search_call",
          status: "in_progress",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        sequence_number: 2,
        item: {
          id: "item_patch",
          call_id: "call_patch",
          type: "custom_tool_call",
          name: "apply_patch",
          input: "withheld-",
        },
      },
      {
        type: "response.custom_tool_call_input.delta",
        item_id: "item_patch",
        output_index: 1,
        sequence_number: 3,
        delta: "raw-input",
      },
      {
        type: "response.completed",
        sequence_number: 4,
        response: { id: "resp_held", model: "test-model", output: [] },
      },
    ];
    for (const chunk of chunks) {
      expect(adapter.processChunk(chunk as never).sseData).toBeNull();
    }
    const notice = { id: "web_search", name: "notice", arguments: "{}" };
    const frames = adapter.formatHeldHostedToolCallsSSE?.([notice]) ?? [];
    expect(JSON.stringify(frames)).not.toContain("withheld-");
    expect(JSON.stringify(frames)).not.toContain("raw-input");
    expect(adapter.state.toolCalls).toEqual([notice]);
    expect(adapter.getRawToolCallEvents()).toEqual([]);
    adapter.prepareResponseReplacement?.();
    adapter.formatCompleteTextSSE("approved replacement");
    expect(adapter.toProviderResponse().output).toEqual([
      expect.objectContaining({
        type: "message",
        content: [expect.objectContaining({ text: "approved replacement" })],
      }),
    ]);
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
      "message",
      "function_call",
    ]);
    expect(output[2]).toMatchObject({
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
    expect(addedFrame?.output_index).toBe(2);
    expect(addedFrame?.item?.id).toBe(output[2]?.id);
    expect(adapter.state.text).toBe("Let me look. ");
    expect(adapter.state.toolCalls).toEqual([notice]);
  });

  test("wraps compaction context only on the synthesized held completion wire", () => {
    const adapter = openAiResponsesAdapterFactory.createStreamAdapter();
    const proof = "protected child context";
    const compaction = {
      type: "compaction",
      encrypted_content: "opaque-provider-ciphertext",
    };
    adapter.setCompactionContext?.(proof);
    adapter.withholdHostedToolCalls?.();
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
    ).toEqual([proof]);
    expect(clientResponse).toEqual(recordedResponse);
    expect(recordedResponse.output).toContainEqual(compaction);
  });
});
