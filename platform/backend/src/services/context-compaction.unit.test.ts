import { describe, expect, test } from "vitest";
import {
  type CompactionSummarizer,
  chooseRecentSuffixStart,
  summarizeTranscriptEntries,
  type TranscriptEntry,
  type TranscriptToolOutput,
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
          type: "tool-delete_repo",
          state: "output-denied",
          input: { repo: "x" },
          approval: { id: "ap-1", approved: false, reason: "not this one" },
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
      { kind: "tool_call", toolName: "delete_repo", input: { repo: "x" } },
      {
        kind: "tool_result",
        toolName: "delete_repo",
        output: { denied: "not this one" },
      },
      { kind: "tool_call", toolName: "lookup", input: { id: 7 } },
      { kind: "tool_result", toolName: "lookup", output: null },
    ]);
  });
});

describe("summarizeTranscriptEntries", () => {
  test("strips proxy-written members from remedy tool inputs", async () => {
    const { calls } = await summarizeRecorded({
      entries: [
        {
          kind: "tool_call",
          toolName: "mcp__gw__archestra__execute_remedy_plan",
          input: {
            offer_id: "offer-1",
            payload: "receipt-payload",
            signature: "receipt-signature",
          },
        },
      ],
    });

    expect(calls[0].transcript).toContain('"offer_id":"offer-1"');
    expect(calls[0].transcript).not.toContain("receipt-payload");
    expect(calls[0].transcript).not.toContain("receipt-signature");
  });

  test("over the chunk ceiling, folds every entry in order instead of dropping the middle", async () => {
    const entries = [
      { kind: "text" as const, role: "user", text: "TASK" },
      ...Array.from({ length: 40 }, (_, index) => ({
        kind: "text" as const,
        role: "assistant",
        text: `MIDDLE-${index} ${"a".repeat(5_000)}`,
      })),
      { kind: "text" as const, role: "user", text: "NEWEST" },
    ];
    const { summary, calls } = await summarizeRecorded({
      entries,
      previousSummary: "S0",
      preamble: "PREAMBLE",
    });

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.transcript.length).toBeLessThanOrEqual(120_000);
    }
    expect(calls.map((call) => call.transcript).join("\n")).toBe(
      entries.map((entry) => `[${entry.role}]: ${entry.text}`).join("\n"),
    );
    // Each call carries the previous one's summary forward.
    expect(calls.map((call) => call.previousSummary)).toEqual([
      "S0",
      ...calls.slice(0, -1).map((_, index) => `S${index + 1}`),
    ]);
    expect(calls.map((call) => call.preamble)).toEqual([
      ...calls.slice(0, -1).map(() => undefined),
      "PREAMBLE",
    ]);
    expect(summary).toBe(`S${calls.length}`);
  });

  test("splits a single oversized entry into continuations", async () => {
    const text = "b".repeat(300_000);
    const { calls } = await summarizeRecorded({
      entries: [{ kind: "text", role: "user", text }],
    });

    expect(calls.length).toBe(3);
    expect(
      calls
        .map((call) => call.transcript.replace(/^\[… continued\] /, ""))
        .join(""),
    ).toBe(`[user]: ${text}`);
  });

  test("sizes chunks to the summarizer's window", async () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      kind: "text" as const,
      role: "user",
      text: `${index} ${"c".repeat(9_000)}`,
    }));
    // ~90k chars fit one default chunk; a 40k-token window leaves ~45k chars.
    const { calls } = await summarizeRecorded({
      entries,
      contextLength: 40_000,
    });

    expect(calls.length).toBe(2);
  });

  test("does not compact a transcript that needs too many calls", async () => {
    const { summary, calls } = await summarizeRecorded({
      entries: Array.from({ length: 9 }, () => ({
        kind: "text" as const,
        role: "user",
        text: "d".repeat(119_000),
      })),
    });

    expect(summary).toBeNull();
    expect(calls).toEqual([]);
  });

  test("returns null when any chunk yields no summary", async () => {
    const { summary } = await summarizeRecorded({
      entries: Array.from({ length: 3 }, () => ({
        kind: "text" as const,
        role: "user",
        text: "e".repeat(100_000),
      })),
      failOnCall: 2,
    });

    expect(summary).toBeNull();
  });

  test("stops when the run is cancelled", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      summarizeRecorded({
        entries: [{ kind: "text", role: "user", text: "f" }],
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow();
  });

  test("caps a tool result keeping its start and end", async () => {
    const { calls } = await summarizeRecorded({
      entries: [
        {
          kind: "tool_result",
          toolName: "run",
          output: `START${"x".repeat(20_000)}FINAL-ERROR`,
        },
      ],
    });

    expect(calls[0].transcript.length).toBeLessThan(8_100);
    expect(calls[0].transcript).toContain("START");
    expect(calls[0].transcript).toContain("FINAL-ERROR");
  });
});

/**
 * Run the fold with a summarizer that records its inputs and answers
 * "S<call number>" (or nothing on `failOnCall`).
 */
async function summarizeRecorded(params: {
  entries: TranscriptEntry[];
  previousSummary?: string;
  preamble?: string;
  contextLength?: number;
  failOnCall?: number;
  toolOutput?: TranscriptToolOutput;
  abortSignal?: AbortSignal;
}) {
  const calls: Parameters<CompactionSummarizer>[0][] = [];
  const summary = await summarizeTranscriptEntries({
    summarize: async (call) => {
      calls.push(call);
      return calls.length === params.failOnCall ? null : `S${calls.length}`;
    },
    entries: params.entries,
    previousSummary: params.previousSummary ?? null,
    contextLength: params.contextLength ?? null,
    preamble: params.preamble,
    abortSignal: params.abortSignal,
    toolOutput: params.toolOutput ?? "included",
  });
  return { summary, calls };
}

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
