import { describe, expect, test } from "vitest";
import { captureRewriteCalls } from "./rewrite-echo";
import { RewriteStreamCapture } from "./rewrite-stream";

const sse = (event: unknown, name?: string) =>
  `${name ? `event: ${name}\n` : ""}data: ${
    typeof event === "string" ? event : JSON.stringify(event)
  }\n\n`;

describe("RewriteStreamCapture", () => {
  test.each([
    "anthropic:messages",
    "openai:chatCompletions",
    "openai:responses",
  ] as const)("preserves many tiny Unicode text and argument appends for %s", (family) => {
    const capture = new RewriteStreamCapture(family);
    const mirror = (event: unknown) => {
      capture.observeProviderChunk(event);
      capture.observeClientEvent(sse(event));
    };
    const fragments = Array.from({ length: 512 }, () => [
      "a",
      "\u00e9",
      "\u6f22",
      "\ud83d",
      "",
      "\ude80",
      "\ud800",
      "x",
      "\udc00",
    ]).flat();
    const text = fragments.join("");
    const argumentsText = `{"text":"${text}"}`;
    if (family === "anthropic:messages") {
      mirror({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "seed\ud83d" },
      });
      mirror({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "\ude80" },
      });
      mirror({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      mirror({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_tiny",
          name: "read",
          input: {},
        },
      });
      mirror({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "discard\ud83d" },
      });
      mirror({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_tiny",
          name: "read",
          input: {},
        },
      });
      mirror({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"text":"' },
      });
      for (const delta of fragments) {
        mirror({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta },
        });
        mirror({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: delta },
        });
      }
      mirror({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"}' },
      });
      const expected = {
        content: [
          { type: "text", text },
          { type: "tool_use", id: "call_tiny", name: "read", input: { text } },
        ],
      };
      expect(capture.originalResponse()).toEqual(expected);
      expect(capture.clientResponse()).toEqual(expected);
      return;
    }
    if (family === "openai:chatCompletions") {
      const delta = ({
        content,
        args,
        name = "",
      }: {
        content: string;
        args: string;
        name?: string;
      }) => ({
        choices: [
          {
            index: 0,
            delta: {
              content,
              reasoning_content: content,
              tool_calls: [
                {
                  index: 0,
                  id: "call_tiny",
                  type: "function",
                  function: { name, arguments: args },
                },
              ],
            },
          },
        ],
      });
      mirror(delta({ content: "", args: '{"text":"', name: "read" }));
      for (const fragment of fragments) {
        mirror(delta({ content: fragment, args: fragment }));
      }
      mirror(delta({ content: "", args: '"}' }));
      const expected = {
        choices: [
          {
            message: {
              role: "assistant",
              content: text,
              reasoning_content: text,
              tool_calls: [
                {
                  id: "call_tiny",
                  type: "function",
                  function: { name: "read", arguments: argumentsText },
                },
              ],
            },
          },
        ],
      };
      expect(capture.originalResponse()).toEqual(expected);
      expect(capture.clientResponse()).toEqual(expected);
      return;
    }
    mirror({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        call_id: "call_tiny",
        name: "read",
        arguments: '{"text":"',
      },
    });
    for (const delta of fragments) {
      mirror({ type: "response.output_text.delta", output_index: 0, delta });
      mirror({
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta,
      });
    }
    mirror({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '"}',
    });
    const expected = {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
        {
          type: "function_call",
          call_id: "call_tiny",
          name: "read",
          arguments: argumentsText,
        },
      ],
    };
    expect(capture.originalResponse()).toEqual(expected);
    expect(capture.clientResponse()).toEqual(expected);
  });

  test.each([
    ["function_call", "function_call_arguments", "arguments"],
    ["custom_tool_call", "custom_tool_call_input", "input"],
    ["message", "output_text", "text"],
  ] as const)("keeps exact %s byte limits after replacements, empty appends, and surrogate joins", (type, eventType, field) => {
    const capture = new RewriteStreamCapture("openai:responses");
    const item = (value: string) =>
      type === "message"
        ? {
            id: "item_tail",
            type,
            role: "assistant",
            content: [{ type: "output_text", text: value }],
            provider_extension: { signed: "opaque" },
          }
        : {
            id: "item_tail",
            type,
            call_id: "call_tail",
            name: "read",
            [field]: value,
            provider_extension: { signed: "opaque" },
          };
    const append = (delta: string) =>
      capture.observeProviderChunk({
        type: `response.${eventType}.delta`,
        output_index: 0,
        delta,
      });
    const done = (value: string) =>
      capture.observeProviderChunk({
        type: `response.${eventType}.done`,
        output_index: 0,
        [field]: value,
      });
    const replace = (value: string) =>
      capture.observeProviderChunk({
        type: "response.output_item.done",
        output_index: 0,
        item: item(value),
      });
    replace("seed\ud83d");
    append("");
    append("\ude80");
    expect(capture.originalResponse()).toEqual({
      output: [item("seed\ud83d\ude80")],
    });
    done("");
    append("\ude80");
    const fragments = Array.from({ length: 256 }, () => [
      "a",
      "\u00e9",
      "\u6f22",
      "\ud83d",
      "",
      "\ude80",
      "\ud800",
      "x",
      "\udc00",
      "\n",
      '"',
      "\\",
    ]).flat();
    for (const fragment of fragments) append(fragment);
    expect(capture.originalResponse()).toEqual({
      output: [item(`\ude80${fragments.join("")}`)],
    });
    done("shrink\ud83d");
    append("");
    append("\ude80");
    expect(capture.originalResponse()).toEqual({
      output: [item("shrink\ud83d\ude80")],
    });
    replace("");
    append("\ude80");
    expect(capture.originalResponse()).toEqual({ output: [item("\ude80")] });
    replace("new\ud83d");
    append("\ude80");
    expect(capture.originalResponse()).toEqual({
      output: [item("new\ud83d\ude80")],
    });

    const bytes = (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value), "utf8");
    const overhead =
      2 * bytes({ output: [] }) +
      bytes(item("")) +
      bytes(0) +
      1 +
      bytes(["item_tail", 0]);
    // A lone high surrogate costs six escaped bytes. Its low half reduces the
    // retained representation by two bytes, even when already at the limit.
    const full = `${"x".repeat(
      RewriteStreamCapture.retentionLimit - overhead - 6,
    )}\ud83d`;
    done(full);
    append("");
    append("\ude80");
    append("aa");
    expect(() => append("x")).toThrow(
      "Rewrite stream retention limit exceeded",
    );
    expect(capture.originalResponse()).toEqual({
      output: [item(`${full}\ude80aa`)],
    });
  });

  test("keeps exact Anthropic partial JSON limits after a reset and many tiny surrogate appends", () => {
    const capture = new RewriteStreamCapture("anthropic:messages");
    const block = {
      type: "tool_use",
      id: "call_tail",
      name: "read",
      input: {},
    };
    const start = () =>
      capture.observeProviderChunk({
        type: "content_block_start",
        index: 0,
        content_block: block,
      });
    const append = (partial: string) =>
      capture.observeProviderChunk({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial },
      });
    start();
    append("discard\ud83d");
    start();
    append('{"text":"');
    const fragments = Array.from({ length: 256 }, () => [
      "a",
      "\u00e9",
      "\u6f22",
      "\ud83d",
      "",
      "\ude80",
      "\ud800",
      "x",
      "\udc00",
    ]).flat();
    for (const fragment of fragments) append(fragment);
    const text = fragments.join("");
    const bytes = (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value), "utf8");
    const fixed =
      2 * bytes({ content: [] }) +
      bytes(block) +
      bytes(0) +
      1 +
      bytes([0, `{"text":"${text}\ud83d\ude80"}`]);
    const padding = "x".repeat(RewriteStreamCapture.retentionLimit - fixed);
    append(`${padding}\ud83d`);
    append("");
    append("\ude80");
    append('"}');
    expect(() => append("x")).toThrow(
      "Rewrite stream retention limit exceeded",
    );
    expect(capture.originalResponse()).toEqual({
      content: [{ ...block, input: { text: `${text}${padding}\ud83d\ude80` } }],
    });
  });

  test.each([
    "provider",
    "client",
  ] as const)("preserves byte-split Unicode text and executable arguments on the %s boundary", (boundary) => {
    const text = "\u00e9\u6f22\ud83d\ude80\ufeff\ufffd";
    const argumentsText = `{ "text" : "${text}", "escape": "\\u0061" }`;
    const cases = [
      {
        family: "anthropic:messages" as const,
        events: [
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "toolu_unicode",
              name: "read",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: argumentsText },
          },
        ],
        response: {
          content: [
            { type: "text", text },
            {
              type: "tool_use",
              id: "toolu_unicode",
              name: "read",
              input: { text, escape: "a" },
            },
          ],
        },
      },
      {
        family: "openai:chatCompletions" as const,
        events: [
          {
            choices: [
              {
                index: 0,
                delta: {
                  content: text,
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_unicode",
                      type: "function",
                      function: { name: "read", arguments: argumentsText },
                    },
                  ],
                },
              },
            ],
          },
        ],
        response: {
          choices: [
            {
              message: {
                role: "assistant",
                content: text,
                tool_calls: [
                  {
                    id: "call_unicode",
                    type: "function",
                    function: { name: "read", arguments: argumentsText },
                  },
                ],
              },
            },
          ],
        },
      },
      {
        family: "openai:responses" as const,
        events: [
          { type: "response.output_text.delta", output_index: 0, delta: text },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: {
              type: "function_call",
              call_id: "call_unicode",
              name: "read",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: argumentsText,
          },
        ],
        response: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
            {
              type: "function_call",
              call_id: "call_unicode",
              name: "read",
              arguments: argumentsText,
            },
          ],
        },
      },
    ];
    for (const scenario of cases) {
      const capture = new RewriteStreamCapture(scenario.family);
      let firstEvent = true;
      for (const event of scenario.events) {
        const bytes = new TextEncoder().encode(
          `${firstEvent ? "\ufeff" : ""}${sse(event)}`,
        );
        firstEvent = false;
        for (let offset = 0; offset < bytes.length; offset++) {
          const chunk = bytes.subarray(offset, offset + 1);
          if (boundary === "provider") capture.observeProviderChunk(chunk);
          else capture.observeClientEvent(chunk);
        }
      }
      const response =
        boundary === "provider"
          ? capture.originalResponse()
          : capture.clientResponse();
      expect(response).toEqual(scenario.response);
      expect(
        captureRewriteCalls({ family: scenario.family, response }).size,
      ).toBe(1);
    }
  });

  test("keeps pending UTF-8 independent between provider and client boundaries", () => {
    const capture = new RewriteStreamCapture("openai:chatCompletions");
    const wire = (text: string) =>
      new TextEncoder().encode(
        sse({ choices: [{ index: 0, delta: { content: text } }] }),
      );
    const provider = wire("\u6f22");
    const client = wire("\ud83d\ude80");
    const providerSplit = provider.indexOf(0xe6) + 1;
    const clientSplit = client.indexOf(0xf0) + 2;
    capture.observeProviderChunk(provider.subarray(0, providerSplit));
    capture.observeClientEvent(client.subarray(0, clientSplit));
    expect(() => capture.originalResponse()).toThrow(
      "Truncated rewrite stream UTF-8",
    );
    expect(() => capture.clientResponse()).toThrow(
      "Truncated rewrite stream UTF-8",
    );
    capture.observeProviderChunk(provider.subarray(providerSplit));
    expect(capture.originalResponse()).toMatchObject({
      choices: [{ message: { content: "\u6f22" } }],
    });
    expect(() => capture.clientResponse()).toThrow(
      "Truncated rewrite stream UTF-8",
    );
    capture.observeClientEvent(client.subarray(clientSplit));
    expect(capture.clientResponse()).toMatchObject({
      choices: [{ message: { content: "\ud83d\ude80" } }],
    });
  });

  test.each([
    "provider",
    "client",
  ] as const)("preserves raw and JSON-escaped surrogate splits with mixed chunks on the %s boundary", (boundary) => {
    const capture = new RewriteStreamCapture("openai:chatCompletions");
    const observe = (chunk: string | Uint8Array) =>
      boundary === "provider"
        ? capture.observeProviderChunk(chunk)
        : capture.observeClientEvent(chunk);
    const text = "\ud83d\ude80";
    const argumentsText = `{"text":"${text}"}`;
    const first = sse({
      choices: [{ index: 0, delta: { content: text } }],
    });
    // Use individual UTF-16 code units, not code-point iteration.
    for (let offset = 0; offset < first.length; offset++) {
      const character = first[offset];
      const code = first.charCodeAt(offset);
      observe(
        code >= 0xd800 && code <= 0xdfff
          ? character
          : new TextEncoder().encode(character),
      );
    }
    for (const argumentsDelta of ['{"text":"\ud83d', '\ude80"}']) {
      observe(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_surrogates",
                    type: "function",
                    function: { name: "", arguments: argumentsDelta },
                  },
                ],
              },
            },
          ],
        }),
      );
    }
    const response =
      boundary === "provider"
        ? capture.originalResponse()
        : capture.clientResponse();
    expect(response).toMatchObject({
      choices: [
        {
          message: {
            content: text,
            tool_calls: [
              {
                id: "call_surrogates",
                function: { arguments: argumentsText },
              },
            ],
          },
        },
      ],
    });
  });

  test.each([
    "provider",
    "client",
  ] as const)("preserves lone surrogate code units in string chunks on the %s boundary", (boundary) => {
    const capture = new RewriteStreamCapture("openai:chatCompletions");
    const text = "\ud800\udc00\ud800x\udc00";
    const wire = `data: {"choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`;
    for (let offset = 0; offset < wire.length; offset++) {
      if (boundary === "provider") capture.observeProviderChunk(wire[offset]);
      else capture.observeClientEvent(wire[offset]);
    }
    const response =
      boundary === "provider"
        ? capture.originalResponse()
        : capture.clientResponse();
    expect(response).toMatchObject({
      choices: [{ message: { content: text } }],
    });
  });

  test.each([
    "provider",
    "client",
  ] as const)("rejects malformed bytes without repairing text or executable arguments on the %s boundary", (boundary) => {
    for (const malformed of [
      [0x80],
      [0xc0, 0xaf],
      [0xe2, 0x28, 0xa1],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xff],
    ]) {
      const capture = new RewriteStreamCapture("openai:responses");
      const observe = (chunk: string | Uint8Array) =>
        boundary === "provider"
          ? capture.observeProviderChunk(chunk)
          : capture.observeClientEvent(chunk);
      observe(
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"',
      );
      expect(() => observe(new Uint8Array(malformed))).toThrow(
        "Invalid rewrite stream UTF-8",
      );
      expect(() => observe('"}\n\n')).toThrow("Invalid rewrite stream UTF-8");
      expect(() =>
        boundary === "provider"
          ? capture.originalResponse()
          : capture.clientResponse(),
      ).toThrow("Invalid rewrite stream UTF-8");
    }
  });

  test.each([
    "provider",
    "client",
  ] as const)("rejects incomplete UTF-8 after a complete frame without flushing or repairing it on the %s boundary", (boundary) => {
    for (const incomplete of [[0xc3], [0xe6, 0xbc], [0xf0, 0x9f, 0x9a]]) {
      const capture = new RewriteStreamCapture("openai:chatCompletions");
      const observe = (chunk: string | Uint8Array) =>
        boundary === "provider"
          ? capture.observeProviderChunk(chunk)
          : capture.observeClientEvent(chunk);
      observe(sse({ choices: [{ index: 0, delta: { content: "complete" } }] }));
      observe(new Uint8Array(incomplete));
      observe(new Uint8Array());
      observe("");
      const snapshot = () =>
        boundary === "provider"
          ? capture.originalResponse()
          : capture.clientResponse();
      expect(snapshot).toThrow("Truncated rewrite stream UTF-8");
      expect(snapshot).toThrow("Truncated rewrite stream UTF-8");
      // A decoded string cannot complete a byte sequence, even if it looks
      // like the intended character. Do not silently discard pending bytes.
      expect(() => observe(": keepalive\n\n")).toThrow(
        "Invalid rewrite stream UTF-8",
      );
      expect(snapshot).toThrow("Invalid rewrite stream UTF-8");
    }
  });

  test("counts pending decoder bytes against retained provider metadata", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    const base = { type: "message", provider_extension: "" };
    const overhead =
      2 * Buffer.byteLength(JSON.stringify({ output: [] }), "utf8") +
      Buffer.byteLength(JSON.stringify(base), "utf8");
    capture.observeProviderChunk({
      type: "response.completed",
      response: {
        output: [
          {
            ...base,
            provider_extension: "x".repeat(
              RewriteStreamCapture.retentionLimit - overhead - 2,
            ),
          },
        ],
      },
    });
    capture.observeClientEvent(new Uint8Array([0xf0, 0x9f]));
    expect(() => capture.observeClientEvent(new Uint8Array([0x9a]))).toThrow(
      "Rewrite stream retention limit exceeded",
    );
    expect(() => capture.clientResponse()).toThrow(
      "Rewrite stream retention limit exceeded",
    );
    expect(() => capture.observeClientEvent(new Uint8Array([0x80]))).toThrow(
      "Rewrite stream retention limit exceeded",
    );
  });

  test("does not accumulate transient metadata or repeated done frames at the logical limit", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    const item = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "small" }],
      provider_extension: "x".repeat(7 * 1024 * 1024),
    };
    const completed = {
      type: "response.completed",
      response: { output: [item] },
    };
    capture.observeProviderChunk(completed);
    capture.observeClientEvent(sse(completed));
    const transient = sse({
      type: "response.in_progress",
      response: { usage: { transient: "y".repeat(3 * 1024 * 1024) } },
    });
    for (let repeat = 0; repeat < 3; repeat++) {
      capture.observeProviderChunk(new TextEncoder().encode(transient));
      capture.observeClientEvent(transient);
      capture.observeProviderChunk(completed);
      capture.observeClientEvent(sse(completed));
    }
    expect(capture.originalResponse()).toEqual(completed.response);
    expect(capture.clientResponse()).toEqual(completed.response);
    expect(() => capture.observeClientEvent(transient.slice(0, -1))).toThrow(
      "Rewrite stream retention limit exceeded",
    );
  });

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

  test("replaces mirrored 2MiB Responses lifecycle snapshots without accumulating done bytes", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    const text = "x".repeat(2 * 1024 * 1024);
    const item = {
      id: "msg_large",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text, annotations: [{ signed: "opaque" }] },
      ],
      provider_extension: { retained: true },
    };
    const mirror = (event: unknown) => {
      capture.observeProviderChunk(event);
      capture.observeClientEvent(sse(event));
    };
    mirror({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    for (let offset = 0; offset < text.length; offset += 256 * 1024) {
      mirror({
        type: "response.output_text.delta",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: text.slice(offset, offset + 256 * 1024),
      });
    }
    for (let repeat = 0; repeat < 4; repeat++) {
      mirror({
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        text,
      });
      mirror({ type: "response.output_item.done", output_index: 0, item });
    }
    const completed = {
      type: "response.completed",
      response: { id: "resp_large", output: [item] },
    };
    for (let repeat = 0; repeat < 4; repeat++) mirror(completed);
    expect(capture.originalResponse()).toEqual(completed.response);
    expect(capture.clientResponse()).toEqual(completed.response);
  });

  test.each([
    ["function_call", "function_call_arguments", "arguments"],
    ["custom_tool_call", "custom_tool_call_input", "input"],
  ] as const)("replaces mirrored %s done payloads instead of retaining superseded arguments", (type, eventType, field) => {
    const capture = new RewriteStreamCapture("openai:responses");
    const value = JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) });
    const item = {
      type,
      id: "item_large",
      call_id: "call_large",
      name: "execute",
      [field]: "",
      provider_extension: { signed: "opaque" },
    };
    const mirror = (event: unknown) => {
      capture.observeProviderChunk(event);
      capture.observeClientEvent(sse(event));
    };
    mirror({ type: "response.output_item.added", output_index: 0, item });
    mirror({
      type: `response.${eventType}.delta`,
      output_index: 0,
      delta: value,
    });
    for (let repeat = 0; repeat < 5; repeat++) {
      mirror({
        type: `response.${eventType}.done`,
        output_index: 0,
        [field]: value,
      });
    }
    mirror({
      type: `response.${eventType}.done`,
      output_index: 0,
      [field]: "{}",
    });
    const finalItem = {
      ...item,
      [field]: "{}",
      status: "completed",
      provider_extension: {
        signed: "opaque",
        payload: "x".repeat(6 * 1024 * 1024),
      },
    };
    mirror({
      type: "response.output_item.done",
      output_index: 0,
      item: finalItem,
    });
    const response = { output: [finalItem] };
    mirror({ type: "response.completed", response });
    expect(capture.originalResponse()).toEqual(response);
    expect(capture.clientResponse()).toEqual(response);
  });

  test("bounds simultaneous provider and client metadata after completion replaces items", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    const item = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "small" }],
      provider_extension: "x".repeat(7 * 1024 * 1024),
    };
    const completed = {
      type: "response.completed",
      response: { output: [item] },
    };
    capture.observeProviderChunk({
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
    capture.observeClientEvent(
      sse({ type: "response.output_item.done", output_index: 0, item }),
    );
    capture.observeProviderChunk(completed);
    capture.observeClientEvent(sse(completed));
    expect(() =>
      capture.observeProviderChunk({
        ...completed,
        response: {
          output: [
            { ...item, provider_extension: "x".repeat(9 * 1024 * 1024) },
          ],
        },
      }),
    ).toThrow("Rewrite stream retention limit exceeded");
    expect(capture.originalResponse()).toEqual(completed.response);
    expect(capture.clientResponse()).toEqual(completed.response);
  });

  test.each([
    "provider",
    "client",
  ] as const)("reconstructs fragmented CRLF SSE and rejects a truncated executable frame on the %s boundary", (boundary) => {
    const capture = new RewriteStreamCapture("openai:responses");
    const item = {
      type: "function_call",
      call_id: "call_fragmented",
      name: "read",
      arguments: "{}",
    };
    const event = sse({
      type: "response.output_item.done",
      output_index: 0,
      item,
    }).replaceAll("\n", "\r\n");
    const observe = (fragment: string) =>
      boundary === "provider"
        ? capture.observeProviderChunk(fragment)
        : capture.observeClientEvent(fragment);
    const snapshot = () =>
      boundary === "provider"
        ? capture.originalResponse()
        : capture.clientResponse();
    for (const character of `: keepalive\r\n\r\n${event.slice(0, -1)}`) {
      observe(character);
    }
    expect(snapshot).toThrow("Truncated rewrite stream frame");
    observe(event.slice(-1));
    expect(snapshot()).toEqual({ output: [item] });
  });

  test("counts pending client SSE together with retained provider content", () => {
    const capture = new RewriteStreamCapture("openai:responses");
    capture.observeProviderChunk({
      type: "response.output_text.delta",
      output_index: 0,
      delta: "x".repeat(8 * 1024 * 1024),
    });
    expect(() =>
      capture.observeClientEvent(`data: ${"x".repeat(8 * 1024 * 1024)}`),
    ).toThrow("Rewrite stream retention limit exceeded");
  });

  test("stops retaining content and metadata past 16MiB", () => {
    const capture = new RewriteStreamCapture("openai:chatCompletions");
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 15; i++) {
      capture.observeProviderChunk({
        choices: [{ index: 0, delta: { content: chunk } }],
      });
    }
    expect(() =>
      capture.observeProviderChunk({
        choices: [{ index: 0, delta: { content: chunk } }],
      }),
    ).toThrow("Rewrite stream retention limit exceeded");
    const response = capture.originalResponse() as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(response.choices[0].message.content).toHaveLength(15 * 1024 * 1024);
  });
});
