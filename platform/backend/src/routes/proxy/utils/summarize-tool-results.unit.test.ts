import { describe, expect, test } from "vitest";
import { stripBrowserToolsResults } from "./summarize-tool-results";

const SNAPSHOT_TOOL = "microsoft__playwright-mcp__browser_snapshot";

type TestMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function snapshot(id: string, size = 3000): string {
  return `### Page state\n- Page URL: https://example.com/${id}\n${"x".repeat(size)}`;
}

function browserCalls(
  calls: Array<{ id: string; content: string; name?: string }>,
): TestMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: calls.map(({ id, name }) => ({
        id,
        type: "function",
        function: { name: name ?? SNAPSHOT_TOOL, arguments: "{}" },
      })),
    },
    ...calls.map(
      ({ id, content }): TestMessage => ({
        role: "tool",
        content,
        tool_call_id: id,
      }),
    ),
  ];
}

function snapshotTurns(count: number, size?: number): TestMessage[] {
  return Array.from({ length: count }, (_, i) => [
    ...browserCalls([{ id: `call_${i}`, content: snapshot(`${i}`, size) }]),
    { role: "assistant" as const, content: `looked at page ${i}` },
  ]).flat();
}

function toolContents(messages: TestMessage[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content);
}

describe("stripBrowserToolsResults", () => {
  test("keeps up to three browser calls raw", () => {
    const messages = snapshotTurns(3);

    expect(stripBrowserToolsResults(messages)).toEqual(messages);
  });

  test("strips the older batch once a fourth browser call arrives", () => {
    const result = stripBrowserToolsResults(snapshotTurns(4));

    expect(toolContents(result)).toEqual([
      "[Page https://example.com/0 browser_snapshot was here]",
      "[Page https://example.com/1 browser_snapshot was here]",
      "[Page https://example.com/2 browser_snapshot was here]",
      snapshot("3"),
    ]);
  });

  test("an appended turn keeps the rewritten prefix except when a batch is stripped", () => {
    const changedAt: number[] = [];
    for (let count = 1; count < 10; count++) {
      const before = stripBrowserToolsResults(snapshotTurns(count));
      const after = stripBrowserToolsResults(snapshotTurns(count + 1));
      if (
        JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)
      ) {
        changedAt.push(count + 1);
      }
    }

    expect(changedAt).toEqual([4, 7, 10]);
  });

  test("strips before the batch fills once the kept raw results grow too large", () => {
    const result = stripBrowserToolsResults(snapshotTurns(3, 60_000));

    expect(toolContents(result)).toEqual([
      "[Page https://example.com/0 browser_snapshot was here]",
      "[Page https://example.com/1 browser_snapshot was here]",
      snapshot("2", 60_000),
    ]);
  });

  test("keeps every result of the newest parallel batch", () => {
    const parallel = ["a", "b", "c", "d"].map((id) => ({
      id: `call_${id}`,
      content: snapshot(id),
    }));
    const messages = [...snapshotTurns(3), ...browserCalls(parallel)];

    const result = toolContents(stripBrowserToolsResults(messages));

    expect(result).toEqual([
      "[Page https://example.com/0 browser_snapshot was here]",
      "[Page https://example.com/1 browser_snapshot was here]",
      "[Page https://example.com/2 browser_snapshot was here]",
      ...parallel.map(({ content }) => content),
    ]);
  });

  test("does not strip small tool results", () => {
    const messages = [
      ...browserCalls([{ id: "small", content: "Navigation successful" }]),
      ...snapshotTurns(4),
    ];

    const result = stripBrowserToolsResults(messages);

    expect(result[1].content).toBe("Navigation successful");
  });

  test("does not strip non-browser tool results", () => {
    const largeContent = "x".repeat(5000);
    const messages = [
      ...browserCalls([
        { id: "call_other", content: largeContent, name: "some_other_tool" },
      ]),
      ...snapshotTurns(4),
    ];

    const result = stripBrowserToolsResults(messages);

    expect(result[1].content).toBe(largeContent);
  });

  test("handles messages without tool_calls array", () => {
    const messages: TestMessage[] = [
      { content: "Hello", role: "user" },
      { role: "assistant", content: "Hi there!" },
    ];

    expect(stripBrowserToolsResults(messages)).toEqual(messages);
  });
});
