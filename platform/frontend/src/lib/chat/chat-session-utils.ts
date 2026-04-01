import type { UIMessage } from "@ai-sdk/react";

export function restoreRenderableAssistantParts(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
}): UIMessage[] {
  const { previousMessages, nextMessages } = params;
  let changed = false;

  const restoredMessages = nextMessages.map((message, index) => {
    if (message.role !== "assistant" || hasRenderableAssistantParts(message)) {
      return message;
    }

    const previousMessage = previousMessages[index];
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

function hasRenderableAssistantParts(message: UIMessage): boolean {
  return (message.parts ?? []).some((part) => {
    if (part.type === "text") {
      return Boolean(part.text);
    }

    return true;
  });
}
