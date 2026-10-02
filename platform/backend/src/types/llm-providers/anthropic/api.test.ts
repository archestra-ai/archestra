import { describe, expect, test } from "vitest";
import { MessagesRequestSchema, MessagesResponseSchema } from "./api";

describe("MessagesRequestSchema", () => {
  // Fastify replaces request.body with the Zod parse result, so any thinking
  // field this schema drops never reaches the upstream provider, and any value
  // it rejects fails the whole request with a 400. `display` is what turns
  // thinking text on in responses: the chat client injects it for models that
  // think by default, and external proxy clients may send it themselves.
  test.each([
    { type: "adaptive" },
    { type: "adaptive", display: "summarized" },
    { type: "enabled", budget_tokens: 2048, display: "omitted" },
    // Claude Code sends this on interactive requests.
    { type: "adaptive", display: "updates" },
    {
      type: "enabled",
      budget_tokens: 2048,
      display: "updates",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
    { type: "between_tools" },
    { type: "adaptive", display: "summarized", option_from_a_future_beta: 1 },
    { type: "mode_from_a_future_beta", option_from_a_future_beta: 1 },
  ])("keeps thinking config %j through body validation", (thinking) => {
    const parsed = MessagesRequestSchema.parse({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      thinking,
    });

    expect(parsed.thinking).toEqual(thinking);
  });
});

describe("MessagesResponseSchema", () => {
  test("accepts a response that omits stop_sequence", () => {
    const result = MessagesResponseSchema.safeParse({
      id: "msg_1",
      content: [{ type: "text", text: "hi", citations: null }],
      model: "claude-sonnet-4-5",
      role: "assistant",
      stop_reason: "end_turn",
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(result.success).toBe(true);
  });
});
