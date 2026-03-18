import type { UIMessage } from "@ai-sdk/react";
import type { FileAttachment } from "./editable-user-message";

export type OptimisticToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
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
