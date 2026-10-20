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
});

describe("OpenAiResponsesRequestAdapter replayed tool-call ids", () => {
  // A Gemini call id as the model router hands it to a client: the thought
  // signature rides inside it (encodeSignedToolCallId).
  const geminiCallId = `gemsig-${"s".repeat(450)}.gemini-call-read-1`;

  test("fits a Gemini call id after the result update looked it up", () => {
    const request = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "function_call",
          id: `fc_${geminiCallId}`,
          call_id: geminiCallId,
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: geminiCallId,
          output: "SECRET",
        },
      ],
    } as unknown as OpenAi.Types.ResponsesRequest;

    const adapter = openAiResponsesAdapterFactory.createRequestAdapter(request);
    adapter.applyToolResultUpdates({ [geminiCallId]: "sanitized" });
    const [call, output] = adapter.toProviderRequest().input as Array<{
      id?: string;
      call_id: string;
      output?: string;
    }>;

    expect(call.call_id).toMatch(/^call_[0-9a-f]{32}$/);
    // OpenAI did not mint the item id and accepts the item without one.
    expect(call).not.toHaveProperty("id");
    expect(output).toMatchObject({
      call_id: call.call_id,
      output: "sanitized",
    });
    // The client's history and the policy view keep the id as sent.
    expect(adapter.getToolResults()[0].id).toBe(geminiCallId);
    expect((request.input as Array<{ call_id: string }>)[1].call_id).toBe(
      geminiCallId,
    );
  });
});
