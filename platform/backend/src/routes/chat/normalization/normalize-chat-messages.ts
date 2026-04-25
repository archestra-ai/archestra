import { stripDanglingToolCalls } from "@shared";
import logger from "@/logging";
import type { ChatMessage, ChatMessagePart } from "@/types";
import { stripImagesFromMessages } from "./strip-images-from-messages";

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return stripImagesFromMessages(
    stripDanglingToolCallsFromMessages(
      resolveStaleApprovalRequestsFromMessages(
        dedupeToolPartsFromMessages(messages),
      ),
    ),
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

/**
 * Converts stale "approval-requested" tool parts to "output-denied" before persisting to DB.
 *
 * When a tool requires approval and the page is refreshed before the user responds
 * (or before the response is processed), the tool part is saved with state
 * "approval-requested". On the next page load, the chat UI re-renders the approval
 * form, but there is no active stream to accept the response — clicking Approve/Decline
 * causes an error.
 *
 * By converting these to "output-denied" we ensure:
 * 1. After a page refresh, users see the tool was denied/interrupted rather than a broken form.
 * 2. The LLM's system instruction ("do not retry denied tools") applies correctly.
 * 3. Only truly pending approvals (those with a live stream) remain as "approval-requested"
 *    in the in-memory AI SDK state (not in the DB).
 */
function resolveStaleApprovalRequestsFromMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  // Collect toolCallIds that have already received a response (approval-responded,
  // output-available, output-error, output-denied). These do NOT need to be touched.
  const respondedToolCallIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        typeof part.toolCallId === "string" &&
        (part.state === "approval-responded" ||
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied")
      ) {
        respondedToolCallIds.add(part.toolCallId);
      }
    }
  }

  let changedCount = 0;

  const result = messages.map((message) => {
    if (!message.parts || !Array.isArray(message.parts)) {
      return message;
    }

    let changed = false;
    const updatedParts = message.parts.map((part) => {
      if (
        part.state === "approval-requested" &&
        typeof part.toolCallId === "string" &&
        !respondedToolCallIds.has(part.toolCallId)
      ) {
        // This approval was never responded to — mark it as denied so the
        // UI will not re-show the approval form on next page load.
        changed = true;
        changedCount++;
        return {
          ...part,
          state: "output-denied" as const,
          output:
            "Tool approval was interrupted (page refreshed or session ended before response was recorded).",
        };
      }
      return part;
    });

    return changed ? { ...message, parts: updatedParts } : message;
  });

  if (changedCount > 0) {
    logger.info(
      { changedCount },
      "[normalizeChatMessages] Resolved stale approval-requested tool parts to output-denied",
    );
  }

  return result;
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
