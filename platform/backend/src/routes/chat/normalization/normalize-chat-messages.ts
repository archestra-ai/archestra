import { stripDanglingToolCalls } from "@shared";
import logger from "@/logging";
import type { ChatMessage, ChatMessagePart } from "@/types";
import { stripImagesFromMessages } from "./strip-images-from-messages";

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return stripImagesFromMessages(
    stripDanglingToolCallsFromMessages(dedupeToolPartsFromMessages(messages)),
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

function stripDanglingToolCallsFromMessages(messages: ChatMessage[]) {
  const sanitizedMessages = stripDanglingToolCalls(messages);

  return sanitizedMessages.map((message, index) => {
    const originalMessage = messages[index];
    const originalCount = originalMessage?.parts?.length ?? 0;
    const sanitizedCount = message.parts?.length ?? 0;

    if (sanitizedCount === originalCount) {
      return message;
    }

    logger.warn(
      {
        messageId: message.id,
        role: message.role,
        originalCount,
        sanitizedCount,
      },
      "[normalizeChatMessages] Removed dangling tool calls from message",
    );

    return message;
  });
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
function getToolPartState(part: ChatMessagePart) {
  return typeof part.state === "string" ? part.state : "unknown";
}
