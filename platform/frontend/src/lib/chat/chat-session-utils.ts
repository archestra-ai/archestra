import type { UIMessage } from "@ai-sdk/react";

/**
 * Preserves the last renderable assistant content when a live session update
 * temporarily replaces that message with an empty assistant payload.
 *
 * This guards against a transient UI regression where streamed assistant text
 * briefly appears, then disappears until persisted session data catches up.
 * We only restore the previous parts when the new assistant message has no
 * renderable content at all, and we return the original `nextMessages` array
 * unchanged when no restoration is needed to avoid unnecessary re-renders.
 */
export function restoreRenderableAssistantParts(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
}): UIMessage[] {
  const { previousMessages, nextMessages } = params;
  let changed = false;
  const previousAssistantMessagesById = new Map(
    previousMessages
      .filter((message) => message.role === "assistant")
      .map((message) => [message.id, message]),
  );

  const restoredMessages = nextMessages.map((message) => {
    if (message.role !== "assistant" || hasRenderableAssistantParts(message)) {
      return message;
    }

    const previousMessage = previousAssistantMessagesById.get(message.id);
    if (
      previousMessage?.role !== "assistant" ||
      !hasRenderableAssistantParts(previousMessage)
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      parts: previousMessage.parts,
    };
  });

  return changed ? restoredMessages : nextMessages;
}

/**
 * Returns true when an assistant message still has content the chat UI can
 * actually render. Empty text parts do not count, but any non-text part does.
 */
function hasRenderableAssistantParts(message: UIMessage): boolean {
  return (message.parts ?? []).some((part) => {
    if (part.type === "text") {
      return Boolean(part.text);
    }

    return true;
  });
}
