import { describe, expect, test } from "vitest";
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
} from "./api";

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

describe("vLLM ChatCompletionRequestSchema", () => {
  const base = {
    model: "Qwen/Qwen3.8-27B",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  test("keeps the reasoning depth, which vLLM turns into thinking", () => {
    // Validation drops whatever this schema does not name, and a dropped field
    // reaches neither the adapter nor the server — the depth would be silently
    // lost with no error anywhere.
    const result = ChatCompletionRequestSchema.safeParse({
      ...base,
      reasoning_effort: "high",
    });
    expect(result.success).toBe(true);
    expect(result.data?.reasoning_effort).toBe("high");
  });

  test("keeps a chat-template thinking switch alongside it", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      ...base,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(result.data?.chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });
});
