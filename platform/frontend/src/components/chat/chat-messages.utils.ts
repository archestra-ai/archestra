import type { UIMessage } from "@ai-sdk/react";
import {
  type ArchestraToolShortName,
  isBrowserMcpTool,
  parseFullToolName,
} from "@shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  getToolErrorText,
  isCompactEligible,
} from "@/lib/chat/chat-tools-display.utils";
import type { FileAttachment } from "./editable-user-message";
import type { CanvasInfo } from "./pinned-canvas-context";

export type OptimisticToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type CompactToolGroup = {
  startIndex: number;
  entries: Array<{
    partIndex: number;
    toolName: string;
    part: DynamicToolUIPart | ToolUIPart;
    toolResultPart: DynamicToolUIPart | ToolUIPart | null;
    errorText: string | undefined;
  }>;
};

/**
 * Extract file attachments from message parts.
 * Filters for file parts and maps them to FileAttachment format.
 */
export function extractFileAttachments(
  parts: UIMessage["parts"] | undefined,
): FileAttachment[] | undefined {
  return parts
    ?.filter((p) => p.type === "file")
    .map((p) => {
      const filePart = p as {
        type: "file";
        url: string;
        mediaType: string;
        filename?: string;
      };
      return {
        url: filePart.url,
        mediaType: filePart.mediaType,
        filename: filePart.filename,
      };
    });
}

/**
 * Check if a message has any text parts.
 */
export function hasTextPart(parts: UIMessage["parts"] | undefined): boolean {
  return parts?.some((p) => p.type === "text") ?? false;
}

/**
 * Derive the list of MCP App canvases for a conversation directly from its
 * messages (plus any early UI-start data from the active stream).
 *
 * A tool call is a canvas when its output carries `_meta.ui.resourceUri`, or
 * when the backend announced it via a `data-tool-ui-start` event (tracked in
 * `earlyToolUiStarts`) before the result arrived. Deriving the registry from
 * the conversation — rather than from `McpAppSection` mount/unmount effects —
 * makes the sidebar selector deterministic: it matches what a page refresh
 * reconstructs and never empties because a single section briefly unmounts.
 */
export function deriveCanvasesFromMessages(
  messages: UIMessage[],
  earlyToolUiStarts: Record<
    string,
    { uiResourceUri?: string; toolName?: string }
  >,
): CanvasInfo[] {
  const canvases: CanvasInfo[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    const createdAt = getMessageCreatedAt(message);
    for (const part of message.parts ?? []) {
      if (!isToolPart(part)) continue;
      const toolCallId = part.toolCallId;
      if (!toolCallId || seen.has(toolCallId)) continue;

      const early = earlyToolUiStarts[toolCallId];
      const hasUiResource =
        // biome-ignore lint/suspicious/noExplicitAny: checking nested _meta shape on unknown output
        Boolean((part.output as any)?._meta?.ui?.resourceUri) ||
        Boolean(early?.uiResourceUri);
      if (!hasUiResource) continue;

      seen.add(toolCallId);
      const fullToolName = getToolName(part) ?? early?.toolName ?? "";
      const parsed = parseFullToolName(fullToolName);
      canvases.push({
        toolCallId,
        label: parsed.toolName || fullToolName,
        serverName: parsed.serverName,
        createdAt: createdAt ?? 0,
      });
    }
  }

  return canvases;
}

function getMessageCreatedAt(message: UIMessage): number | null {
  const metadata = message.metadata;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "createdAt" in metadata &&
    typeof metadata.createdAt === "string"
  ) {
    const createdAt = Date.parse(metadata.createdAt);
    return Number.isNaN(createdAt) ? null : createdAt;
  }
  return null;
}

export function filterOptimisticToolCalls(
  messages: UIMessage[],
  optimisticToolCalls: OptimisticToolCall[],
): OptimisticToolCall[] {
  const renderedToolCallIds = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        typeof part === "object" &&
        part !== null &&
        "toolCallId" in part &&
        typeof part.toolCallId === "string"
      ) {
        renderedToolCallIds.add(part.toolCallId);
      }
    }
  }

  return optimisticToolCalls.filter(
    (toolCall) => !renderedToolCallIds.has(toolCall.toolCallId),
  );
}

export function collectBrowserToolCallIds(params: {
  messages: UIMessage[];
  optimisticToolCalls?: OptimisticToolCall[];
}): Set<string> {
  const ids = new Set<string>();

  for (const message of params.messages) {
    for (const part of message.parts ?? []) {
      if (!isToolPart(part) || !part.toolCallId) continue;

      const toolName = getToolName(part);
      if (toolName && isBrowserMcpTool(toolName)) {
        ids.add(part.toolCallId);
      }
    }
  }

  for (const toolCall of params.optimisticToolCalls ?? []) {
    if (isBrowserMcpTool(toolCall.toolName)) {
      ids.add(toolCall.toolCallId);
    }
  }

  return ids;
}

export function identifyCompactToolGroups(
  parts: UIMessage["parts"] | undefined,
  options?: {
    nonCompactToolNames?: Set<string>;
    getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
    mcpAppToolCallIds?: Set<string>;
  },
): { groupMap: Map<number, CompactToolGroup>; consumedIndices: Set<number> } {
  const groupMap = new Map<number, CompactToolGroup>();
  const consumedIndices = new Set<number>();

  if (!parts) return { groupMap, consumedIndices };

  // Collect toolCallIds from data-tool-ui-start parts (MCP Apps known before output arrives)
  const mcpAppCallIds = new Set(options?.mcpAppToolCallIds);
  for (const part of parts) {
    // biome-ignore lint/suspicious/noExplicitAny: data-tool-ui-start shape is dynamic
    const earlyPart = part as any;
    if (
      typeof earlyPart?.type === "string" &&
      earlyPart.type.startsWith("data-tool-ui-start") &&
      earlyPart.data?.toolCallId
    ) {
      mcpAppCallIds.add(earlyPart.data.toolCallId as string);
    }
  }

  const seenToolCallIds = new Set<string>();
  const invocationIndices: number[] = [];
  const resultByCallId = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Skip non-tool parts and MCP App tools (they render their own UI)
    // biome-ignore lint/suspicious/noExplicitAny: checking nested _meta shape on unknown output
    if (!isToolPart(part) || (part.output as any)?._meta?.ui?.resourceUri)
      continue;
    // Also skip tools identified as MCP Apps via early UI start or earlyToolUiStarts
    if (part.toolCallId && mcpAppCallIds.has(part.toolCallId)) continue;

    const callId = part.toolCallId;
    if (callId && seenToolCallIds.has(callId)) {
      resultByCallId.set(callId, i);
      continue;
    }

    if (callId) {
      seenToolCallIds.add(callId);
    }
    invocationIndices.push(i);
  }

  let currentGroup: CompactToolGroup | null = null;

  for (const idx of invocationIndices) {
    const rawPart = parts[idx];
    if (!isToolPart(rawPart)) {
      finalizeCurrentGroup({ currentGroup, groupMap });
      currentGroup = null;
      continue;
    }

    const toolName = getToolName(rawPart);
    if (!toolName) {
      finalizeCurrentGroup({ currentGroup, groupMap });
      currentGroup = null;
      continue;
    }

    const resultIdx = rawPart.toolCallId
      ? resultByCallId.get(rawPart.toolCallId)
      : undefined;
    const toolResultPart =
      resultIdx !== undefined && isToolPart(parts[resultIdx])
        ? parts[resultIdx]
        : null;
    const errorText = getToolErrorText({
      part: rawPart as never,
      toolResultPart: toolResultPart as never,
    });
    const isEligible =
      !options?.nonCompactToolNames?.has(toolName) &&
      isCompactEligible({
        part: rawPart as never,
        toolResultPart: toolResultPart as never,
        toolName,
        getToolShortName: options?.getToolShortName,
      });

    if (isEligible) {
      if (!currentGroup) {
        currentGroup = { startIndex: idx, entries: [] };
      }
      currentGroup.entries.push({
        partIndex: idx,
        toolName,
        part: rawPart,
        toolResultPart,
        errorText,
      });
      consumedIndices.add(idx);
      if (resultIdx !== undefined) {
        consumedIndices.add(resultIdx);
      }
    } else {
      finalizeCurrentGroup({ currentGroup, groupMap });
      currentGroup = null;
    }
  }

  finalizeCurrentGroup({ currentGroup, groupMap });
  return { groupMap, consumedIndices };
}

function isToolPart(part: unknown): part is DynamicToolUIPart | ToolUIPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

function getToolName(part: DynamicToolUIPart | ToolUIPart): string | null {
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
    return part.toolName;
  }

  if (part.type.startsWith("tool-")) {
    return part.type.replace("tool-", "");
  }

  return null;
}

function finalizeCurrentGroup(params: {
  currentGroup: CompactToolGroup | null;
  groupMap: Map<number, CompactToolGroup>;
}) {
  const { currentGroup, groupMap } = params;
  if (currentGroup && currentGroup.entries.length > 0) {
    groupMap.set(currentGroup.startIndex, currentGroup);
  }
}
