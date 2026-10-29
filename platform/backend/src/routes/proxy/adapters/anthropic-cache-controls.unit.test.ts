import { describe, expect, test } from "vitest";
import type { OpenAi } from "@/types";
import { openaiToAnthropic } from "./anthropic-openai-translator";

const marker = { type: "ephemeral", ttl: "5m" } as const;
function translate(messages: unknown[], extra = {}) {
  return openaiToAnthropic({
    model: "claude-sonnet-4-6",
    messages,
    ...extra,
  } as OpenAi.Types.ChatCompletionsRequest).anthropicBody;
}

describe("caller cache boundaries", () => {
  test.each([
    "system",
    "developer",
  ])("keeps a %s breakpoint before later unmarked text", (role) => {
    const messages = [
      {
        role,
        content: [
          { type: "text", text: "stable", cache_control: marker },
          { type: "text", text: "changing" },
        ],
      },
    ];
    const original = structuredClone(messages);
    expect(translate(messages).system).toEqual([
      { type: "text", text: "stable", cache_control: marker },
      { type: "text", text: "changing" },
    ]);
    expect(messages).toEqual(original);
  });

  test.each([
    "user",
    "assistant",
  ])("places a %s message marker on its final block", (role) => {
    const result = translate([
      { role, content: "answer", cache_control: marker },
    ]);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "answer", cache_control: marker },
    ]);
  });

  test("marks the tool-use boundary when the assistant has no text", () => {
    const result = translate([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
        cache_control: marker,
      },
    ]);
    expect(result.messages[0].content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: {},
        cache_control: marker,
      },
    ]);
  });

  test("preserves a marker on a tool result without extending it to the next user turn", () => {
    const result = translate([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "result",
        cache_control: marker,
      },
      { role: "user", content: "next" },
    ]);
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "result",
            cache_control: marker,
          },
        ],
      },
      { role: "user", content: "next" },
    ]);
  });

  test("keeps image and PDF markers on their converted blocks", () => {
    const result = translate([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
            cache_control: marker,
          },
          {
            type: "file",
            file: { file_data: "data:application/pdf;base64,cGRm" },
            cache_control: marker,
          },
        ],
      },
    ]);
    expect(result.messages[0].content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        cache_control: marker,
      },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
        cache_control: marker,
      },
    ]);
  });

  test.each([
    [
      {
        role: "function",
        name: "lookup",
        content: "result",
        cache_control: marker,
      },
    ],
    [
      {
        role: "assistant",
        content: [{ type: "refusal", refusal: "no", cache_control: marker }],
      },
    ],
    [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: "YQ==", format: "wav" },
            cache_control: marker,
          },
        ],
      },
    ],
    [
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { file_id: "file_external" },
            cache_control: marker,
          },
        ],
      },
    ],
    [{ role: "user", content: "", cache_control: marker }],
    [
      {
        role: "user",
        content: [{ type: "text", text: "", cache_control: marker }],
      },
    ],
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "prefix",
            cache_control: { ...marker, ttl: "1h" },
          },
        ],
        cache_control: marker,
      },
    ],
  ])("rejects a boundary it cannot faithfully represent: %j", (message) => {
    expect(() => translate([message])).toThrow(/cache_control/);
  });

  test("does not confuse property ordering with conflicting controls", () => {
    expect(() =>
      translate([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "prefix",
              cache_control: { ttl: "5m", type: "ephemeral" },
            },
          ],
          cache_control: marker,
        },
      ]),
    ).not.toThrow();
  });
});
