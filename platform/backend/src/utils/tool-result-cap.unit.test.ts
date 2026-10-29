import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import {
  CAPPED_TOOL_RESULT_META_KEY,
  capToolResultText,
  MAX_TOOL_RESULT_CONTEXT_BYTES,
  projectCappedToolOutputs,
} from "./tool-result-cap";

describe("capToolResultText", () => {
  test("keeps the notice first and the suffix last within the cap", () => {
    const text = "x".repeat(MAX_TOOL_RESULT_CONTEXT_BYTES * 3);
    const capped = capToolResultText({
      text,
      path: "/home/sandbox/tool-results/a.txt",
      suffix: "\n\n[hook feedback] stop",
    });

    expect(Buffer.byteLength(capped, "utf8")).toBe(
      MAX_TOOL_RESULT_CONTEXT_BYTES,
    );
    expect(capped.startsWith("[Tool result too large")).toBe(true);
    expect(capped.slice(0, 300)).toContain("/home/sandbox/tool-results/a.txt");
    expect(capped.endsWith("\n\n[hook feedback] stop")).toBe(true);
  });

  test("caps by UTF-8 bytes without splitting a character", () => {
    const capped = capToolResultText({
      text: "é".repeat(MAX_TOOL_RESULT_CONTEXT_BYTES),
      path: null,
      suffix: "",
    });

    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_CONTEXT_BYTES,
    );
    expect(capped).not.toContain("\uFFFD");
    expect(capped.endsWith("é")).toBe(true);
  });

  test("stays within the cap when the suffix alone exceeds it", () => {
    const capped = capToolResultText({
      text: "x".repeat(MAX_TOOL_RESULT_CONTEXT_BYTES * 2),
      path: null,
      suffix: "f".repeat(MAX_TOOL_RESULT_CONTEXT_BYTES * 2),
    });

    expect(Buffer.byteLength(capped, "utf8")).toBe(
      MAX_TOOL_RESULT_CONTEXT_BYTES,
    );
    expect(capped.startsWith("[Tool result too large")).toBe(true);
  });
});

describe("projectCappedToolOutputs", () => {
  const capped = {
    content: "capped text",
    structuredContent: { rows: "huge".repeat(1000) },
    rawContent: [{ type: "text", text: "huge".repeat(1000) }],
    _meta: { [CAPPED_TOOL_RESULT_META_KEY]: { totalChars: 4000 } },
  };
  const uncapped = {
    content: "small text",
    structuredContent: { rows: [1] },
  };

  const messages = [
    {
      id: "a1",
      role: "assistant" as const,
      parts: [
        {
          type: "dynamic-tool",
          toolName: "srv__list",
          toolCallId: "c1",
          state: "output-available",
          input: {},
          output: capped,
        },
        {
          type: "tool-srv__get",
          toolCallId: "c2",
          state: "output-available",
          input: {},
          output: capped,
        },
        {
          type: "dynamic-tool",
          toolName: "srv__small",
          toolCallId: "c3",
          state: "output-available",
          input: {},
          output: uncapped,
        },
      ],
    },
  ];

  test("replays capped outputs as their text, leaving other outputs alone", async () => {
    const modelMessages = await convertToModelMessages(
      projectCappedToolOutputs(messages) as unknown as Omit<UIMessage, "id">[],
    );
    const outputs = modelMessages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "tool-result" ? [part.output] : [],
          )
        : [],
    );

    expect(outputs).toEqual([
      { type: "text", value: "capped text" },
      { type: "text", value: "capped text" },
      { type: "json", value: uncapped },
    ]);
  });

  test("returns the same array when nothing is capped", () => {
    const plain = [
      { role: "user" as const, parts: [{ type: "text", text: "hi" }] },
    ];
    expect(projectCappedToolOutputs(plain)).toBe(plain);
  });
});
