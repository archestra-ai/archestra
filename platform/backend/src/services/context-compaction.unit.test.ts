import { describe, expect, test } from "vitest";
import {
  chooseRecentSuffixStart,
  renderCompactionTranscript,
  uiMessageTranscriptEntries,
} from "./context-compaction";

describe("uiMessageTranscriptEntries", () => {
  test("projects text, file, static and dynamic tool parts, and skips unknown parts", () => {
    const entries = uiMessageTranscriptEntries({
      role: "assistant",
      parts: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "hidden" },
        { type: "file", url: "data:text/plain,abc", mediaType: "text/plain" },
        {
          type: "tool-read_file",
          state: "output-available",
          input: { path: "/a" },
          output: "contents",
        },
        {
          type: "dynamic-tool",
          toolName: "search",
          state: "input-available",
          input: { q: "x" },
        },
        {
          type: "tool-write_file",
          state: "output-error",
          input: { path: "/b" },
          errorText: "permission denied",
        },
        {
          type: "tool-lookup",
          state: "output-available",
          input: { id: 7 },
          output: null,
        },
        null,
      ],
    });

    expect(entries).toEqual([
      { kind: "text", role: "assistant", text: "hello" },
      { kind: "attachment", role: "assistant", attachment: "file" },
      { kind: "tool_call", toolName: "read_file", input: { path: "/a" } },
      { kind: "tool_result", toolName: "read_file", output: "contents" },
      { kind: "tool_call", toolName: "search", input: { q: "x" } },
      { kind: "tool_call", toolName: "write_file", input: { path: "/b" } },
      {
        kind: "tool_result",
        toolName: "write_file",
        output: { error: "permission denied" },
      },
      { kind: "tool_call", toolName: "lookup", input: { id: 7 } },
      { kind: "tool_result", toolName: "lookup", output: null },
    ]);
  });
});

describe("renderCompactionTranscript", () => {
  test("strips proxy-written members from remedy tool inputs", () => {
    const transcript = renderCompactionTranscript([
      {
        kind: "tool_call",
        toolName: "mcp__gw__archestra__execute_remedy_plan",
        input: {
          offer_id: "offer-1",
          payload: "receipt-payload",
          signature: "receipt-signature",
        },
      },
    ]);

    expect(transcript).toContain('"offer_id":"offer-1"');
    expect(transcript).not.toContain("receipt-payload");
    expect(transcript).not.toContain("receipt-signature");
  });

  test("over the ceiling, keeps the task and the newest entries and drops the middle", () => {
    const transcript = renderCompactionTranscript([
      { kind: "text", role: "user", text: "TASK: migrate the database" },
      ...Array.from({ length: 40 }, (_, index) => ({
        kind: "text" as const,
        role: "assistant",
        text: `MIDDLE-${index} ${"a".repeat(5_000)}`,
      })),
      { kind: "text", role: "user", text: "NEWEST" },
    ]);

    expect(transcript.length).toBeLessThanOrEqual(120_000);
    expect(transcript.startsWith("[user]: TASK: migrate the database")).toBe(
      true,
    );
    expect(transcript.endsWith("[user]: NEWEST")).toBe(true);
    expect(transcript).not.toContain("MIDDLE-0 ");
    expect(transcript).toContain("MIDDLE-39 ");
  });

  test("caps a tool result keeping its start and end", () => {
    const transcript = renderCompactionTranscript([
      {
        kind: "tool_result",
        toolName: "run",
        output: `START${"x".repeat(20_000)}FINAL-ERROR`,
      },
    ]);

    expect(transcript.length).toBeLessThan(8_100);
    expect(transcript).toContain("START");
    expect(transcript).toContain("FINAL-ERROR");
  });
});

describe("chooseRecentSuffixStart", () => {
  test("keeps the newest items that fit the budget", () => {
    expect(
      chooseRecentSuffixStart({
        count: 4,
        sizeOf: () => 10,
        keepBudget: 25,
      }),
    ).toBe(2);
  });

  test("always keeps the newest item even when it alone exceeds the budget", () => {
    const sizes = [1, 100];
    expect(
      chooseRecentSuffixStart({
        count: sizes.length,
        sizeOf: (index) => sizes[index],
        keepBudget: 10,
      }),
    ).toBe(1);
  });

  test("never moves below minIndex", () => {
    expect(
      chooseRecentSuffixStart({
        count: 4,
        sizeOf: () => 1,
        keepBudget: 100,
        minIndex: 2,
      }),
    ).toBe(2);
  });
});
