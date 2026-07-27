import { describe, expect, test } from "vitest";
import { ChatCompletionResponseSchema, ResponsesRequestSchema } from "./api";

describe("ChatCompletionResponseSchema", () => {
  test("accepts a choice that omits index (nonconforming upstreams)", () => {
    // Some OpenAI-compatible upstreams omit `index` on choices; the response
    // schema must not fail serialization (500) on it.
    const result = ChatCompletionResponseSchema.safeParse({
      id: "chatcmpl-1",
      choices: [
        {
          finish_reason: "stop",
          logprobs: null,
          message: { content: "hi", role: "assistant" },
        },
      ],
      created: 1700000000,
      model: "some-model",
      object: "chat.completion",
    });
    expect(result.success).toBe(true);
  });
});

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
