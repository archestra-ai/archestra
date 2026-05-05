import type { UIMessage } from "ai";

/**
 * Merge a live `useChat` thread with the persisted-from-DB thread.
 *
 * The two threads describe the same conversation but each carries facts the
 * other lacks:
 *   - The live thread is the source of truth for in-flight tokens, tool
 *     calls, and any optimistic state the user is currently looking at.
 *   - The persisted thread is the source of truth for `createdAt` timestamps
 *     and for any messages the backend wrote *while the live thread was not
 *     listening*. The classic case is a page reload while the LLM is still
 *     thinking: the new `useChat` instance starts from whatever was in the
 *     DB at that moment (just the user turn), and the assistant's reply
 *     lands in the DB later via `onFinish` — but the live thread never sees
 *     it.
 *
 * The merge therefore:
 *   1. Walks the live thread, decorating each message with the matching
 *      persisted message's metadata (so timestamps stay stable across
 *      remounts).
 *   2. If the live thread is awaiting an assistant turn (it ends with a
 *      user message, or it is empty), appends any persisted messages that
 *      come after the last matched live message. That recovers the missing
 *      assistant turn without resurrecting earlier history that the user
 *      may have intentionally edited away.
 */
export function mergePersistedMessageMetadata(params: {
  liveMessages: UIMessage[];
  persistedMessages: UIMessage[];
}): UIMessage[] {
  const matchedPersistedIds = new Set<string>();
  let lastMatchedPersistedIndex = -1;

  const merged = params.liveMessages.map((liveMessage) => {
    const persistedIndex = findMatchingPersistedIndex({
      liveMessage,
      persistedMessages: params.persistedMessages,
      matchedPersistedIds,
    });

    if (persistedIndex === -1) {
      return liveMessage;
    }

    const persistedMessage = params.persistedMessages[persistedIndex];
    matchedPersistedIds.add(persistedMessage.id);
    if (persistedIndex > lastMatchedPersistedIndex) {
      lastMatchedPersistedIndex = persistedIndex;
    }

    if (hasCreatedAtMetadata(liveMessage)) {
      return liveMessage;
    }

    return {
      ...liveMessage,
      metadata: {
        ...getObjectMetadata(persistedMessage),
        ...getObjectMetadata(liveMessage),
      },
    };
  });

  // Only resurrect persisted-only tail messages when the live thread
  // suggests it's waiting on an assistant turn. If the tail is already an
  // assistant message, the live thread is up-to-date and we should not
  // re-introduce older persisted history that may have been edited away.
  const lastLive = params.liveMessages[params.liveMessages.length - 1];
  const liveIsAwaitingAssistant = !lastLive || lastLive.role === "user";
  if (!liveIsAwaitingAssistant) {
    return merged;
  }

  const trailingPersisted = params.persistedMessages
    .slice(lastMatchedPersistedIndex + 1)
    .filter((message) => !matchedPersistedIds.has(message.id));

  if (trailingPersisted.length === 0) {
    return merged;
  }

  return [...merged, ...trailingPersisted];
}

function findMatchingPersistedIndex(params: {
  liveMessage: UIMessage;
  persistedMessages: UIMessage[];
  matchedPersistedIds: Set<string>;
}): number {
  // Prefer id-equality when both threads agree on a stable id (the common
  // case once the conversation has been hydrated from the DB at least once).
  if (typeof params.liveMessage.id === "string" && params.liveMessage.id) {
    const idMatch = params.persistedMessages.findIndex(
      (persistedMessage) =>
        persistedMessage.id === params.liveMessage.id &&
        !params.matchedPersistedIds.has(persistedMessage.id),
    );
    if (idMatch !== -1) {
      return idMatch;
    }
  }

  // Fall back to renderable-text matching for messages whose ids haven't
  // synced yet (e.g. an in-flight assistant message whose AI SDK temp id
  // doesn't match the eventual DB UUID).
  return params.persistedMessages.findIndex(
    (persistedMessage) =>
      !params.matchedPersistedIds.has(persistedMessage.id) &&
      messagesHaveSameRenderableContent({
        liveMessage: params.liveMessage,
        persistedMessage,
      }),
  );
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

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function hasCreatedAtMetadata(message: UIMessage): boolean {
  const metadata = getObjectMetadata(message);
  return typeof metadata.createdAt === "string";
}

function getObjectMetadata(message: UIMessage): Record<string, unknown> {
  return typeof message.metadata === "object" && message.metadata !== null
    ? { ...message.metadata }
    : {};
}
