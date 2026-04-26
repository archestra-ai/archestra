import type { UIMessage } from "@ai-sdk/react";

export function mergePersistedMessageMetadata(params: {
  liveMessages: UIMessage[];
  persistedMessages: UIMessage[];
}): UIMessage[] {
  const remainingPersistedMessages = [...params.persistedMessages];

  return params.liveMessages.map((liveMessage) => {
    if (hasCreatedAtMetadata(liveMessage)) {
      return liveMessage;
    }

    const persistedIndex = remainingPersistedMessages.findIndex(
      (persistedMessage) =>
        messagesHaveSameRenderableContent({
          liveMessage,
          persistedMessage,
        }),
    );

    if (persistedIndex === -1) {
      return liveMessage;
    }

    const [persistedMessage] = remainingPersistedMessages.splice(
      persistedIndex,
      1,
    );

    return {
      ...liveMessage,
      metadata: {
        ...getObjectMetadata(persistedMessage),
        ...getObjectMetadata(liveMessage),
      },
    };
  });
}

function messagesHaveSameRenderableContent(params: {
  liveMessage: UIMessage;
  persistedMessage: UIMessage;
}) {
  return (
    params.liveMessage.role === params.persistedMessage.role &&
    getMessageText(params.liveMessage) ===
      getMessageText(params.persistedMessage)
  );
}

function getMessageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function hasCreatedAtMetadata(message: UIMessage) {
  const metadata = getObjectMetadata(message);
  return typeof metadata.createdAt === "string";
}

function getObjectMetadata(message: UIMessage): Record<string, unknown> {
  return typeof message.metadata === "object" && message.metadata !== null
    ? { ...message.metadata }
    : {};
}
