import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";
import type { OpenAi } from "@/types";
import { OpenAIStreamAdapter } from "./openai";
import {
  buildCodexResponsesRequest,
  codexResponsesStreamToChatChunks,
  foldChatChunksToResponse,
} from "./openai-codex-translator";

type ChatCompletionsRequest = OpenAi.Types.ChatCompletionsRequest;

function req(
  overrides: Partial<ChatCompletionsRequest> = {},
): ChatCompletionsRequest {
  return {
    model: "gpt-5.5-codex",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  } as ChatCompletionsRequest;
}

async function* streamOf(
  events: unknown[],
): AsyncGenerator<ResponseStreamEvent> {
  for (const event of events) {
    yield event as ResponseStreamEvent;
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

describe("buildCodexResponsesRequest", () => {
  it("applies the mandatory Codex-backend transforms", () => {
    const body = buildCodexResponsesRequest(req()) as unknown as Record<
      string,
      unknown
    >;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(typeof body.instructions).toBe("string");
    expect((body.instructions as string).length).toBeGreaterThan(0);
    expect(body.model).toBe("gpt-5.5-codex");
  });

  it("adds the session's prompt cache key", () => {
    const fromSession = buildCodexResponsesRequest(
      req(),
      "session-key",
    ) as unknown as Record<string, unknown>;
    const withoutSession = buildCodexResponsesRequest(
      req(),
    ) as unknown as Record<string, unknown>;

    expect(fromSession.prompt_cache_key).toBe("session-key");
    expect(withoutSession).not.toHaveProperty("prompt_cache_key");
  });

  it("maps chat messages, tool calls, and tool results into responses input", () => {
    const body = buildCodexResponsesRequest(
      req({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "call the tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "result-text" },
        ],
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as { input: Array<Record<string, unknown>> };

    // system → developer message
    expect(body.input[0]).toMatchObject({ type: "message", role: "developer" });
    // user → user message
    expect(body.input[1]).toMatchObject({ type: "message", role: "user" });
    // assistant tool call → function_call item
    expect(body.input[2]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
    });
    // tool result → function_call_output item
    expect(body.input[3]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: "result-text",
    });
  });

  it("maps chat function tools into responses function tools", () => {
    const body = buildCodexResponsesRequest(
      req({
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "search things",
              parameters: { type: "object" },
            },
          },
        ],
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as {
      tools?: Array<Record<string, unknown>>;
      tool_choice?: string;
    };

    expect(body.tools?.[0]).toMatchObject({ type: "function", name: "search" });
    expect(body.tool_choice).toBe("auto");
  });

  it("maps a forced-function tool_choice to the responses object form", () => {
    const body = buildCodexResponsesRequest(
      req({
        tools: [
          {
            type: "function",
            function: { name: "search", parameters: { type: "object" } },
          },
        ],
        tool_choice: { type: "function", function: { name: "search" } },
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as { tool_choice?: unknown };

    expect(body.tool_choice).toEqual({ type: "function", name: "search" });
  });

  it("preserves image parts as input_image instead of dropping them", () => {
    const body = buildCodexResponsesRequest(
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA" },
              },
            ],
          },
        ],
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };

    const parts = body.input[0].content;
    expect(parts).toEqual([
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ]);
  });
});

describe("codexResponsesStreamToChatChunks + fold", () => {
  const base = {
    model: "gpt-5.5-codex",
    completionId: "chatcmpl-test",
    createdUnixSeconds: 1_700_000_000,
  };

  it("translates text deltas and usage into chat chunks and a folded response", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " world" },
      {
        type: "response.completed",
        response: {
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      },
    ];

    const chunks = await collect(
      codexResponsesStreamToChatChunks({ stream: streamOf(events), ...base }),
    );
    // Opening role chunk + 2 text deltas + closing chunk.
    expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("Hello world");
    const last = chunks.at(-1);
    expect(last?.choices[0].finish_reason).toBe("stop");
    expect(last?.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 3,
    });

    const response = await foldChatChunksToResponse({
      chunks: codexResponsesStreamToChatChunks({
        stream: streamOf(events),
        ...base,
      }),
      ...base,
    });
    expect(response.choices[0].message.content).toBe("Hello world");
    expect(response.choices[0].finish_reason).toBe("stop");
    expect(response.usage).toMatchObject({ prompt_tokens: 10 });
  });

  it("keeps cached and reasoning tokens in the chat usage", async () => {
    // Without the cached tokens, the proxy records every prompt token as
    // uncached input and reports no cache reads for these requests.
    const events = [
      { type: "response.output_text.delta", delta: "Hi" },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 896 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 5 },
            total_tokens: 1020,
          },
        },
      },
    ];

    const chunks = await collect(
      codexResponsesStreamToChatChunks({ stream: streamOf(events), ...base }),
    );

    expect(chunks.at(-1)?.usage).toMatchObject({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 896 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });
  });

  it("translates a streamed tool call into tool_calls chunks and finish_reason tool_calls", async () => {
    const events = [
      {
        type: "response.output_item.added",
        item: {
          id: "fc_1",
          call_id: "call_abc",
          type: "function_call",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"city":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '"paris"}',
      },
      { type: "response.completed", response: { usage: null } },
    ];

    const response = await foldChatChunksToResponse({
      chunks: codexResponsesStreamToChatChunks({
        stream: streamOf(events),
        ...base,
      }),
      ...base,
    });

    expect(response.choices[0].finish_reason).toBe("tool_calls");
    const toolCall = response.choices[0].message.tool_calls?.[0];
    expect(toolCall).toMatchObject({
      id: "call_abc",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"paris"}' },
    });
  });

  it.each([
    "added",
    "arguments.done",
    "item.done",
    "completed",
  ])("preserves single-call arguments supplied only by %s", async (source) => {
    const item = {
      id: "fc_lookup",
      call_id: "call_lookup",
      type: "function_call",
      name: "public_lookup",
      arguments: '{"topic":"batch-case"}',
    };
    const events = [
      {
        type: "response.output_item.added",
        item: { ...item, arguments: source === "added" ? item.arguments : "" },
      },
      ...(source === "arguments.done"
        ? [
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              arguments: item.arguments,
            },
          ]
        : []),
      ...(source === "item.done"
        ? [{ type: "response.output_item.done", item }]
        : []),
      {
        type: "response.completed",
        response: {
          output: source === "completed" ? [item] : [],
          usage: null,
        },
      },
    ];
    const adapter = new OpenAIStreamAdapter();
    for await (const chunk of codexResponsesStreamToChatChunks({
      stream: streamOf(events),
      ...base,
    })) {
      adapter.processChunk(chunk);
    }
    expect(adapter.state.toolCalls).toEqual([
      { id: item.call_id, name: item.name, arguments: item.arguments },
    ]);
    expect(adapter.toProviderResponse().choices[0].finish_reason).toBe(
      "tool_calls",
    );
  });

  it("preserves one assistant batch with interleaved calls and completed snapshots", async () => {
    const items = [
      {
        id: "fc_public",
        call_id: "call_public",
        type: "function_call",
        name: "public_lookup",
        arguments: '{"topic":"batch-case"}',
      },
      {
        id: "fc_approval",
        call_id: "call_approval",
        type: "function_call",
        name: "approval_action",
        arguments: '{"case_id":"batch-case"}',
      },
      {
        id: "fc_terminal",
        call_id: "call_terminal",
        type: "function_call",
        name: "terminal_action",
        arguments: '{"note":"batch-case"}',
      },
    ];
    const events = [
      ...items.map((item) => ({
        type: "response.output_item.added",
        item: { ...item, arguments: "" },
      })),
      {
        type: "response.function_call_arguments.delta",
        item_id: items[1].id,
        delta: '{"case_id":',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: items[1].id,
        arguments: items[1].arguments,
      },
      { type: "response.output_item.done", item: items[0] },
      {
        type: "response.completed",
        response: {
          output: items,
          usage: { input_tokens: 10, output_tokens: 30, total_tokens: 40 },
        },
      },
    ];
    const chunks = await collect(
      codexResponsesStreamToChatChunks({ stream: streamOf(events), ...base }),
    );
    const adapter = new OpenAIStreamAdapter();
    for (const chunk of chunks) adapter.processChunk(chunk);
    expect(adapter.state.toolCalls).toEqual(
      items.map((item) => ({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      })),
    );
    const response = await foldChatChunksToResponse({
      chunks: codexResponsesStreamToChatChunks({
        stream: streamOf(events),
        ...base,
      }),
      ...base,
    });
    expect(response.choices[0].message.tool_calls).toEqual(
      adapter.toProviderResponse().choices[0].message.tool_calls,
    );
    const toolChunks = chunks.filter(
      (chunk) => chunk.choices[0].delta.tool_calls?.length,
    );
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].choices[0].delta.tool_calls).toHaveLength(3);
    expect(chunks.at(-1)?.usage).toMatchObject({ completion_tokens: 30 });
  });

  it("does not duplicate fully streamed arguments echoed in done and completed events", async () => {
    const item = {
      id: "fc_review",
      call_id: "call_review",
      type: "function_call",
      name: "review_action",
      arguments: '{"offer_id":"test-offer","plan":"Submit for approval"}',
    };
    const events = [
      { type: "response.output_item.added", item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        delta: item.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        arguments: item.arguments,
      },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { output: [item], usage: null } },
    ];
    const response = await foldChatChunksToResponse({
      chunks: codexResponsesStreamToChatChunks({
        stream: streamOf(events),
        ...base,
      }),
      ...base,
    });
    expect(response.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: item.call_id,
      function: { name: item.name, arguments: item.arguments },
    });
    const nextRequest = buildCodexResponsesRequest(
      req({
        messages: [
          { role: "user", content: "Request review" },
          {
            ...response.choices[0].message,
            tool_calls: response.choices[0].message.tool_calls ?? undefined,
          },
          {
            role: "tool",
            tool_call_id: item.call_id,
            content: '{"outcome":"review_required"}',
          },
          { role: "user", content: "Approve" },
        ],
      }),
    );
    expect(nextRequest.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Request review" }],
      },
      {
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      },
      {
        type: "function_call_output",
        call_id: item.call_id,
        output: '{"outcome":"review_required"}',
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Approve" }],
      },
    ]);
  });

  it.each([
    "",
    '{"case_id":',
    "null",
    "[]",
    '"text"',
  ])("leaves malformed or non-object provider arguments %j unchanged for refusal", async (argumentsText) => {
    const adapter = new OpenAIStreamAdapter();
    for await (const chunk of codexResponsesStreamToChatChunks({
      stream: streamOf([
        {
          type: "response.output_item.added",
          item: {
            id: "fc_invalid",
            call_id: "call_invalid",
            type: "function_call",
            name: "approval_action",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_invalid",
          arguments: argumentsText,
        },
        { type: "response.completed", response: { usage: null } },
      ]),
      ...base,
    })) {
      adapter.processChunk(chunk);
    }
    expect(adapter.state.toolCalls[0].arguments).toBe(argumentsText);
    expect(
      adapter.toProviderResponse().choices[0].message.tool_calls?.[0],
    ).toMatchObject({ function: { arguments: argumentsText } });
  });

  it.each([
    { arguments: '{"topic":"different"}' },
    { name: "other_action", arguments: '{"topic":"batch-case"}' },
    { call_id: "call_other", arguments: '{"topic":"batch-case"}' },
  ])("refuses inconsistent final call snapshots %j before emitting any tool calls", async (override) => {
    const chunks: OpenAi.Types.ChatCompletionChunk[] = [];
    const item = {
      id: "fc_consistent",
      call_id: "call_consistent",
      type: "function_call",
      name: "public_lookup",
      arguments: '{"topic":"batch-case"}',
    };
    await expect(
      (async () => {
        for await (const chunk of codexResponsesStreamToChatChunks({
          stream: streamOf([
            { type: "response.output_item.added", item },
            {
              type: "response.completed",
              response: { output: [{ ...item, ...override }], usage: null },
            },
          ]),
          ...base,
        })) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(chunks.every((chunk) => !chunk.choices[0].delta.tool_calls)).toBe(
      true,
    );
  });

  it("refuses an unknown argument item instead of attaching it to the first call", async () => {
    await expect(
      collect(
        codexResponsesStreamToChatChunks({
          stream: streamOf([
            {
              type: "response.output_item.added",
              item: {
                id: "fc_known",
                call_id: "call_known",
                type: "function_call",
                name: "public_lookup",
                arguments: "",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_unknown",
              delta: '{"topic":"wrong-call"}',
            },
          ]),
          ...base,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it.each([
    "incomplete",
    "failed",
    "eof",
  ])("does not emit held executable calls after %s", async (terminal) => {
    const chunks: OpenAi.Types.ChatCompletionChunk[] = [];
    const run = async () => {
      for await (const chunk of codexResponsesStreamToChatChunks({
        stream: streamOf([
          {
            type: "response.output_item.added",
            item: {
              id: "fc_partial",
              call_id: "call_partial",
              type: "function_call",
              name: "approval_action",
              arguments: '{"case_id":"batch-case"}',
            },
          },
          ...(terminal === "eof"
            ? []
            : [
                {
                  type: `response.${terminal}`,
                  response: {
                    status: terminal,
                    incomplete_details: { reason: "max_output_tokens" },
                    error: { message: "generation failed" },
                    usage: null,
                  },
                },
              ]),
        ]),
        ...base,
      })) {
        chunks.push(chunk);
      }
    };
    await expect(run()).rejects.toMatchObject({
      statusCode: 502,
      isIncompleteTerminal: terminal === "incomplete",
      completion: { status: terminal === "eof" ? "incomplete" : terminal },
    });
    expect(chunks.every((chunk) => !chunk.choices[0].finish_reason)).toBe(true);
    expect(chunks.every((chunk) => !chunk.choices[0].delta.tool_calls)).toBe(
      true,
    );
  });

  it("throws on response.failed instead of masking it as a successful turn", async () => {
    const events = [
      {
        type: "response.failed",
        response: { error: { message: "server error" } },
      },
    ];
    await expect(
      collect(
        codexResponsesStreamToChatChunks({ stream: streamOf(events), ...base }),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it.each([
    "max_output_tokens",
    "content_filter",
    "max_messages",
  ])("carries partial text and usage in a typed incomplete failure (%s)", async (reason) => {
    const events = [
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          id: "resp_incomplete",
          status: "incomplete",
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          incomplete_details: { reason },
        },
      },
    ];
    await expect(
      foldChatChunksToResponse({
        chunks: codexResponsesStreamToChatChunks({
          stream: streamOf(events),
          ...base,
        }),
        ...base,
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      isIncompleteTerminal: true,
      completion: {
        object: "chat.completion",
        status: "incomplete",
        provider_response_id: "resp_incomplete",
        incomplete_details: { reason },
        choices: [
          {
            message: { content: "partial" },
            finish_reason:
              reason === "content_filter" ? "content_filter" : "length",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    });
  });

  it.each([
    false,
    true,
  ])("rejects tool-free clean EOF rather than minting stop (partial=%s)", async (partial) => {
    await expect(
      collect(
        codexResponsesStreamToChatChunks({
          stream: streamOf(
            partial
              ? [
                  {
                    type: "response.created",
                    response: {
                      id: "resp_eof",
                      usage: {
                        input_tokens: 3,
                        output_tokens: 2,
                        total_tokens: 5,
                      },
                    },
                  },
                  { type: "response.output_text.delta", delta: "partial" },
                ]
              : [],
          ),
          ...base,
        }),
      ),
    ).rejects.toMatchObject({
      isIncompleteTerminal: false,
      completion: {
        status: "incomplete",
        incomplete_details: null,
        error: { code: "proxy_stream_incomplete" },
        choices: [
          {
            message: { content: partial ? "partial" : null },
            finish_reason: "error",
          },
        ],
        ...(partial
          ? {
              provider_response_id: "resp_eof",
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }
          : {}),
      },
    });
  });
});
