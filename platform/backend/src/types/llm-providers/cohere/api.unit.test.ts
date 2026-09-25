import { describe, expect, test } from "vitest";
import { ChatRequestSchema, ChatResponseSchema } from "./api";

describe("Cohere ChatResponseSchema", () => {
  test("accepts an unknown finish_reason string", () => {
    const result = ChatResponseSchema.safeParse({
      id: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
      finish_reason: "ERROR_TOXIC",
    });
    expect(result.success).toBe(true);
  });

  test("accepts thinking content blocks from reasoning models", () => {
    const result = ChatResponseSchema.safeParse({
      id: "msg-2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "considering the question" },
          { type: "text", text: "hi" },
        ],
      },
      finish_reason: "COMPLETE",
    });
    expect(result.success).toBe(true);
  });

  test("accepts content block types it does not know yet", () => {
    // Upstream grows new block types over time; an unknown block must not
    // fail serialization of a relayed response.
    const result = ChatResponseSchema.safeParse({
      id: "msg-3",
      message: {
        role: "assistant",
        content: [
          { type: "citation", citations: [{ start: 0, end: 2 }] },
          { type: "text", text: "hi" },
        ],
      },
      finish_reason: "COMPLETE",
    });
    expect(result.success).toBe(true);
  });
});

describe("Cohere ChatRequestSchema", () => {
  test("accepts assistant history replaying thinking blocks", () => {
    const result = ChatRequestSchema.safeParse({
      model: "command-a-reasoning",
      messages: [
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "considering the question" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "follow-up" },
      ],
    });
    expect(result.success).toBe(true);
  });
});
