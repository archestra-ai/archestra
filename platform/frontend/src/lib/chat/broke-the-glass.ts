import {
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_YELL_SHORT_NAME,
  YELL_RESULT_GUARDRAILS_OFF,
} from "@archestra/shared";
import { getToolNameFromPart } from "@/lib/chat/chat-tools-display.utils";

/**
 * Whether a yell in these messages broke the glass: the agent yelled while
 * break the glass was on, so guardrails are off for the rest of the chat. The
 * yell's own result says so, and everyone who can open the chat can read it,
 * including whoever made the yell. Counts a yell dispatched through
 * `run_tool` too.
 */
export function chatBrokeTheGlass(params: {
  messages: unknown[] | undefined;
  getToolShortName: (toolName: string) => string | null;
}): boolean {
  for (const message of params.messages ?? []) {
    if (typeof message !== "object" || message === null) continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const rawPart of parts) {
      if (typeof rawPart !== "object" || rawPart === null) continue;
      const part = rawPart as ToolResultPart;
      if (part.state !== "output-available") continue;
      const toolName = getToolNameFromPart(part);
      if (!toolName) continue;
      const dispatched =
        params.getToolShortName(toolName) === TOOL_RUN_TOOL_SHORT_NAME &&
        typeof part.input === "object" &&
        part.input !== null &&
        "tool_name" in part.input &&
        typeof part.input.tool_name === "string"
          ? part.input.tool_name
          : toolName;
      if (params.getToolShortName(dispatched) !== TOOL_YELL_SHORT_NAME) {
        continue;
      }
      if (
        JSON.stringify(part.output ?? "").includes(YELL_RESULT_GUARDRAILS_OFF)
      )
        return true;
    }
  }
  return false;
}

// === Internal ===

/** The slice of a UIMessage tool part this module inspects. */
type ToolResultPart = {
  type?: string;
  toolName?: string;
  input?: unknown;
  state?: string;
  output?: unknown;
};
