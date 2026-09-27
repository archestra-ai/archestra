import { describe, expect, test } from "vitest";
import { ChatCompletionRequestSchema } from "./api";

describe("Ollama ChatCompletionRequestSchema", () => {
  test("keeps the reasoning depth, which Ollama maps onto `think`", () => {
    // Validation drops whatever this schema does not name, so an undeclared
    // field never reaches the adapter and the depth is lost without an error.
    const result = ChatCompletionRequestSchema.safeParse({
      model: "qwen3",
      messages: [{ role: "user" as const, content: "hi" }],
      reasoning_effort: "low",
    });
    expect(result.success).toBe(true);
    expect(result.data?.reasoning_effort).toBe("low");
  });
});
