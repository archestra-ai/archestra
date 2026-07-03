import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import { guardStepMessages } from "./step-context-guard";

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

describe("guardStepMessages", () => {
  test("caps an oversized tool result and keeps its toolCallId pairing", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "list the workflow runs" },
      toolResultMessage("x".repeat(400_000)),
    ];
    const result = guardStepMessages({ messages, contextLength: null });

    const toolMessage = result[1];
    expect(toolMessage.role).toBe("tool");
    const part = (toolMessage.content as Array<Record<string, unknown>>)[0];
    expect(part.toolCallId).toBe("call_1");
    const output = part.output as { type: string; value: string };
    expect(output.type).toBe("text");
    expect(output.value.length).toBeLessThan(110_000);
    expect(output.value).toContain("[tool result truncated");
  });

  test("returns the same array when nothing is oversized", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      toolResultMessage("small result"),
    ];
    expect(guardStepMessages({ messages, contextLength: null })).toBe(messages);
  });

  test("trims accumulated messages to the context-window budget", () => {
    // budget: floor(100 * 0.8) tokens * 4 chars = 320 chars; three 200-char
    // turns exceed it, so the oldest is dropped and a trim note is prepended.
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(200) },
      { role: "assistant", content: "b".repeat(200) },
      { role: "user", content: "c".repeat(200) },
    ];
    const result = guardStepMessages({ messages, contextLength: 100 });
    expect(result.some((m) => m.content === "a".repeat(200))).toBe(false);
    expect(result[result.length - 1].content).toBe("c".repeat(200));
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
  });

  test("leaves messages within the context-window budget unchanged", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    expect(guardStepMessages({ messages, contextLength: 100_000 })).toBe(
      messages,
    );
  });
});
