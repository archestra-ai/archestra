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

const POLICY_PREVIEW_TOOL_SHORT_NAMES: ReadonlySet<string> = new Set([
  "preview_guardrails_policy_change",
  "preview_guardrails_validation_change",
]);

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
  const outputError = toolResultPart
    ? extractMcpToolError(toolResultPart.output)?.message
    : extractMcpToolError(part.output)?.message;

  return toolResultPart
    ? (toolResultPart.errorText ?? outputError)
    : (part.errorText ?? outputError);
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
}): "running" | "completed" | "error" | "denied" {
  if (getToolErrorText({ part, toolResultPart })) {
    return "error";
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

  return "running";
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

export function isCompactEligible(params: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
  getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
}): boolean {
  const { part, toolResultPart, toolName, getToolShortName } = params;

  const shortName = getToolShortName?.(toolName);
  if (shortName === TOOL_TODO_WRITE_SHORT_NAME) {
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
      structuredError?.type === "assigned_credential_unavailable" ||
      structuredError?.type === "auth_required" ||
      structuredError?.type === "auth_expired"
    ) {
      return false;
    }

    if (isAuthErrorText(errorText, toolResultPart ?? part)) {
      return false;
    }

    return true;
  }

  // A proposed policy is what the operator is asked to approve: its preview
  // stays open in the reply instead of folding into a circle. A saved change
  // folds as usual; its banner reports the save.
  if (shortName && POLICY_PREVIEW_TOOL_SHORT_NAMES.has(shortName)) {
    return false;
  }

  const rawOutput = toolResultPart?.output ?? part.output;
  if (typeof rawOutput === "string") {
    if (isAuthErrorText(rawOutput, toolResultPart ?? part)) {
      return false;
    }
  }

  return true;
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
