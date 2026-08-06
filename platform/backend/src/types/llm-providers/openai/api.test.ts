import { describe, expect, test } from "vitest";
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ResponsesRequestSchema,
} from "./api";

describe("ChatCompletionRequestSchema", () => {
  test("keeps reasoning_effort and max_completion_tokens through validation", () => {
    // Fastify's zod validator replaces the body with the parsed value, so a
    // stripped field never reaches the adapter. These two carried the dual
    // LLM guardrail's reasoning-off knob and its output cap on reasoning
    // models — both were silently dropped before this pin.
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
      max_completion_tokens: 2048,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      reasoning_effort: "none",
      max_completion_tokens: 2048,
    });
  });

  test("rejects an unknown reasoning_effort value", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "turbo",
    });
    expect(result.success).toBe(false);
  });
});

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

  test("accepts a tool-call choice that omits message.content", () => {
    // Tool-call-only replies often omit `content` entirely; requiring the key
    // fails Fastify response serialization (500).
    const result = ChatCompletionResponseSchema.safeParse({
      id: "chatcmpl-2",
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
      id: "chatcmpl-3",
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
