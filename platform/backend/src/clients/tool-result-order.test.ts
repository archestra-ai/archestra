import { describe, expect, test } from "vitest";
import { orderToolResultsByCall } from "./tool-result-order";

const call = (toolCallId: string) => ({
  type: "tool-call" as const,
  toolCallId,
  toolName: "agent__self",
  input: {},
});
const result = (toolCallId: string) => ({
  type: "tool-result" as const,
  toolCallId,
  toolName: "agent__self",
  output: { type: "text" as const, value: toolCallId },
});
const resultIds = (prompt: ReturnType<typeof orderToolResultsByCall>) =>
  prompt.flatMap((m) =>
    m.role === "tool"
      ? m.content.map((p) => (p.type === "tool-result" ? p.toolCallId : null))
      : [],
  );

describe("orderToolResultsByCall", () => {
  test("results finished out of order are put back in call order", () => {
    const prompt = orderToolResultsByCall([
      { role: "user", content: [{ type: "text", text: "review" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "forking" },
          call("a"),
          call("b"),
          call("c"),
        ],
      },
      { role: "tool", content: [result("c"), result("a"), result("b")] },
    ]);
    expect(resultIds(prompt)).toEqual(["a", "b", "c"]);
  });

  test("a result with no matching call keeps its place after the matched ones", () => {
    const prompt = orderToolResultsByCall([
      { role: "assistant", content: [call("a"), call("b")] },
      { role: "tool", content: [result("x"), result("b"), result("a")] },
    ]);
    expect(resultIds(prompt)).toEqual(["a", "b", "x"]);
  });

  test("each step is ordered by its own calls", () => {
    const prompt = orderToolResultsByCall([
      { role: "assistant", content: [call("a"), call("b")] },
      { role: "tool", content: [result("b"), result("a")] },
      { role: "assistant", content: [call("d"), call("c")] },
      { role: "tool", content: [result("c"), result("d")] },
    ]);
    expect(resultIds(prompt)).toEqual(["a", "b", "d", "c"]);
  });
});
