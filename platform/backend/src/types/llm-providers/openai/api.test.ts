import { describe, expect, test } from "vitest";
import { ResponsesRequestSchema } from "./api";

describe("ResponsesRequestSchema", () => {
  test("accepts easy-input message items that omit a top-level type", () => {
    const result = ResponsesRequestSchema.safeParse({
      model: "gpt-5.5-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(result.success).toBe(true);
  });

  test("still accepts typed input items (function calls)", () => {
    const result = ResponsesRequestSchema.safeParse({
      model: "gpt-5.5-pro",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      ],
    });
    expect(result.success).toBe(true);
  });
});
