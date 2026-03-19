import logger from "@/logging";
import type { ChatMessage } from "@/types";
import { stripImagesFromMessages } from "./strip-images-from-messages";

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return stripImagesFromMessages(dedupeToolPartsFromMessages(messages));
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

function getToolPartSignature(part: NonNullable<ChatMessage["parts"]>[number]) {
  if (!part.toolCallId || typeof part.toolCallId !== "string") {
    return null;
  }

  if (part.type === "tool-call" || part.type === "tool-result") {
    return `${part.type}:${part.toolCallId}`;
  }

  if (part.type.startsWith("tool-")) {
    return `${part.type}:${part.toolCallId}`;
  }

  if (part.toolName && typeof part.toolName === "string") {
    return `${part.type}:${part.toolName}:${part.toolCallId}`;
  }

  return null;
}
