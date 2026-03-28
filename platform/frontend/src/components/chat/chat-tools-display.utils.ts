import {
  type ArchestraToolShortName,
  extractMcpToolError,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  parseAuthRequired,
  parseExpiredAuth,
  parsePolicyDenied,
} from "@/lib/chat/mcp-error-ui";
import {
  applyPendingActions,
  type PendingToolAction,
} from "@/lib/chat/pending-tool-state";

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
  if (conversationId && hasCustomSelection) {
    return enabledToolIds;
  }

  const baseIds = defaultEnabledToolIds;

  if (!conversationId && pendingActions.length > 0) {
    return applyPendingActions(baseIds, pendingActions);
  }

  return baseIds;
}

export function getToolErrorText({
  part,
  toolResultPart,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
}): string | undefined {
  const outputError = toolResultPart
    ? extractMcpToolError(toolResultPart.output)?.message
    : extractMcpToolError(part.output)?.message;

  return toolResultPart
    ? (toolResultPart.errorText ?? outputError)
    : (part.errorText ?? outputError);
}

export function getToolHeaderState({
  state,
  toolResultPart,
  errorText,
}: {
  state: ToolUIPart["state"] | DynamicToolUIPart["state"];
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
}) {
  if (errorText) return "output-error" as const;
  if (toolResultPart) return "output-available" as const;
  return state;
}

export function getCompactToolState({
  part,
  toolResultPart,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
}): "running" | "completed" | "error" {
  if (getToolErrorText({ part, toolResultPart })) {
    return "error";
  }

  if (toolResultPart || part.state === "output-available") {
    return "completed";
  }

  return "running";
}

export function isCompactEligible(params: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
  getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
}): boolean {
  const { part, toolResultPart, toolName, getToolShortName } = params;

  const shortName = getToolShortName?.(toolName);
  if (
    shortName === TOOL_SWAP_AGENT_SHORT_NAME ||
    shortName === TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME ||
    shortName === TOOL_TODO_WRITE_SHORT_NAME
  ) {
    return false;
  }

  if (part.state === "approval-requested") {
    return false;
  }

  const errorText = getToolErrorText({ part, toolResultPart });
  const structuredError = extractMcpToolError(
    toolResultPart?.output ?? part.output,
  );
  if (errorText) {
    if (
      structuredError?.type === "auth_required" ||
      structuredError?.type === "auth_expired"
    ) {
      return false;
    }

    if (
      parsePolicyDenied(errorText) ||
      parseExpiredAuth(errorText) ||
      parseAuthRequired(errorText)
    ) {
      return false;
    }

    return true;
  }

  const rawOutput = toolResultPart?.output ?? part.output;
  if (typeof rawOutput === "string") {
    if (parseExpiredAuth(rawOutput) || parseAuthRequired(rawOutput)) {
      return false;
    }
  }

  return true;
}
