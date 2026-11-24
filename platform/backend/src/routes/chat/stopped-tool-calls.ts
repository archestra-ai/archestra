import type { McpToolError } from "@archestra/shared";

/**
 * Gives the tool calls a stopped run left in flight the result they had: they
 * were stopped before they finished.
 *
 * Without a result such a call is a dangling one. The persist path strips it,
 * so after a reload the call is gone, and a turn that held nothing else is
 * gone with it. With this result the call stays in the transcript, the card
 * reads Cancelled, and the model's next turn sees that the call did not
 * finish. A call still receiving its arguments is left alone: it never ran.
 *
 * Only the last message is touched, and only when it is the assistant's: that
 * is the turn the run was writing.
 */
export function settleStoppedToolCalls<
  TMessage extends { role: string; parts?: readonly unknown[] },
>(messages: TMessage[]): TMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.parts?.some(isRunningToolPart)) {
    return messages;
  }
  const parts = last.parts.map((part) =>
    isRunningToolPart(part)
      ? { ...part, state: "output-available", output: stoppedToolOutput() }
      : part,
  );
  return [...messages.slice(0, -1), { ...last, parts }];
}

// === Internal helpers ===

const STOPPED_MESSAGE =
  "The run was stopped before this call finished. The tool may have completed part of its work before the stop reached it.";

/** The same envelope a platform error has, so the card reads it as Cancelled. */
function stoppedToolOutput(): {
  content: string;
  _meta: { archestraError: McpToolError };
} {
  return {
    content: STOPPED_MESSAGE,
    _meta: { archestraError: { type: "cancelled", message: STOPPED_MESSAGE } },
  };
}

/** A tool call that has its arguments and no result yet. */
function isRunningToolPart(
  part: unknown,
): part is { type: string; state: "input-available" } {
  if (typeof part !== "object" || part === null) return false;
  const { type, state } = part as { type?: unknown; state?: unknown };
  return (
    state === "input-available" &&
    typeof type === "string" &&
    (type === "dynamic-tool" ||
      (type.startsWith("tool-") && type !== "tool-result"))
  );
}
