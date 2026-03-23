import logger from "@/logging";
import type { ChatMessage, ChatMessagePart } from "@/types";
import { stripImagesFromMessages } from "./strip-images-from-messages";

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return stripImagesFromMessages(
    stripDanglingToolCalls(dedupeToolPartsFromMessages(messages)),
  );
}

function dedupeToolPartsFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.parts || !Array.isArray(message.parts)) {
      return message;
    }

    const dedupedParts = dedupeToolParts(message.parts);
    if (dedupedParts.length === message.parts.length) {
      return message;
    }

    logger.warn(
      {
        messageId: message.id,
        role: message.role,
        originalCount: message.parts.length,
        dedupedCount: dedupedParts.length,
      },
      "[normalizeChatMessages] Removed duplicate tool parts from message",
    );

    return {
      ...message,
      parts: dedupedParts,
    };
  });
}

function stripDanglingToolCalls(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.parts || !Array.isArray(message.parts)) {
      return message;
    }

    const completedToolCallIds = new Set<string>();
    for (const part of message.parts) {
      if (typeof part.toolCallId === "string" && isCompletedToolPart(part)) {
        completedToolCallIds.add(part.toolCallId);
      }
    }

    const sanitizedParts = message.parts.filter((part) => {
      if (
        typeof part.toolCallId !== "string" ||
        !isInputAvailableToolPart(part)
      ) {
        return true;
      }

      // If the user stops a stream mid-tool-execution, the client can send the
      // stale input-available tool part back on the next turn without a matching
      // result. Gemini rejects that replay with MissingToolResultsError, so we
      // strip only the interrupted invocation here and keep completed tool parts.
      // This intentionally works per-message because UIMessage tool calls and
      // results are expected to live in the same message part array.
      return completedToolCallIds.has(part.toolCallId);
    });

    if (sanitizedParts.length === message.parts.length) {
      return message;
    }

    logger.warn(
      {
        messageId: message.id,
        role: message.role,
        originalCount: message.parts.length,
        sanitizedCount: sanitizedParts.length,
      },
      "[normalizeChatMessages] Removed dangling tool calls from message",
    );

    return {
      ...message,
      parts: sanitizedParts,
    };
  });
}

function dedupeToolParts(
  parts: NonNullable<ChatMessage["parts"]>,
): NonNullable<ChatMessage["parts"]> {
  const seenToolPartSignatures = new Set<string>();
  const dedupedParts: NonNullable<ChatMessage["parts"]> = [];

  for (const part of parts) {
    const signature = getToolPartSignature(part);
    if (signature && seenToolPartSignatures.has(signature)) {
      continue;
    }

    if (signature) {
      seenToolPartSignatures.add(signature);
    }

    dedupedParts.push(part);
  }

  return dedupedParts;
}

function getToolPartSignature(part: NonNullable<ChatMessage["parts"]>[number]) {
  if (!part.toolCallId || typeof part.toolCallId !== "string") {
    return null;
  }

  if (part.type === "tool-call" || part.type === "tool-result") {
    return `${part.type}:${part.toolCallId}`;
  }

  if (part.type.startsWith("tool-")) {
    return `${part.type}:${part.toolCallId}:${getToolPartState(part)}`;
  }

  if (part.toolName && typeof part.toolName === "string") {
    return `${part.type}:${part.toolName}:${part.toolCallId}:${getToolPartState(part)}`;
  }

  return null;
}

function isCompletedToolPart(part: ChatMessagePart) {
  return (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied" ||
    part.type === "tool-result"
  );
}

function isInputAvailableToolPart(part: ChatMessagePart) {
  return part.state === "input-available" || part.type === "tool-call";
}

function getToolPartState(part: ChatMessagePart) {
  return typeof part.state === "string" ? part.state : "unknown";
}
