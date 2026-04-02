import type { UIMessage } from "@ai-sdk/react";

/**
 * Preserves the last renderable assistant content when a live session update
 * temporarily regresses after streaming, either by replacing the assistant
 * message with an empty payload or by dropping the assistant tail entirely.
 *
 * This guards against a transient UI regression where streamed assistant text
 * briefly appears, then disappears until persisted session data catches up.
 * We only restore when the new session state is clearly a regression, and we
 * return the original `nextMessages` array unchanged when no restoration is
 * needed to avoid unnecessary re-renders.
 */
export function restoreRenderableAssistantParts(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
}): UIMessage[] {
  const { previousMessages, nextMessages } = params;
  const restoredMessageTail = restoreTruncatedAssistantTail({
    previousMessages,
    nextMessages,
  });
  if (restoredMessageTail !== nextMessages) {
    return restoredMessageTail;
  }

  let changed = false;

  const restoredMessages = nextMessages.map((message, index) => {
    if (message.role !== "assistant" || hasRenderableAssistantParts(message)) {
      return message;
    }

    const previousMessage = findPreviousRenderableAssistantMessage({
      previousMessages,
      nextMessages,
      nextMessage: message,
      index,
    });
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

export function chooseDisplayedMessages(params: {
  liveMessages?: UIMessage[];
  persistedMessages: UIMessage[];
  lastVisibleMessages: UIMessage[];
}): UIMessage[] {
  const liveMessages =
    params.liveMessages && params.liveMessages.length > 0
      ? params.liveMessages
      : undefined;
  const persistedMessages =
    params.persistedMessages.length > 0 ? params.persistedMessages : undefined;
  const primaryMessages = liveMessages ?? persistedMessages;

  if (
    primaryMessages &&
    !threadRegressedFromLastVisible({
      currentMessages: primaryMessages,
      lastVisibleMessages: params.lastVisibleMessages,
    })
  ) {
    return primaryMessages;
  }

  if (params.lastVisibleMessages.length > 0) {
    return params.lastVisibleMessages;
  }

  return primaryMessages ?? [];
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

function findPreviousRenderableAssistantMessage(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
  nextMessage: UIMessage;
  index: number;
}): UIMessage | undefined {
  const { previousMessages, nextMessages, nextMessage, index } = params;
  const previousMessageById = previousMessages.find(
    (message) => message.role === "assistant" && message.id === nextMessage.id,
  );
  if (previousMessageById) {
    return previousMessageById;
  }

  const previousMessageAtIndex = previousMessages[index];
  if (
    index > 0 &&
    previousMessageAtIndex?.role === "assistant" &&
    nextMessages
      .slice(0, index)
      .every(
        (message, messageIndex) => previousMessages[messageIndex] === message,
      )
  ) {
    return previousMessageAtIndex;
  }

  return undefined;
}

function restoreTruncatedAssistantTail(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
}): UIMessage[] {
  const { previousMessages, nextMessages } = params;

  if (previousMessages.length === 0) {
    return nextMessages;
  }

  if (
    nextMessages.length === 0 &&
    previousMessages.at(-1)?.role === "assistant"
  ) {
    return previousMessages;
  }

  if (nextMessages.length >= previousMessages.length) {
    return nextMessages;
  }

  const hasStablePrefix = nextMessages.every((message, index) =>
    sameMessageIdentity(message, previousMessages[index]),
  );
  const truncatedTail = previousMessages.slice(nextMessages.length);
  if (
    hasStablePrefix &&
    truncatedTail.length > 0 &&
    truncatedTail.every((message) => message.role === "assistant")
  ) {
    return previousMessages;
  }

  return nextMessages;
}

function threadRegressedFromLastVisible(params: {
  currentMessages: UIMessage[];
  lastVisibleMessages: UIMessage[];
}): boolean {
  const { currentMessages, lastVisibleMessages } = params;
  if (lastVisibleMessages.length === 0) {
    return false;
  }

  const currentLastMessage = currentMessages.at(-1);
  const lastVisibleLastMessage = lastVisibleMessages.at(-1);

  if (!currentLastMessage || !lastVisibleLastMessage) {
    return false;
  }

  const lostAssistantTail =
    currentLastMessage.role !== "assistant" &&
    lastVisibleLastMessage.role === "assistant";
  const shortenedThread = currentMessages.length < lastVisibleMessages.length;

  return lostAssistantTail || shortenedThread;
}

function sameMessageIdentity(a: UIMessage, b: UIMessage | undefined): boolean {
  return !!b && a.id === b.id && a.role === b.role;
}
