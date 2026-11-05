// A reply with no text, tool calls or transcript leaves the conversation
// ending on the prompt, as if nothing came back. These decide when to say so.

/**
 * Why a successful reply has nothing to render, or null when it does (or
 * when the call failed, which the thread and Response view already show).
 */
export function silentReplyExplanation(params: {
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<object> }>;
  response: unknown;
  failed: boolean;
}): string | null {
  const { messages, response, failed } = params;
  if (failed || messages.length === 0 || lastReplyShows(messages)) return null;
  if (hasErrorField(response)) return null;
  const reason = stopReasonOf(response);
  const because =
    reason === "length" || reason === "max_tokens" || reason === "MAX_TOKENS"
      ? " It stopped at its output limit before writing any."
      : reason === "content_filter" || reason === "SAFETY"
        ? " The provider's content filter stopped it."
        : reason
          ? ` It stopped with reason "${reason}".`
          : "";
  return `The model returned no text, tool calls or transcript.${because}`;
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Whether the thread ends on an assistant message with something to render. */
function lastReplyShows(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<object> }>,
): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  return last.parts.some((part) => {
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type !== "text") return true;
    return typeof text === "string" && text.trim().length > 0;
  });
}

function hasErrorField(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    (response as { error?: unknown }).error != null
  );
}

/** The reason the provider gave for stopping, unless it is the ordinary one. */
function stopReasonOf(response: unknown): string | null {
  const value = response as {
    choices?: Array<{ finish_reason?: unknown }>;
    stop_reason?: unknown;
    candidates?: Array<{ finishReason?: unknown }>;
  } | null;
  const reason =
    value?.choices?.[0]?.finish_reason ??
    value?.stop_reason ??
    value?.candidates?.[0]?.finishReason;
  return typeof reason === "string" &&
    reason !== "stop" &&
    reason !== "end_turn" &&
    reason !== "STOP"
    ? reason
    : null;
}
