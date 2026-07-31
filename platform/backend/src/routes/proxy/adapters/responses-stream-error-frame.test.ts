import { describe, expect, test } from "vitest";
import { z } from "zod";
import { formatResponsesStreamErrorFrame } from "./responses-stream-error-frame";

const parseFrame = (frame: string) => {
  expect(frame.startsWith("data: ")).toBe(true);
  expect(frame.endsWith("\n\n")).toBe(true);
  return JSON.parse(frame.slice("data: ".length).trim());
};

/**
 * Mirrors the two @ai-sdk/openai Responses-stream union members that decide
 * this frame's fate: the `error` variant it must match, and the permissive
 * fallback that silently swallows anything else. Kept in the test rather than
 * imported because the SDK does not export the schema.
 */
const AI_SDK_RESPONSES_CHUNK = z.union([
  z.object({
    type: z.literal("error"),
    sequence_number: z.number(),
    error: z.object({
      type: z.string(),
      code: z.string(),
      message: z.string(),
      param: z.string().nullish(),
    }),
  }),
  z
    .object({ type: z.string() })
    .loose()
    .transform((value) => ({ type: "unknown_chunk", message: value.type })),
]);

/** What the SDK's transform does with a chunk: surface it, or drop it. */
const classify = (chunk: unknown) => {
  const parsed = AI_SDK_RESPONSES_CHUNK.parse(chunk);
  return parsed.type === "error" ? "surfaced" : "dropped";
};

test("the shared chat-completions frame is silently dropped by the Responses parser", () => {
  // The regression this file exists for.
  expect(
    classify({
      type: "error",
      error: { type: "api_error", message: "Our servers are overloaded." },
    }),
  ).toBe("dropped");
});

test("the Responses-shaped frame is surfaced as an error", () => {
  expect(
    classify(
      parseFrame(
        formatResponsesStreamErrorFrame({
          type: "error",
          error: {
            type: "server_error",
            message: "Our servers are overloaded.",
            code: "server_is_overloaded",
          },
        }),
      ),
    ),
  ).toBe("surfaced");
});

describe("formatResponsesStreamErrorFrame", () => {
  test("carries the fields the Responses error variant requires", () => {
    const parsed = parseFrame(
      formatResponsesStreamErrorFrame({
        type: "error",
        error: {
          type: "server_error",
          message: "Our servers are currently overloaded.",
          code: "server_is_overloaded",
        },
      }),
    );

    expect(parsed).toMatchObject({
      type: "error",
      sequence_number: expect.any(Number),
      error: {
        type: "server_error",
        code: "server_is_overloaded",
        message: "Our servers are currently overloaded.",
        param: null,
      },
    });
    // Duplicated at the top level for clients reading the Responses API's own
    // documented error event rather than the nested shape.
    expect(parsed.message).toBe("Our servers are currently overloaded.");
    expect(parsed.code).toBe("server_is_overloaded");
  });

  test("falls back to the error type as the code, and keeps the normalized internal code when present", () => {
    expect(
      parseFrame(
        formatResponsesStreamErrorFrame({
          type: "error",
          error: { type: "api_error", message: "boom" },
        }),
      ).error.code,
    ).toBe("api_error");

    expect(
      parseFrame(
        formatResponsesStreamErrorFrame({
          type: "error",
          error: {
            type: "api_error",
            message: "no balance",
            internal_code: "provider_insufficient_balance",
          },
        }),
      ).error.code,
    ).toBe("provider_insufficient_balance");
  });

  test("stays well-formed for a malformed or empty event", () => {
    const parsed = parseFrame(formatResponsesStreamErrorFrame(undefined));
    expect(parsed).toMatchObject({
      type: "error",
      sequence_number: expect.any(Number),
      error: {
        type: "api_error",
        code: "api_error",
        message: "Upstream request failed",
      },
    });
  });
});
