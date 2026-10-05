import { describe, expect, test } from "vitest";
import { captureRewriteCalls } from "./rewrite-echo";
import { RewriteStreamCapture } from "./rewrite-stream";

const sse = (event: unknown, name?: string) =>
  `${name ? `event: ${name}\n` : ""}data: ${
    typeof event === "string" ? event : JSON.stringify(event)
  }\n\n`;

describe("RewriteStreamCapture", () => {
  test("retains exact completed Responses output when terminal SSE waits for commit", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    const created = {
      type: "response.created",
      response: { id: "resp_held", output: [] },
    };
    const item = {
      id: "msg_held",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "provider-answer",
          annotations: [{ type: "url_citation", url: "https://example.test" }],
        },
      ],
      unknown_provider_field: "retained",
    };
    const delta = {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "provider-answer",
    };
    const completed = {
      type: "response.completed",
      response: { id: "resp_held", output: [item] },
    };
    capture.observeProviderChunk(created);
    capture.observeProviderChunk(delta);
    capture.observeProviderChunk(completed);
    capture.observeClientEvent(sse(created));
    capture.observeClientEvent(sse(delta));
    const clientItem = {
      ...item,
      content: [{ ...item.content[0], text: "receipt\n\nprovider-answer" }],
    };
    const heldTerminal = sse({
      ...completed,
      response: { ...completed.response, output: [clientItem] },
    });
    // Buffering HTTP writes must not omit the final provider-content snapshot
    // from the capture consumed by the persistence boundary.
    capture.observeClientEvent(heldTerminal);
    expect(capture.originalResponse()).toEqual({
      id: "resp_held",
      output: [item],
    });
    expect(capture.clientResponse()).toEqual({
      id: "resp_held",
      output: [clientItem],
    });
  });

  test.each([
    "provider",
    "client",
  ] as const)("rejects executable Anthropic message_start content on the %s boundary", (boundary) => {
    const capture = new RewriteStreamCapture("anthropic:messages");
    const event = {
      type: "message_start",
      message: {
        id: "msg_seeded",
        content: [
          { type: "text", text: "Initial text" },
          {
            type: "tool_use",
            id: "toolu_seeded",
            name: "execute",
            input: { command: "must not escape" },
          },
        ],
      },
    };
    expect(() =>
      boundary === "provider"
        ? capture.observeProviderChunk(event)
        : capture.observeClientEvent(sse(event)),
    ).toThrow("Unreconstructed executable call");
    expect(capture.originalResponse()).toEqual({ content: [] });
    expect(capture.clientResponse()).toEqual({ content: [] });
  });

  test("assembles Anthropic blocks, client wire ids, and exact partial_json", () => {
    const capture = new RewriteStreamCapture("anthropic:messages");
    capture.observeProviderChunk({
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 1 } },
    });
    capture.observeProviderChunk({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: [{ n: 1 }] },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hel" },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lo" },
    });
    capture.observeProviderChunk({
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "ponder" },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "sig-opaque" },
    });
    capture.observeProviderChunk({
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "toolu_provider",
        name: "read",
        caller: { type: "direct" },
        input: {},
      },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '"a"}' },
    });
    capture.observeProviderChunk({
      type: "content_block_start",
      index: 3,
      content_block: {
        type: "tool_use",
        id: "toolu_second",
        name: "write",
        input: {},
      },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"n":1}' },
    });
    capture.observeProviderChunk({ type: "ping" });
    capture.observeProviderChunk({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 2 },
    });

    capture.observeClientEvent(
      sse(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        "content_block_start",
      ),
    );
    capture.observeClientEvent(
      new TextEncoder().encode(
        sse(
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hello" },
          },
          "content_block_delta",
        ),
      ),
    );
    capture.observeClientEvent(`: keepalive\n\n`);
    capture.observeClientEvent(
      sse(
        {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "appat1wire",
            name: "read",
            input: {},
          },
        },
        "content_block_start",
      ) +
        sse(
          {
            type: "content_block_delta",
            index: 2,
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"a"}',
            },
          },
          "content_block_delta",
        ),
    );

    const original = capture.originalResponse() as {
      content: Array<Record<string, unknown>>;
    };
    const client = capture.clientResponse() as {
      content: Array<Record<string, unknown>>;
    };
    expect(original.content.map((block) => block.type)).toEqual([
      "text",
      "thinking",
      "tool_use",
      "tool_use",
    ]);
    expect(original.content[0]).toEqual({
      type: "text",
      text: "hello",
      citations: [{ n: 1 }],
    });
    expect(original.content[1]).toEqual({
      type: "thinking",
      thinking: "ponder",
      signature: "sig-opaque",
    });
    expect(original.content[2]).toEqual({
      type: "tool_use",
      id: "toolu_provider",
      name: "read",
      caller: { type: "direct" },
      input: { path: "a" },
    });
    expect(original.content[3]).toMatchObject({
      id: "toolu_second",
      input: { n: 1 },
    });
    expect(client.content.map((block) => block.id)).toEqual([
      undefined,
      "appat1wire",
    ]);
    expect(
      captureRewriteCalls({
        family: "anthropic:messages",
        response: original,
      }).size,
    ).toBe(2);
    expect(
      captureRewriteCalls({ family: "anthropic:messages", response: client })
        .size,
    ).toBe(1);
  });

  test("fails closed on invalid Anthropic tool input without substituting {}", () => {
    const capture = new RewriteStreamCapture("anthropic:messages");
    capture.observeProviderChunk({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_bad",
        name: "read",
        input: {},
      },
    });
    capture.observeProviderChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });
    expect(() => capture.originalResponse()).toThrow(
      "Invalid Anthropic tool input",
    );
    try {
      capture.originalResponse();
    } catch (error) {
      expect(String(error)).not.toContain("path");
    }
  });

  test("assembles Chat calls by index and preserves malformed argument strings", () => {
    const capture = new RewriteStreamCapture("openai:chatCompletions");
    capture.observeProviderChunk({
      id: "chatcmpl",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "See " },
          finish_reason: null,
        },
      ],
    });
    capture.observeProviderChunk({
      id: "chatcmpl",
      choices: [
        {
          index: 0,
          delta: {
            content: "files",
            tool_calls: [
              {
                index: 1,
                id: "call_second",
                type: "function",
                function: { name: "write", arguments: "{" },
                thought_signature: "opaque-thought",
              },
              {
                index: 0,
                id: "call_provider",
                type: "function",
                extra: { signed: true },
                function: { name: "re", arguments: '{ "path" : ' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    capture.observeProviderChunk({
      id: "chatcmpl",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: "ad", arguments: '"\\u0061", "n":1e0 }' },
              },
              { index: 1, function: { arguments: '"not-json"' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    capture.observeProviderChunk({
      id: "chatcmpl",
      choices: [],
      usage: { prompt_tokens: 3 },
    });
    capture.observeClientEvent(`${sse("[DONE]")}: keepalive\n\n`);
    capture.observeClientEvent(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "appat1wire",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"rewritten"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const original = capture.originalResponse() as {
      choices: Array<{
        message: {
          content: string;
          tool_calls: Array<Record<string, unknown>>;
        };
      }>;
    };
    const calls = original.choices[0].message.tool_calls;
    expect(original.choices[0].message.content).toBe("See files");
    expect(calls.map((call) => call.id)).toEqual([
      "call_provider",
      "call_second",
    ]);
    expect(calls[0]).toEqual({
      id: "call_provider",
      type: "function",
      extra: { signed: true },
      function: { name: "read", arguments: '{ "path" : "\\u0061", "n":1e0 }' },
    });
    expect(calls[1]).toMatchObject({
      thought_signature: "opaque-thought",
      function: { name: "write", arguments: '{"not-json"' },
    });
    expect(calls[0]).not.toHaveProperty("index");
    const client = capture.clientResponse() as {
      choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
    };
    expect(client.choices[0].message.tool_calls[0].id).toBe("appat1wire");
    expect(
      captureRewriteCalls({
        family: "openai:chatCompletions",
        response: original,
      }).size,
    ).toBe(2);
  });

  test("keeps Responses output when completion is empty and preserves done metadata", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    capture.observeProviderChunk({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_provider",
        name: "read",
        arguments: "",
        status: "in_progress",
      },
    });
    capture.observeProviderChunk({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: '{"path":',
    });
    capture.observeProviderChunk({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: '"a\\nb"}',
    });
    capture.observeProviderChunk({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_provider",
        name: "read",
        namespace: "functions",
        arguments: '{"path":"a\\nb"}',
        provider_extension: { signed: "opaque" },
        status: "completed",
      },
    });
    capture.observeProviderChunk({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "note",
    });
    capture.observeProviderChunk({
      type: "response.output_item.added",
      output_index: 2,
      item: {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_custom",
        name: "shell",
        input: "",
      },
    });
    capture.observeProviderChunk({
      type: "response.custom_tool_call_input.delta",
      item_id: "ctc_1",
      output_index: 2,
      delta: "  printf ",
    });
    capture.observeProviderChunk({
      type: "response.custom_tool_call_input.done",
      item_id: "ctc_1",
      output_index: 2,
      input: "  printf '%s\\n'",
    });
    capture.observeProviderChunk({
      type: "response.output_item.done",
      output_index: 3,
      item: {
        type: "compaction",
        id: "cmp_1",
        encrypted_content: "cipher-text",
      },
    });
    capture.observeProviderChunk({
      type: "response.reasoning_summary_text.delta",
      delta: "no tool here",
    });
    capture.observeProviderChunk({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [] },
    });
    capture.observeClientEvent(
      `: keepalive\n\n${sse({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_client",
          call_id: "appat1wire",
          name: "read",
          arguments: '{"path":"rewritten"}',
        },
      })}`,
    );

    const original = capture.originalResponse() as {
      output: Array<Record<string, unknown>>;
    };
    expect(original.output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "custom_tool_call",
      "compaction",
    ]);
    expect(original.output[0]).toMatchObject({
      content: [{ type: "output_text", text: "note" }],
    });
    expect(original.output[1]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_provider",
      name: "read",
      namespace: "functions",
      arguments: '{"path":"a\\nb"}',
      provider_extension: { signed: "opaque" },
      status: "completed",
    });
    expect(original.output[2]).toMatchObject({
      call_id: "call_custom",
      input: "  printf '%s\\n'",
    });
    expect(original.output[3]).toMatchObject({
      encrypted_content: "cipher-text",
    });
    const client = capture.clientResponse() as {
      output: Array<{ call_id: string }>;
    };
    expect(client.output[0].call_id).toBe("appat1wire");
    expect(
      captureRewriteCalls({
        family: "openai:responses",
        response: original,
      }).size,
    ).toBe(2);
  });

  test("does not let an empty Responses completion erase accumulated arguments", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    capture.observeProviderChunk({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: "",
      },
    });
    capture.observeProviderChunk({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: "{not-json",
    });
    capture.observeProviderChunk({
      type: "response.completed",
      response: { status: "completed", output: [] },
    });
    const original = capture.originalResponse() as {
      output: Array<{ arguments: string }>;
    };
    expect(original.output[0].arguments).toBe("{not-json");
  });

  test("fails closed when an unknown event carries an executable call", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    expect(() =>
      capture.observeProviderChunk({
        type: "response.mystery",
        item: {
          type: "function_call",
          call_id: "call_hidden",
          name: "read",
          arguments: "{",
        },
      }),
    ).toThrow("Unreconstructed executable call");
  });

  test("retains provider response ids across deltas and omits a missing id", () => {
    const anthropic = new RewriteStreamCapture("anthropic:messages");
    anthropic.observeProviderChunk({
      type: "message_start",
      message: { id: "msg_original", usage: { input_tokens: 1 } },
    });
    anthropic.observeProviderChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Done" },
    });
    anthropic.observeClientEvent(
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done" },
      }),
    );
    expect(anthropic.originalResponse()).toMatchObject({
      id: "msg_original",
      content: [{ type: "text", text: "Done" }],
    });
    expect(anthropic.clientResponse()).not.toHaveProperty("id");

    const chat = new RewriteStreamCapture("openai:chatCompletions");
    chat.observeProviderChunk({
      id: "chatcmpl_original",
      choices: [{ index: 0, delta: { content: "Do" } }],
    });
    chat.observeProviderChunk({
      id: "chatcmpl_original",
      choices: [{ index: 0, delta: { content: "ne" } }],
    });
    chat.observeClientEvent(
      sse({
        id: "chatcmpl_client",
        choices: [{ index: 0, delta: { role: "assistant", content: "Done" } }],
      }),
    );
    expect(chat.originalResponse()).toMatchObject({
      id: "chatcmpl_original",
      choices: [{ message: { role: "assistant", content: "Done" } }],
    });
    expect(chat.clientResponse()).toMatchObject({
      id: "chatcmpl_client",
      choices: [{ message: { role: "assistant", content: "Done" } }],
    });
    const missing = new RewriteStreamCapture("openai:chatCompletions");
    missing.observeProviderChunk({
      choices: [{ index: 0, delta: { content: "Done" } }],
    });
    expect(missing.originalResponse()).not.toHaveProperty("id");
  });

  test("keeps a Responses response id when a later completion has no output", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    capture.observeProviderChunk({
      type: "response.created",
      response: { id: "resp_original", output: [] },
    });
    capture.observeProviderChunk({
      type: "response.output_text.delta",
      output_index: 0,
      delta: "Done",
    });
    capture.observeProviderChunk({
      type: "response.completed",
      response: { status: "completed", output: [] },
    });
    capture.observeClientEvent(
      sse({
        type: "response.completed",
        response: {
          id: "resp_client",
          output: [{ type: "message", role: "assistant", content: [] }],
        },
      }),
    );
    expect(capture.originalResponse()).toMatchObject({
      id: "resp_original",
      output: [{ content: [{ text: "Done" }] }],
    });
    expect(capture.clientResponse()).toMatchObject({ id: "resp_client" });
  });

  test("stops retaining content past 16MiB", () => {
    const capture = new RewriteStreamCapture("openai:chatCompletions");
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 16; i++) {
      capture.observeProviderChunk({
        choices: [{ index: 0, delta: { content: chunk } }],
      });
    }
    expect(() =>
      capture.observeProviderChunk({
        choices: [{ index: 0, delta: { content: "x" } }],
      }),
    ).toThrow("Rewrite stream retention limit exceeded");
    const response = capture.originalResponse() as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(response.choices[0].message.content).toHaveLength(16 * 1024 * 1024);
  });
});
