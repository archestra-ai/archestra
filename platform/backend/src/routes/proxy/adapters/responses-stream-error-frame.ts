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
 */
export function formatResponsesStreamErrorFrame(event: unknown): string {
  const source = (event ?? {}) as {
    error?: {
      type?: unknown;
      message?: unknown;
      code?: unknown;
      internal_code?: unknown;
    };
  };
  const type =
    typeof source.error?.type === "string" ? source.error.type : "api_error";
  const message =
    typeof source.error?.message === "string"
      ? source.error.message
      : "Upstream request failed";
  // `code` is required by the Responses error schema; the normalized Archestra
  // code is the most specific one available, and the error type is the
  // fallback so the field is never empty.
  const code =
    typeof source.error?.code === "string"
      ? source.error.code
      : typeof source.error?.internal_code === "string"
        ? source.error.internal_code
        : type;

  return `data: ${JSON.stringify({
    type: "error",
    sequence_number: 0,
    error: { type, code, message, param: null },
    // Top-level duplicates for clients that read the Responses API's own
    // documented error event rather than the AI SDK's nested shape.
    code,
    message,
    param: null,
  })}\n\n`;
}
