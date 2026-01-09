import { estimateToolResultContentLength } from "@/utils/tool-result-preview";

export type MessageSizeEstimate = {
  length: number;
  isEstimated: boolean;
};

export function estimateMessagesSize(messages: unknown[]): MessageSizeEstimate {
  let length = 0;
  let isEstimated = false;

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      length += String(message).length;
      isEstimated = true;
      continue;
    }

    const candidate = message as Record<string, unknown>;

    if ("content" in candidate) {
      const contentEstimate = estimateToolResultContentLength(
        candidate.content,
      );
      length += contentEstimate.length;
      if (contentEstimate.isEstimated) {
        isEstimated = true;
      }

      if (Array.isArray(candidate.content)) {
        for (const item of candidate.content) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const contentItem = item as Record<string, unknown>;
          if (contentItem.type !== "image_url") {
            continue;
          }
          const imageUrl =
            contentItem.image_url && typeof contentItem.image_url === "object"
              ? (contentItem.image_url as Record<string, unknown>)
              : null;
          if (imageUrl && typeof imageUrl.url === "string") {
            length += imageUrl.url.length;
            isEstimated = true;
          }
        }
      }
    } else {
      isEstimated = true;
    }

    const toolCalls = candidate.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall !== "object") {
          isEstimated = true;
          continue;
        }

        const toolCallRecord = toolCall as Record<string, unknown>;
        const toolCallFunction =
          toolCallRecord.function && typeof toolCallRecord.function === "object"
            ? (toolCallRecord.function as Record<string, unknown>)
            : null;
        if (
          toolCallFunction &&
          typeof toolCallFunction.arguments === "string"
        ) {
          length += toolCallFunction.arguments.length;
          isEstimated = true;
        }
      }
    }
  }

  return { length, isEstimated };
}
