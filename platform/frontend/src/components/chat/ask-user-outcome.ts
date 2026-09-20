import type { DynamicToolUIPart, ToolUIPart } from "ai";

export type AskUserOutcome =
  | { status: "waiting" }
  | { status: "answered"; selected: string[] }
  | { status: "declined" }
  | { status: "dismissed" }
  | { status: "timed-out" }
  | { status: "stopped" };

export type AskUserGroupMember = {
  toolCallId: string;
  question: string | undefined;
  outcome: AskUserOutcome | null;
};

/**
 * What came of an `ask_user` call: still waiting, the option(s) the user
 * picked, or that they dismissed or declined the question or never answered.
 * Reads the structured result (`{ action, selected, timedOut? }`) Chat stores
 * with the call. Returns null when it cannot be read, or for approval states,
 * so the caller keeps the generic tool card.
 */
export function getAskUserOutcome({
  part,
  toolResultPart,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
}): AskUserOutcome | null {
  const output = toolResultPart ? toolResultPart.output : part.output;
  if (output === undefined || output === null) {
    return part.state === "input-streaming" || part.state === "input-available"
      ? { status: "waiting" }
      : null;
  }

  const structured = isRecord(output) ? output.structuredContent : undefined;
  return isRecord(structured) ? outcomeFromStructured(structured) : null;
}

/** The question `ask_user` was called with, when the input carries one. */
export function getAskUserQuestion(input: unknown): string | undefined {
  return isRecord(input) && typeof input.question === "string"
    ? input.question
    : undefined;
}

// === Internal helpers ===

function outcomeFromStructured(
  structured: Record<string, unknown>,
): AskUserOutcome | null {
  switch (structured.action) {
    case "accept": {
      const selected = Array.isArray(structured.selected)
        ? structured.selected.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      return selected.length > 0 ? { status: "answered", selected } : null;
    }
    case "decline":
      return { status: "declined" };
    case "cancel":
      return structured.timedOut === true
        ? { status: "timed-out" }
        : { status: "dismissed" };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
