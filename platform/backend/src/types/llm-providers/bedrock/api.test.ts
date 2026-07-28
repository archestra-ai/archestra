import { describe, expect, test } from "vitest";
import { ConverseResponseSchema } from "./api";

describe("ConverseResponseSchema", () => {
  test("accepts an unknown stopReason string", () => {
    const result = ConverseResponseSchema.safeParse({
      output: {
        message: {
          role: "assistant",
          content: [{ text: "hi" }],
        },
      },
      stopReason: "new_bedrock_reason",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(result.success).toBe(true);
  });
});
