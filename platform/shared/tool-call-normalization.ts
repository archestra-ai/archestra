import type { McpToolError } from "./mcp-tool-error";

type ToolPartLike = {
  state?: unknown;
  toolCallId?: unknown;
  type?: unknown;
};

type ToolInputPartLike = ToolPartLike & {
  input?: unknown;
};

type MessageWithParts<TPart extends ToolPartLike> = {
  parts?: TPart[];
};

export function stripDanglingToolCalls<
  TPart extends ToolPartLike,
  TMessage extends MessageWithParts<TPart>,
>(messages: TMessage[]): TMessage[] {
  const completedToolCallIds = collectCompletedToolCallIds(messages);

  return messages.map((message) => {
    if (!message.parts?.length) {
      return message;
    }

    const sanitizedParts = message.parts.filter((part) => {
      if (typeof part.toolCallId !== "string" || !isPendingToolPart(part)) {
        return true;
      }

      return completedToolCallIds.has(part.toolCallId);
    });

    if (sanitizedParts.length === message.parts.length) {
      return message;
    }

    return {
      ...message,
      parts: sanitizedParts,
    };
  });
}

function collectCompletedToolCallIds<
  TPart extends ToolPartLike,
  TMessage extends MessageWithParts<TPart>,
>(messages: TMessage[]) {
  const completedToolCallIds = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (typeof part.toolCallId === "string" && isCompletedToolPart(part)) {
        completedToolCallIds.add(part.toolCallId);
      }
    }
  }

  return completedToolCallIds;
}

/**
 * Gives the tool calls a stopped run left in flight the result they had: they
 * were stopped before they finished.
 *
 * Without a result such a call is a dangling one, which
 * {@link stripDanglingToolCalls} removes: after a reload the call is gone,
 * and a turn that held nothing else is gone with it. With this result the
 * call stays in the transcript, its card reads Cancelled, and the model's
 * next turn sees that the call did not finish. A call still receiving its
 * arguments is left alone: it never ran.
 *
 * Only the last message is touched, and only when it is the assistant's: that
 * is the turn the run was writing. The backend applies this before it stores
 * a stopped turn and the chat applies it to its own copy, so the open chat
 * and a reloaded one hold the same turn.
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

// Anthropic (and other providers) require every `tool_use` block's `input` to be
// a JSON object. A model can stream malformed tool-argument JSON that the AI SDK
// fails to parse, leaving the persisted tool-call part with a non-object `input`
// (a raw string, or nothing at all). Replaying that history then fails provider
// validation on every turn, permanently bricking the conversation. Repair such
// parts to an object so the history stays replayable: recover a parsed object
// from a JSON string when possible, otherwise fall back to an empty object.
export function coerceMalformedToolInputs<
  TPart extends ToolInputPartLike,
  TMessage extends MessageWithParts<TPart>,
>(messages: TMessage[]): TMessage[] {
  return messages.map((message) => {
    if (!message.parts?.length) {
      return message;
    }

    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isCoercibleToolCallPart(part) || isPlainObject(part.input)) {
        return part;
      }
      changed = true;
      return { ...part, input: coerceToolInputValue(part.input) } as TPart;
    });

    return changed ? { ...message, parts } : message;
  });
}

// A part that converts to a provider `tool_use` block and therefore needs an
// object `input`. Excludes `tool-result` (it carries output, not input) and
// `input-streaming` parts (still mid-stream, no complete input yet).
function isCoercibleToolCallPart(part: ToolInputPartLike): boolean {
  if (part.state === "input-streaming") {
    return false;
  }
  if (part.type === "dynamic-tool") {
    return true;
  }
  return (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    part.type !== "tool-result"
  );
}

function coerceToolInputValue(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {
      // unparseable remnant — fall through to an empty object
    }
  }
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompletedToolPart(part: ToolPartLike) {
  return (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied" ||
    part.type === "tool-result"
  );
}

// a tool part that has not yet produced output: still streaming its input,
// input fully received but not executed, or a bare tool-call part.
function isPendingToolPart(part: ToolPartLike) {
  return (
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.type === "tool-call"
  );
}

const STOPPED_TOOL_CALL_MESSAGE =
  "The run was stopped before this call finished. The tool may have completed part of its work before the stop reached it.";

/** The same envelope a platform error has, so the card reads it as Cancelled. */
function stoppedToolOutput(): {
  content: string;
  _meta: { archestraError: McpToolError };
} {
  return {
    content: STOPPED_TOOL_CALL_MESSAGE,
    _meta: {
      archestraError: { type: "cancelled", message: STOPPED_TOOL_CALL_MESSAGE },
    },
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
