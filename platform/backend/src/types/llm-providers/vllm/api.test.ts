import { describe, expect, test } from "vitest";
import { ChatCompletionResponseSchema } from "./api";

describe("vLLM ChatCompletionResponseSchema", () => {
  test("accepts a tool-call choice that omits message.content", () => {
    const result = ChatCompletionResponseSchema.safeParse({
      id: "chatcmpl-1",
      choices: [
        {
          finish_reason: "tool_calls",
          index: 0,
          logprobs: null,
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search", arguments: "{}" },
              },
            ],
          },
        },
      ],
      created: 1700000000,
      model: "some-model",
      object: "chat.completion",
    });
    expect(result.success).toBe(true);
  });

  test("accepts an unknown finish_reason string", () => {
    const result = ChatCompletionResponseSchema.safeParse({
      id: "chatcmpl-2",
      choices: [
        {
          finish_reason: "weird_provider_reason",
          index: 0,
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
