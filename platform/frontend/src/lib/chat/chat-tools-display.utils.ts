import {
  type ArchestraToolShortName,
  extractMcpHumanRuling,
  extractMcpToolError,
  type McpHumanRuling,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { resolveEnabledToolIds } from "@/lib/chat/enabled-tools-selection";
import { parseAuthRequired, parseExpiredAuth } from "@/lib/chat/mcp-error-ui";
import type { PendingToolAction } from "@/lib/chat/pending-tool-state";

/**
 * Compute the default set of enabled tool IDs for a conversation.
 * All tools assigned to the agent are enabled by default.
 */
export function getDefaultEnabledToolIds(
  profileTools: { id: string }[],
): string[] {
  return profileTools.map((t) => t.id);
}

/**
 * Compute the current set of enabled tool IDs based on
 * conversation state, custom selection, and pending actions.
 *
 * Priority:
 * 1. If conversation exists with custom selection → use the custom enabledToolIds
 * 2. If no conversation but pending actions exist → apply them on top of defaults
 * 3. Otherwise → use defaults (all assigned tools enabled)
 */
export function getCurrentEnabledToolIds({
  conversationId,
  hasCustomSelection,
  enabledToolIds,
  defaultEnabledToolIds,
  pendingActions,
}: {
  conversationId: string | undefined;
  hasCustomSelection: boolean;
  enabledToolIds: string[];
  defaultEnabledToolIds: string[];
  pendingActions: PendingToolAction[];
}): string[] {
  return resolveEnabledToolIds({
    hasCustomSelection: Boolean(conversationId && hasCustomSelection),
    enabledToolIds,
    allToolIds: defaultEnabledToolIds,
    // Pending actions are a pre-conversation concept; once a conversation
    // exists its stored selection is authoritative.
    pendingActions: conversationId ? [] : pendingActions,
  });
}

export function getToolErrorText({
  part,
  toolResultPart,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
}): string | undefined {
  const source = toolResultPart ?? part;
  if (source.errorText) return source.errorText;
  const structured = extractMcpToolError(source.output);
  // A stopped call is not a failure: its card reads Cancelled, not Error.
  if (structured?.type === "cancelled") return undefined;
  return structured?.message ?? getFlaggedErrorText(source.output);
}

/**
 * Whether a tool call was stopped before it finished: the run was stopped
 * while the call was in flight.
 */
export function isCancelledToolOutput(output: unknown): boolean {
  return extractMcpToolError(output)?.type === "cancelled";
}

/**
 * Whether a call has a request to show. A call with no arguments still sent
 * one (`{}`); only a call whose arguments have not arrived yet has none.
 */
export function hasToolRequest(input: unknown): boolean {
  return input !== undefined && input !== null;
}

export function getToolNameFromPart(part: {
  type?: string;
  toolName?: string;
}): string | undefined {
  if (typeof part.toolName === "string") {
    return part.toolName;
  }

  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.replace("tool-", "");
  }

  return undefined;
}

export function getToolHeaderState({
  state,
  toolResultPart,
  errorText,
  output,
  turnActive = true,
}: {
  state: ToolUIPart["state"] | DynamicToolUIPart["state"];
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
  /** The call's result, when it has one. */
  output?: unknown;
  /** False once the call's turn has ended; a call without a result then did not finish. */
  turnActive?: boolean;
}) {
  if (errorText) return "output-error" as const;
  if (isCancelledToolOutput(output)) return "output-cancelled" as const;
  if (toolResultPart) return "output-available" as const;
  if (!turnActive && isUnfinishedToolState(state)) {
    return "output-cancelled" as const;
  }
  return state;
}

export type CompactToolState =
  | "running"
  | "approval-requested"
  | "completed"
  | "error"
  | "denied"
  | "cancelled";

export function getCompactToolState({
  part,
  toolResultPart,
  turnActive = true,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  /** False once the call's turn has ended; a call without a result then did not finish. */
  turnActive?: boolean;
}): CompactToolState {
  if (getToolErrorText({ part, toolResultPart })) {
    return "error";
  }

  if (isCancelledToolOutput(toolResultPart?.output ?? part.output)) {
    return "cancelled";
  }

  // The remedy executed, but the user denied the reviewed tool call.
  // Mark the tool as denied instead of completed.
  if (extractMcpHumanRuling(toolResultPart?.output ?? part.output) === "deny") {
    return "denied";
  }

  if (toolResultPart || part.state === "output-available") {
    return "completed";
  }

  // A declined approval is terminal — without this it would fall through to
  // "running" and render a blue pulsing dot forever. Surface it as "denied".
  if (part.state === "output-denied") {
    return "denied";
  }

  if (part.state === "approval-requested") {
    return "approval-requested";
  }

  // Nothing runs after the turn ends: the call was stopped, or its turn broke
  // off before the result came back. An answered approval is on its way to
  // run, so it keeps reading as running.
  return !turnActive && isUnfinishedToolState(part.state ?? "input-available")
    ? "cancelled"
    : "running";
}

/**
 * Returns display text for a reviewed remedy decision.
 * Returns null if the result contains an error or lacks a human ruling.
 */
export function getHumanRulingDisplay({
  part,
  toolResultPart,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
}): { ruling: McpHumanRuling; label: string } | null {
  if (getToolErrorText({ part, toolResultPart })) return null;
  const ruling = extractMcpHumanRuling(toolResultPart?.output ?? part.output);
  if (!ruling) return null;
  return { ruling, label: HUMAN_RULING_LABELS[ruling] };
}

/**
 * Whether a tool call renders as a circle in `CompactToolGroup` rather than
 * a standalone interactive widget. Only `todo_write` stays outside the circle
 * row (along with `ask_user` via `nonCompactToolNames`); approvals and auth
 * prompts all render under their own circle.
 */
export function isCompactEligible(params: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
  getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
}): boolean {
  const { toolName, getToolShortName } = params;

  const shortName = getToolShortName?.(toolName);
  if (shortName === TOOL_TODO_WRITE_SHORT_NAME) {
    return false;
  }

  return true;
}

/**
 * Whether a tool call carries an authentication prompt that must stay visible
 * under its circle (and prevents an MCP App call from mounting as an app pill).
 */
export function hasToolAuthPrompt(params: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
}): boolean {
  const { part, toolResultPart } = params;
  const errorText = getToolErrorText({ part, toolResultPart });
  const rawOutput = toolResultPart?.output ?? part.output;
  const structuredError = extractMcpToolError(rawOutput);

  if (errorText) {
    if (
      structuredError?.type === "assigned_credential_unavailable" ||
      structuredError?.type === "auth_required" ||
      structuredError?.type === "auth_expired"
    ) {
      return true;
    }

    if (isAuthErrorText(errorText, toolResultPart ?? part)) {
      return true;
    }
  }

  if (typeof rawOutput === "string") {
    if (isAuthErrorText(rawOutput, toolResultPart ?? part)) {
      return true;
    }
  }

  return false;
}

const HUMAN_RULING_LABELS: Record<McpHumanRuling, string> = {
  approve: "Approved by you",
  deny: "Denied by you",
  superseded: "Policy changed, the agent will ask again",
};

/**
 * Whether a tool's error or output text asks the user to (re)authenticate.
 * Memoized per message part: the transcript re-checks every tool part on
 * every render, and parts are stable objects while their text is unchanged.
 */
function isAuthErrorText(text: string, source: object): boolean {
  const cached = authErrorTextCache.get(source);
  if (cached && cached.text === text) return cached.result;
  const result = !!(parseExpiredAuth(text) || parseAuthRequired(text));
  authErrorTextCache.set(source, { text, result });
  return result;
}

const authErrorTextCache = new WeakMap<
  object,
  { text: string; result: boolean }
>();

/** A call that has its arguments, or is still receiving them, and no result. */
function isUnfinishedToolState(
  state: ToolUIPart["state"] | DynamicToolUIPart["state"],
): boolean {
  return state === "input-streaming" || state === "input-available";
}

/**
 * The text of a result its tool marked as an error (`isError`), which carries
 * no structured platform error. A reviewed call keeps its ruling instead, and
 * so does a ruling the Guardrails runtime wrote: a refusal that offers the
 * model a way to continue is a step of the negotiation, not a failed call.
 */
function getFlaggedErrorText(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const { isError, content } = output as {
    isError?: unknown;
    content?: unknown;
  };
  if (isError !== true || extractMcpHumanRuling(output)) return undefined;
  if (typeof content !== "string" || !content.trim()) {
    return "The tool reported an error and returned no details.";
  }
  return content.startsWith(GUARDRAILS_RUNTIME_MARKER) ? undefined : content;
}

/** What the Guardrails runtime puts before every text it writes. */
const GUARDRAILS_RUNTIME_MARKER = "[appa]";
