import { describe, expect, test } from "vitest";
import {
  coerceMalformedToolInputs,
  stripDanglingToolCalls,
} from "./tool-call-normalization";

describe("stripDanglingToolCalls", () => {
  test("preserves multiple completed tool calls across multiple messages", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call_1",
            state: "input-available",
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call_1",
            state: "output-available",
          },
          {
            type: "tool-call",
            toolCallId: "call_2",
          },
        ],
      },
      {
        id: "assistant-3",
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: "call_2",
          },
        ],
      },
    ];

    expect(stripDanglingToolCalls(messages)).toEqual(messages);
  });

  test("removes interrupted input-available tool calls with no result", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Working on it..." },
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "input-available",
            input: { q: "weather" },
          },
        ],
      },
    ];

    expect(stripDanglingToolCalls(messages)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Working on it..." }],
      },
    ]);
  });

  test("preserves tool calls that have a matching completed result in the same message", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "input-available",
            input: { q: "weather" },
          },
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "output-available",
            output: "sunny",
          },
        ],
      },
    ];

    expect(stripDanglingToolCalls(messages)).toEqual(messages);
  });

  test("preserves tool calls when the matching result is in a later message", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "input-available",
            input: { q: "weather" },
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "output-available",
            output: "sunny",
          },
        ],
      },
    ];

    expect(stripDanglingToolCalls(messages)).toEqual(messages);
  });

  test("removes interrupted input-streaming tool calls with no result", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Let me check..." },
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "input-streaming",
            input: { q: "wea" },
          },
        ],
      },
    ];

    expect(stripDanglingToolCalls(messages)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Let me check..." }],
      },
    ]);
  });

  test("preserves an input-streaming tool call when a matching result exists", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "input-streaming",
            input: { q: "weather" },
          },
          {
            type: "tool-google__search",
            toolCallId: "call_1",
            state: "output-available",
            output: "sunny",
          },
        ],
      },
    ];

    expect(stripDanglingToolCalls(messages)).toEqual(messages);
  });

  test("preserves backend tool-call parts when a later tool-result completes them", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "call_1",
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: "call_1",
          },
        ],
      },
    ];

    expect(stripDanglingToolCalls(messages)).toEqual(messages);
  });
});

describe("coerceMalformedToolInputs", () => {
  const toolPart = (
    input: unknown,
    overrides: Record<string, unknown> = {},
  ) => ({
    type: "tool-archestra__edit_app",
    toolCallId: "call_1",
    state: "output-error",
    errorText: "boom",
    input,
    ...overrides,
  });

  const wrap = (part: Record<string, unknown>) => [
    { id: "a1", role: "assistant", parts: [part] },
  ];

  test("coerces an unparseable string input to an empty object", () => {
    const result = coerceMalformedToolInputs(wrap(toolPart('{"old_str">x')));
    expect(result[0].parts[0].input).toEqual({});
  });

  test("recovers a parsed object from a valid JSON-object string", () => {
    const result = coerceMalformedToolInputs(wrap(toolPart('{"appId":"x"}')));
    expect(result[0].parts[0].input).toEqual({ appId: "x" });
  });

  test("coerces a JSON-array string to an empty object", () => {
    const result = coerceMalformedToolInputs(wrap(toolPart("[1,2]")));
    expect(result[0].parts[0].input).toEqual({});
  });

  test.each([
    ["null", null],
    ["number", 42],
    ["boolean", true],
    ["array", [1, 2]],
    ["undefined", undefined],
  ])("coerces a non-object %s input to an empty object", (_label, input) => {
    const result = coerceMalformedToolInputs(wrap(toolPart(input)));
    expect(result[0].parts[0].input).toEqual({});
  });

  test("leaves an already-object input untouched (reference-equal)", () => {
    const messages = wrap(toolPart({ appId: "x" }));
    const result = coerceMalformedToolInputs(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result[0].parts[0]).toBe(messages[0].parts[0]);
  });

  test("covers dynamic-tool parts", () => {
    const result = coerceMalformedToolInputs(
      wrap(toolPart("garbage", { type: "dynamic-tool" })),
    );
    expect(result[0].parts[0].input).toEqual({});
  });

  test("never adds an input to a tool-result part", () => {
    const messages = wrap({
      type: "tool-result",
      toolCallId: "call_1",
      input: "stray",
    });
    const result = coerceMalformedToolInputs(messages);
    expect(result[0].parts[0]).toBe(messages[0].parts[0]);
    expect(result[0].parts[0].input).toBe("stray");
  });

  test("does not coerce a still-streaming tool part", () => {
    const messages = wrap(
      toolPart("partial", { state: "input-streaming", errorText: undefined }),
    );
    const result = coerceMalformedToolInputs(messages);
    expect(result[0].parts[0]).toBe(messages[0].parts[0]);
  });

  test("leaves a message with no coercible parts reference-equal", () => {
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ];
    expect(coerceMalformedToolInputs(messages)[0]).toBe(messages[0]);
  });
});
