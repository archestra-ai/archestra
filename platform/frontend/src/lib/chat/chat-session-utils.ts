import type { UIMessage } from "@ai-sdk/react";

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
