import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  carriesResponsesTerminal,
  formatResponsesStreamErrorFrame,
} from "./responses-stream-error-frame";

/** The SSE events a frame string carries, in order. */
const parseEvents = (frame: string) => {
  expect(frame.endsWith("\n\n")).toBe(true);
  return frame
    .split("\n\n")
    .filter(Boolean)
    .map((event) => {
      expect(event.startsWith("data: ")).toBe(true);
      return JSON.parse(event.slice("data: ".length));
    });
};

/** The `error` event, which every frame starts with. */
const parseErrorEvent = (frame: string) => parseEvents(frame)[0];

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

/**
 * Mirrors how Codex (codex-api `sse/responses.rs`) ends a turn: it skips
 * `error` events and takes the failure from the last `response.failed`. With
 * none, the stream reads as a dropped connection that Codex retries, then
 * reports as "stream closed before response.completed".
 */
const codexFailure = (events: Array<{ type: string; response?: unknown }>) => {
  const failed = events.filter((event) => event.type === "response.failed");
  return (failed.at(-1)?.response as { error?: unknown } | undefined)?.error;
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
  const events = parseEvents(
    formatResponsesStreamErrorFrame({
      type: "error",
      error: {
        type: "server_error",
        message: "Our servers are overloaded.",
        code: "server_is_overloaded",
      },
    }),
  );
  expect(events.map(classify)).toEqual(["surfaced", "dropped"]);
});

describe("formatResponsesStreamErrorFrame", () => {
  test("carries the fields the Responses error variant requires", () => {
    const parsed = parseErrorEvent(
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
      parseErrorEvent(
        formatResponsesStreamErrorFrame({
          type: "error",
          error: { type: "api_error", message: "boom" },
        }),
      ).error.code,
    ).toBe("api_error");

    expect(
      parseErrorEvent(
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
    const events = parseEvents(formatResponsesStreamErrorFrame(undefined));
    expect(events[0]).toMatchObject({
      type: "error",
      sequence_number: expect.any(Number),
      error: {
        type: "api_error",
        code: "api_error",
        message: "Upstream request failed",
      },
    });
    expect(codexFailure(events)).toMatchObject({ code: "api_error" });
  });

  test("ends the stream with a failure terminal, so Codex reports the cause instead of a dropped connection", () => {
    const events = parseEvents(
      formatResponsesStreamErrorFrame(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: "Your input exceeds the context window of this model.",
          },
        },
        { responseId: "resp_upstream", model: "gpt-6.1-sol" },
      ),
    );

    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: {
        id: "resp_upstream",
        object: "response",
        status: "failed",
        model: "gpt-6.1-sol",
      },
    });
    expect(codexFailure(events)).toEqual(events[0].error);
    expect(codexFailure(events)).toMatchObject({
      code: "context_length_exceeded",
      message: "Your input exceeds the context window of this model.",
    });
  });

  test("keeps the provider's own error fields that clients recover from", () => {
    const misalignment = {
      error_type: "other",
      detailed_explanation: "The agent turned off a safety check.",
      steer: { message: "Follow the user's instructions." },
    };
    const events = parseEvents(
      formatResponsesStreamErrorFrame({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "misalignment_policy_violation",
          message: "This request was blocked by our safety systems.",
          misalignment,
        },
      }),
    );

    expect(events[0].error.misalignment).toEqual(misalignment);
    expect(codexFailure(events)).toMatchObject({
      code: "misalignment_policy_violation",
      misalignment,
    });
  });

  test("does not end the response again after a terminal the client already has", () => {
    const events = parseEvents(
      formatResponsesStreamErrorFrame(
        {
          type: "error",
          error: { type: "server_error", message: "settlement failed" },
        },
        { terminalSent: true },
      ),
    );
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  test("numbers its events after the ones the client already received", () => {
    const relayedUntil = Date.now();
    const [error, failed] = parseEvents(
      formatResponsesStreamErrorFrame({
        type: "error",
        error: { type: "server_error", message: "Upstream request failed" },
      }),
    );
    expect(error.sequence_number).toBeGreaterThanOrEqual(relayedUntil);
    expect(failed.sequence_number).toBe(error.sequence_number + 1);
  });
});

describe("carriesResponsesTerminal", () => {
  const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

  test("finds each terminal event, also in bytes", () => {
    for (const type of [
      "response.completed",
      "response.failed",
      "response.incomplete",
    ])
      expect(carriesResponsesTerminal(sse({ type, response: {} }))).toBe(true);
    expect(
      carriesResponsesTerminal(
        new TextEncoder().encode(sse({ type: "response.completed" })),
      ),
    ).toBe(true);
  });

  test("ignores other events, also when the model's text names a terminal", () => {
    expect(carriesResponsesTerminal(sse({ type: "response.created" }))).toBe(
      false,
    );
    expect(
      carriesResponsesTerminal(
        sse({
          type: "response.output_text.delta",
          delta: '{"type":"response.completed"}',
        }),
      ),
    ).toBe(false);
  });
});
