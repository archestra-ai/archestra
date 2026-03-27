import type { UIMessage } from "@ai-sdk/react";
import type { ArchestraToolShortName } from "@shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  getToolErrorText,
  isCompactEligible,
} from "./chat-tools-display.utils";
import type { FileAttachment } from "./editable-user-message";

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

export function stripDanglingToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (!message.parts?.length) {
      return message;
    }

    const completedToolCallIds = new Set<string>();
    for (const part of message.parts) {
      if (
        isToolPart(part) &&
        typeof part.toolCallId === "string" &&
        isCompletedToolPart(part)
      ) {
        completedToolCallIds.add(part.toolCallId);
      }
    }

    const sanitizedParts = message.parts.filter((part) => {
      if (
        !isToolPart(part) ||
        typeof part.toolCallId !== "string" ||
        part.state !== "input-available"
      ) {
        return true;
      }

      // If a stream is stopped mid-tool-execution, AI SDK can leave behind a
      // lone input-available tool part with no matching result. Sending that
      // stale part back on the next turn triggers MissingToolResultsError at
      // the provider layer, so we strip only the dangling invocation here.
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

function isCompletedToolPart(part: DynamicToolUIPart | ToolUIPart) {
  return (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied"
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
