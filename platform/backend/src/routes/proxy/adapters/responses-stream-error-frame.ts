import { randomUUID } from "node:crypto";
import type { StreamErrorFrameContext } from "@/types/llm-provider";
import { asRecord } from "@/utils/as-record";

/**
 * Mid-stream error framing for the OpenAI Responses transport.
 *
 * Once SSE headers are committed the proxy cannot change the status code, so
 * an upstream failure has to reach the client as an in-stream event. The
 * shared fallback frame is chat-completions-shaped
 * (`{type: "error", error: {type, message}}`), which the chat-completions
 * parser surfaces because it only tests for an `error` key — but the Responses
 * parser validates every chunk against a discriminated union whose `error`
 * variant requires a top-level `sequence_number` and an `error.code`. A frame
 * missing those does not fail parsing: it matches the union's permissive
 * unknown-chunk fallback and is dropped silently. The turn then ends with no
 * content and no error, which the chat's empty-response recovery retries and
 * finally reports as an empty turn — an upstream outage rendered as a blank
 * answer.
 *
 * Emitting the Responses shape keeps the failure classifiable. Chat-completions
 * fields are kept alongside it so a client parsing either shape still finds the
 * message.
 *
 * The `error` event is followed by a `response.failed` terminal that carries
 * the same error. Codex reads a failure only from that terminal: it skips an
 * `error` event, so a stream that ends after one looks like a dropped
 * connection, which it retries five times and then reports as "stream
 * disconnected", whatever the real cause was. The terminal lets it show the
 * message and act on the code: stop on a policy, quota or context-window
 * code, retry the rest. The AI SDK ignores `response.failed`, so it reports
 * the `error` event once. The provider's own error fields (a misalignment
 * review, a retry hint) stay on the error, because clients recover from them.
 */
export function formatResponsesStreamErrorFrame(
  event: unknown,
  context: StreamErrorFrameContext = {},
): string {
  const source = asRecord(asRecord(event)?.error) ?? {};
  const type = typeof source.type === "string" ? source.type : "api_error";
  const message =
    typeof source.message === "string"
      ? source.message
      : "Upstream request failed";
  // `code` is required by the Responses error schema; the normalized Archestra
  // code is the most specific one available, and the error type is the
  // fallback so the field is never empty.
  const code =
    typeof source.code === "string"
      ? source.code
      : typeof source.internal_code === "string"
        ? source.internal_code
        : type;
  const param = typeof source.param === "string" ? source.param : null;
  const error = { ...source, type, code, message, param };
  // Above the numbers the client already received, as the adapters' own
  // synthetic events are.
  const sequenceNumber = Date.now();

  const errorFrame = `data: ${JSON.stringify({
    type: "error",
    sequence_number: sequenceNumber,
    error,
    // Top-level duplicates for clients that read the Responses API's own
    // documented error event rather than the AI SDK's nested shape.
    code,
    message,
    param,
  })}\n\n`;
  if (context.terminalSent) return errorFrame;

  return `${errorFrame}data: ${JSON.stringify({
    type: "response.failed",
    sequence_number: sequenceNumber + 1,
    response: {
      id: context.responseId || `resp_${randomUUID()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      ...(context.model ? { model: context.model } : {}),
      output: [],
      error,
      incomplete_details: null,
      usage: null,
    },
  })}\n\n`;
}

/**
 * Whether a write to the client carries a Responses terminal event. Quotes
 * inside model text are escaped in the JSON, so text cannot match.
 */
export function carriesResponsesTerminal(data: string | Uint8Array): boolean {
  return RESPONSES_TERMINAL_EVENT.test(
    typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
  );
}

const RESPONSES_TERMINAL_EVENT =
  /"type"\s*:\s*"response\.(?:completed|failed|incomplete)"/;
