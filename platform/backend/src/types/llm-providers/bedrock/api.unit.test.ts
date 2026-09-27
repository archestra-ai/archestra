import { describe, expect, test } from "vitest";
import { ConverseResponseSchema } from "./api";

describe("ConverseResponseSchema", () => {
  test("accepts documented malformed_* stopReasons", () => {
    for (const stopReason of [
      "malformed_model_output",
      "malformed_tool_use",
    ] as const) {
      const result = ConverseResponseSchema.safeParse({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "hi" }],
          },
        },
        stopReason,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      expect(result.success).toBe(true);
    }
  });

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

// Extended thinking puts a `reasoningContent` block in the assistant message
// alongside the answer. The proxy validates its own upstream response against
// this schema, so a shape it does not model never reaches the client.
describe("ConverseResponseSchema reasoning blocks", () => {
  function parseWithReasoning(reasoningContent: unknown) {
    return ConverseResponseSchema.safeParse({
      output: {
        message: {
          role: "assistant",
          content: [{ reasoningContent }, { text: "42" }],
        },
      },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  test("accepts a reasoningText block", () => {
    expect(
      parseWithReasoning({
        reasoningText: { text: "6 times 7", signature: "sig_abc123" },
      }).success,
    ).toBe(true);
  });

  test("accepts a redactedContent block", () => {
    const result = parseWithReasoning({ redactedContent: "abc123==" });

    expect(result.success).toBe(true);
    // Serialization must not drop the blob — it is the only thing a redacted
    // block carries, and the next turn has to echo it back.
    expect(result.data?.output.message?.content[0]).toEqual({
      reasoningContent: { redactedContent: "abc123==" },
    });
  });
});
