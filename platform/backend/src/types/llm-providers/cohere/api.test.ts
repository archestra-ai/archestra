import { describe, expect, test } from "vitest";
import { ChatResponseSchema } from "./api";

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
});
