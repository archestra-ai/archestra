import { describe, expect, test } from "vitest";
import { stripDanglingToolCalls } from "./tool-call-normalization";

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
