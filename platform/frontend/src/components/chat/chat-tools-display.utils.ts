import { TOOL_SWAP_AGENT_FULL_NAME, TOOL_TODO_WRITE_FULL_NAME } from "@shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  parseAuthRequired,
  parseExpiredAuth,
  parsePolicyDenied,
} from "@/lib/llmProviders/common";
import {
  applyPendingActions,
  type PendingToolAction,
} from "@/lib/pending-tool-state";

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

export function tryToExtractErrorFromOutput(output: unknown) {
  try {
    if (typeof output !== "string") return undefined;
    const json = JSON.parse(output);
    return typeof json.error === "string" ? json.error : undefined;
  } catch (_error) {
    return undefined;
  }
}

export function getToolErrorText({
  part,
  toolResultPart,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
}): string | undefined {
  const outputError = toolResultPart
    ? tryToExtractErrorFromOutput(toolResultPart.output)
    : tryToExtractErrorFromOutput(part.output);

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
}): boolean {
  const { part, toolResultPart, toolName } = params;

  if (
    toolName === TOOL_SWAP_AGENT_FULL_NAME ||
    toolName === TOOL_TODO_WRITE_FULL_NAME
  ) {
    return false;
  }

  if (part.state === "approval-requested") {
    return false;
  }

  const errorText = getToolErrorText({ part, toolResultPart });
  if (errorText) {
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

  if (isMcpAppOutput(rawOutput)) {
    return false;
  }

  return true;
}

// =============================================================================
// MCP Apps detection helpers
//
// The MCP Apps standard (text/html;profile=mcp-app) means a tool result's
// content array may contain a "resource" item whose mimeType signals an
// interactive HTML UI that the host should render in a sandboxed iframe.
//
// The AI SDK serialises structured tool output as a JSON string, so we need
// to handle both the parsed-array case and the JSON-string case.
// =============================================================================

export interface McpAppResource {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: Tool output type is unknown at runtime
function _tryParseOutputArray(output: any): unknown[] | null {
  if (Array.isArray(output)) return output;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON
    }
  }
  return null;
}

/**
 * Given raw tool output, returns the first content item that is an MCP App
 * resource (mimeType starts with "text/html;profile=mcp-app"), or null.
 */
export function detectMcpAppResource(output: unknown): McpAppResource | null {
  const items = _tryParseOutputArray(output);
  if (!items) return null;

  for (const item of items) {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      (item as { type: string }).type === "resource" &&
      "resource" in item
    ) {
      const resource = (item as { resource: unknown }).resource;
      if (
        typeof resource === "object" &&
        resource !== null &&
        "mimeType" in resource &&
        typeof (resource as { mimeType: unknown }).mimeType === "string" &&
        ((resource as { mimeType: string }).mimeType.startsWith(
          "text/html;profile=mcp-app",
        ) ||
          (resource as { mimeType: string }).mimeType.startsWith(
            "text/html; profile=mcp-app",
          ))
      ) {
        return resource as McpAppResource;
      }
    }
  }
  return null;
}

/**
 * Boolean predicate — true when output contains at least one MCP App resource.
 */
export function isMcpAppOutput(output: unknown): boolean {
  return detectMcpAppResource(output) !== null;
}

/**
 * Decode the HTML string from an MCP App resource.
 * Prefers `text` (inline); falls back to base64-decoding `blob`.
 * Returns null if neither field is present or decoding fails.
 */
export function getMcpAppHtml(resource: McpAppResource): string | null {
  if (resource.text) return resource.text;
  if (resource.blob) {
    try {
      return atob(resource.blob);
    } catch {
      return null;
    }
  }
  return null;
}
