import {
  type ArchestraToolShortName,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

/**
 * The call a Guardrails denial notice stands for.
 *
 * When the policy blocks a call, the proxy hands the client a
 * `get_remedy_plans` call in its place: same slot, same call id, with the
 * blocked call and the ruling as its arguments. The model made the blocked
 * call and reads the ruling as that call's result. Chat shows the step the
 * same way: one call, the one the model tried, blocked, with its ruling.
 */
export type BlockedAttempt = {
  /** The tool the model called, as the notice spells it. */
  toolName: string;
  /** The arguments the model sent, as an object when they parse as one. */
  input: unknown;
};

/** The status a blocked attempt shows once the notice has delivered the ruling. */
export const BLOCKED_ATTEMPT_LABEL = "Blocked";

/**
 * Returns the attempted call when `part` is a denial notice, else null.
 *
 * A `get_remedy_plans` call that carries no notice (a model can call the tool
 * directly) is an ordinary call and returns null.
 */
export function getBlockedAttempt(params: {
  part: Pick<ToolUIPart | DynamicToolUIPart, "input" | "state">;
  toolName: string;
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
}): BlockedAttempt | null {
  const { part, toolName, getToolShortName } = params;
  if (getToolShortName(toolName) !== TOOL_GET_REMEDY_PLANS_SHORT_NAME) {
    return null;
  }
  const input = part.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const {
    tool,
    arguments: args,
    ruling,
    notice,
  } = input as Record<string, unknown>;
  if (typeof tool !== "string" || tool.length === 0) return null;

  if (part.state === "input-streaming") {
    // The last field of a streaming input can still be growing. The tool's
    // name is whole once another field follows it.
    const keys = Object.keys(input);
    if (keys.indexOf("tool") === keys.length - 1) return null;
  } else if (
    typeof ruling !== "string" ||
    typeof notice !== "object" ||
    notice === null
  ) {
    return null;
  }

  return { toolName: tool, input: parseArguments(args) };
}

/** A notice carries arguments in their wire form: an object or a JSON string. */
function parseArguments(args: unknown): unknown {
  if (args === undefined || args === null) return {};
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}
