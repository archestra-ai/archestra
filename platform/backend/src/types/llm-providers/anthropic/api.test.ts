import { describe, expect, test } from "vitest";
import { MessagesRequestSchema, MessagesResponseSchema } from "./api";

describe("MessagesRequestSchema", () => {
  // Fastify replaces request.body with the Zod parse result, so any thinking
  // field this schema drops never reaches the upstream provider. `display` is
  // what turns thinking text on in responses: the chat client injects it for
  // models that think by default, and external proxy clients may send it
  // themselves.
  test("keeps thinking.display through body validation", () => {
    const parsed = MessagesRequestSchema.parse({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      thinking: { type: "adaptive", display: "summarized" },
    });

    expect(parsed.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  test("keeps display on extended thinking requests", () => {
    const parsed = MessagesRequestSchema.parse({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 2048, display: "omitted" },
    });

    expect(parsed.thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
      display: "omitted",
    });
  });

  test("accepts a thinking configuration without display", () => {
    const parsed = MessagesRequestSchema.parse({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      thinking: { type: "adaptive" },
    });

    expect(parsed.thinking).toEqual({ type: "adaptive" });
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
