import { describe, expect, test } from "vitest";
import {
  InteractionErrorResponseSchema,
  InteractionResponseSchema,
  normalizeInteractionResponse,
} from "@/types";

const validOpenAiResponse = {
  id: "test-response",
  object: "chat.completion",
  created: 1,
  model: "gpt-4",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi there", refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
};

const validEmbeddingResponse = {
  object: "list",
  data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
  model: "text-embedding-004",
  usage: { prompt_tokens: 1, total_tokens: 1 },
};

const MALFORMED_SENTINEL = { error: "Malformed stored interaction response" };

describe("normalizeInteractionResponse", () => {
  test("returns a valid provider response unchanged", () => {
    expect(
      normalizeInteractionResponse(
        "openai:chatCompletions",
        validOpenAiResponse,
      ),
    ).toBe(validOpenAiResponse);
  });

  test("preserves a persisted { error } response instead of coercing it", () => {
    const errorResponse = {
      error: "Upstream provider returned an error response",
    };
    expect(
      normalizeInteractionResponse("openai:chatCompletions", errorResponse),
    ).toBe(errorResponse);
  });

  test("coerces a response matching no provider schema to the sentinel", () => {
    expect(
      normalizeInteractionResponse("openai:chatCompletions", {
        unexpected: "shape",
      }),
    ).toEqual(MALFORMED_SENTINEL);
  });

  test("coerces a null response to the sentinel", () => {
    expect(
      normalizeInteractionResponse("openai:chatCompletions", null),
    ).toEqual(MALFORMED_SENTINEL);
  });

  test("coerces a non-string { error } to the sentinel", () => {
    expect(
      normalizeInteractionResponse("openai:chatCompletions", { error: 123 }),
    ).toEqual(MALFORMED_SENTINEL);
  });

  test("accepts a gemini:embeddings response via the OpenAI-compatible arm", () => {
    expect(
      normalizeInteractionResponse("gemini:embeddings", validEmbeddingResponse),
    ).toBe(validEmbeddingResponse);
  });

  test("passes the response through unchanged when the type has no read arm", () => {
    const response = { whatever: true };
    expect(normalizeInteractionResponse("totally:unknown", response)).toBe(
      response,
    );
  });
});

describe("interaction response schemas accept the persisted error shape", () => {
  test("InteractionErrorResponseSchema requires a string error", () => {
    expect(
      InteractionErrorResponseSchema.safeParse({ error: "boom" }).success,
    ).toBe(true);
    expect(
      InteractionErrorResponseSchema.safeParse({ error: 123 }).success,
    ).toBe(false);
    expect(InteractionErrorResponseSchema.safeParse({}).success).toBe(false);
  });

  test("InteractionResponseSchema accepts an { error } response on the write path", () => {
    expect(InteractionResponseSchema.safeParse({ error: "boom" }).success).toBe(
      true,
    );
  });
});
