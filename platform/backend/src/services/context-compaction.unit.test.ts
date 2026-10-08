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
        null,
      ],
    });

    expect(entries).toEqual([
      { kind: "text", role: "assistant", text: "hello" },
      { kind: "attachment", role: "assistant", attachment: "file" },
      { kind: "tool_call", toolName: "read_file", input: { path: "/a" } },
      { kind: "tool_result", toolName: "read_file", output: "contents" },
      { kind: "tool_call", toolName: "search", input: { q: "x" } },
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

  test("keeps the most recent content when over the transcript ceiling", () => {
    const transcript = renderCompactionTranscript([
      { kind: "text", role: "user", text: `OLDEST ${"a".repeat(130_000)}` },
      { kind: "text", role: "user", text: "NEWEST" },
    ]);

    expect(transcript.length).toBeLessThanOrEqual(120_000);
    expect(transcript).not.toContain("OLDEST");
    expect(transcript.endsWith("NEWEST")).toBe(true);
  });
});

describe("chooseRecentSuffixStart", () => {
  test("keeps the newest items that fit the budget", () => {
    expect(
      chooseRecentSuffixStart({ sizes: [10, 10, 10, 10], keepBudget: 25 }),
    ).toBe(2);
  });

  test("always keeps the newest item even when it alone exceeds the budget", () => {
    expect(chooseRecentSuffixStart({ sizes: [1, 100], keepBudget: 10 })).toBe(
      1,
    );
  });

  test("never moves below minIndex", () => {
    expect(
      chooseRecentSuffixStart({
        sizes: [1, 1, 1, 1],
        keepBudget: 100,
        minIndex: 2,
      }),
    ).toBe(2);
  });
});
