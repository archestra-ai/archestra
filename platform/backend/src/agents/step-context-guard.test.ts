import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createStepContextGuard } from "./step-context-guard";

type SummarizeParams = { transcript: string; previousSummary: string | null };

const toolResultMessage = (value: string, toolCallId = "call_1") =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "list_workflow_runs",
        output: { type: "text", value },
      },
    ],
  }) as ModelMessage;

const assistantToolCall = (toolCallId = "call_1") =>
  ({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName: "list_workflow_runs",
        input: { repo: "archestra" },
      },
    ],
  }) as ModelMessage;

describe("createStepContextGuard — tool result capping", () => {
  test("caps an oversized tool result and keeps its toolCallId pairing", async () => {
    const guard = createStepContextGuard({ contextLength: null });
    const messages: ModelMessage[] = [
      { role: "user", content: "list the workflow runs" },
      toolResultMessage("x".repeat(400_000)),
    ];
    const { messages: result } = await guard({ messages });

    const toolMessage = result[1];
    expect(toolMessage.role).toBe("tool");
    const part = (toolMessage.content as Array<Record<string, unknown>>)[0];
    expect(part.toolCallId).toBe("call_1");
    const output = part.output as { type: string; value: string };
    expect(output.type).toBe("text");
    expect(output.value.length).toBeLessThan(110_000);
    expect(output.value).toContain("[tool result truncated");
  });

  test("returns the same array when nothing is oversized", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      toolResultMessage("small result"),
    ];
    const guard = createStepContextGuard({ contextLength: null });
    expect((await guard({ messages })).messages).toBe(messages);
  });

  test("leaves messages within the context-window budget unchanged", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const guard = createStepContextGuard({ contextLength: 100_000 });
    expect((await guard({ messages })).messages).toBe(messages);
  });
});

describe("createStepContextGuard — summarization compaction", () => {
  // budget: floor(200 * 0.8) tokens * 4 chars = 640 chars; the keep window is
  // 30% of that (~192 chars), so with 300-char turns only the last survives
  // verbatim, everything earlier is compactable, and summary + suffix fit
  // comfortably back under the budget.
  const overBudgetMessages = (): ModelMessage[] => [
    { role: "user", content: "a".repeat(300) },
    { role: "assistant", content: "b".repeat(300) },
    { role: "user", content: "c".repeat(300) },
  ];

  test("replaces the older prefix with a summary message", async () => {
    const summarize = vi.fn(
      async (_p: SummarizeParams): Promise<string | null> =>
        "the compact summary",
    );
    const guard = createStepContextGuard({
      contextLength: 200,
      summarizeTranscript: summarize,
    });
    const { messages: result } = await guard({
      messages: overBudgetMessages(),
    });

    expect(summarize).toHaveBeenCalledOnce();
    const call = summarize.mock.calls[0][0];
    expect(call.previousSummary).toBeNull();
    expect(call.transcript).toContain("a".repeat(300));

    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("untrusted conversation history");
    expect(result[0].content).toContain("the compact summary");
    expect(result[result.length - 1].content).toBe("c".repeat(300));
    // the summarized turns are gone from the step payload
    expect(result.some((m) => m.content === "a".repeat(300))).toBe(false);
  });

  test("memoizes the summary across steps and re-summarizes on further growth", async () => {
    const summarize = vi
      .fn(async (_p: SummarizeParams): Promise<string | null> => null)
      .mockResolvedValueOnce("summary v1")
      .mockResolvedValueOnce("summary v2");
    const guard = createStepContextGuard({
      contextLength: 200,
      summarizeTranscript: summarize,
    });

    const base = overBudgetMessages();
    await guard({ messages: base });
    expect(summarize).toHaveBeenCalledTimes(1);

    // next step appends a small message: memoized summary applies, no new call
    const grown = [...base, { role: "assistant", content: "ok" } as const];
    const { messages: second } = await guard({ messages: grown });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(second[0].content).toContain("summary v1");
    expect(second[second.length - 1].content).toBe("ok");

    // the run keeps growing past the budget again: re-summarize, feeding the
    // previous summary in
    const grownFurther: ModelMessage[] = [
      ...grown,
      { role: "user", content: "d".repeat(300) },
      { role: "assistant", content: "e".repeat(300) },
    ];
    const { messages: third } = await guard({ messages: grownFurther });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[1][0].previousSummary).toBe("summary v1");
    expect(third[0].content).toContain("summary v2");
  });

  test("falls back to deterministic trimming when the summarizer returns null, and stays disabled", async () => {
    const summarize = vi.fn(
      async (_p: SummarizeParams): Promise<string | null> => null,
    );
    const guard = createStepContextGuard({
      contextLength: 200,
      summarizeTranscript: summarize,
    });

    const { messages: result } = await guard({
      messages: overBudgetMessages(),
    });
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
    expect(result.some((m) => m.content === "a".repeat(300))).toBe(false);
    expect(result[result.length - 1].content).toBe("c".repeat(300));

    await guard({ messages: overBudgetMessages() });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  test("falls back to deterministic trimming when the summarizer throws", async () => {
    const guard = createStepContextGuard({
      contextLength: 200,
      summarizeTranscript: async () => {
        throw new Error("provider exploded");
      },
    });
    const { messages: result } = await guard({
      messages: overBudgetMessages(),
    });
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
  });

  test("trims when no summarizer and no model are available", async () => {
    const guard = createStepContextGuard({ contextLength: 200 });
    const { messages: result } = await guard({
      messages: overBudgetMessages(),
    });
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
  });

  test("ignores a stale memoized summary when the step messages no longer cover its boundary", async () => {
    const summarize = vi.fn(
      async (_p: SummarizeParams): Promise<string | null> => "stale summary",
    );
    const guard = createStepContextGuard({
      contextLength: 200,
      summarizeTranscript: summarize,
    });

    // first step compacts, memoizing a boundary index of 2
    await guard({ messages: overBudgetMessages() });
    expect(summarize).toHaveBeenCalledTimes(1);

    // a rebuilt, shorter message list breaks the append-only assumption; the
    // stale summary must be ignored rather than sliced past the array's end
    const rebuilt: ModelMessage[] = [{ role: "user", content: "fresh start" }];
    const { messages: result } = await guard({ messages: rebuilt });
    expect(result).toBe(rebuilt);
  });

  test("never starts the kept suffix on a tool message (pairs stay together)", async () => {
    const summarize = vi.fn(
      async (_p: SummarizeParams): Promise<string | null> => "sum",
    );
    const guard = createStepContextGuard({
      contextLength: 200,
      summarizeTranscript: summarize,
    });
    // the keep window (~192 chars) would naturally cut between the tool call
    // and its result; the boundary must advance so the pair lands wholly in
    // the summarized prefix.
    const messages: ModelMessage[] = [
      { role: "user", content: "u".repeat(600) },
      assistantToolCall(),
      toolResultMessage("r".repeat(60)),
      { role: "assistant", content: "done" },
    ];
    const { messages: result } = await guard({ messages });

    expect(summarize).toHaveBeenCalledOnce();
    const firstToolIndex = result.findIndex((m) => m.role === "tool");
    const assistantCallKept = result.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((part) => part.type === "tool-call"),
    );
    // either the pair was summarized away together, or both sides survive
    expect(firstToolIndex === -1 || assistantCallKept).toBe(true);
    if (firstToolIndex !== -1) {
      expect(result[firstToolIndex - 1]?.role).toBe("assistant");
    }
  });
});
