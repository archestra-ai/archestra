import type { UIMessage } from "@ai-sdk/react";
import type { archestraApiTypes } from "@shared";

const DEFAULT_SESSION_NAME = "New Chat Session";

export const PERSISTED_MESSAGE_ID_METADATA_KEY = "persistedMessageId";

export type ConversationShareVisibility = NonNullable<
  archestraApiTypes.GetChatConversationsResponses["200"][number]["share"]
>["visibility"];

/**
 * Builds the external agent ID header value for chat requests.
 * Strips non-ISO-8859-1 characters since HTTP headers reject them.
 */
export function getChatExternalAgentId(appName: string): string {
  const id = `${appName} Chat`;
  return id
    .replace(/[^\x20-\xff]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Generates localStorage keys scoped to a specific conversation.
 * Use this everywhere conversation-specific keys are read/written/removed
 * so that key formats stay in sync (especially for cleanup on deletion).
 */
export function conversationStorageKeys(conversationId: string) {
  return {
    artifactOpen: `archestra-chat-artifact-open-${conversationId}`,
    draft: `archestra_chat_draft_${conversationId}`,
    pinnedCanvas: `archestra-chat-pinned-canvas-${conversationId}`,
  };
}

/**
 * Extracts a display title for a conversation.
 * Priority: explicit title > first user message > default session name
 */
export function getConversationDisplayTitle(
  title: string | null,
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[],
): string {
  if (title) return title;

  // Try to extract from first user message
  if (messages && messages.length > 0) {
    for (const msg of messages) {
      if (msg.role === "user" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            return part.text;
          }
        }
      }
    }
  }

  return DEFAULT_SESSION_NAME;
}

export function getConversationShareTooltip(
  visibility: ConversationShareVisibility | undefined,
) {
  if (visibility === "team") {
    return "Shared with selected teams";
  }

  if (visibility === "user") {
    return "Shared with selected users";
  }

  return "Shared with your organization";
}

export function getManualCompactionSkippedMessage(
  reason: string | undefined,
  status?: string,
): string {
  switch (reason) {
    case "nothing_to_compact":
      if (status === "existing") {
        return "Conversation is already compacted; there is no new older context to compact yet.";
      }
      return "Only the latest user turn is available, so there is no completed earlier context to compact yet.";
    case "missing_boundary_message_id":
      return "Older context exists, but it cannot be compacted because saved message IDs are missing.";
    case "not_beneficial":
      return "Context compaction was skipped because the generated summary would not reduce context usage.";
    case "using_existing_summary":
      return "Conversation is already using compacted context.";
    case "aborted":
      return "Context compaction was cancelled.";
    default:
      return "There is no completed earlier context to compact yet.";
  }
}

export function mergePersistedMessageMetadata(params: {
  liveMessages: UIMessage[];
  persistedMessages: UIMessage[];
}): UIMessage[] {
  const remainingPersistedMessages = [...params.persistedMessages];
  let changed = false;

  const mergedMessages = params.liveMessages.map((liveMessage) => {
    const liveMetadata = getObjectMetadata(liveMessage);
    const persistedMessageId = liveMetadata[PERSISTED_MESSAGE_ID_METADATA_KEY];
    const persistedIndexById =
      typeof persistedMessageId === "string"
        ? remainingPersistedMessages.findIndex(
            (persistedMessage) => persistedMessage.id === persistedMessageId,
          )
        : -1;
    const persistedIndex =
      persistedIndexById === -1
        ? remainingPersistedMessages.findIndex((persistedMessage) =>
            messagesHaveSameRenderableContent({
              liveMessage,
              persistedMessage,
            }),
          )
        : persistedIndexById;

    if (persistedIndex === -1) {
      return liveMessage;
    }

    const [persistedMessage] = remainingPersistedMessages.splice(
      persistedIndex,
      1,
    );
    if (!persistedMessage) {
      return liveMessage;
    }

    const parts = mergePersistedUserFileParts({
      liveMessage,
      persistedMessage,
    });

    changed =
      changed ||
      parts !== liveMessage.parts ||
      typeof persistedMessageId !== "string";
    return {
      ...liveMessage,
      parts,
      metadata: {
        ...getObjectMetadata(persistedMessage),
        ...liveMetadata,
        [PERSISTED_MESSAGE_ID_METADATA_KEY]: persistedMessage.id,
      },
    };
  });

  return changed ? mergedMessages : params.liveMessages;
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

function mergePersistedUserFileParts(params: {
  liveMessage: UIMessage;
  persistedMessage: UIMessage;
}) {
  if (
    params.liveMessage.role !== "user" ||
    !params.liveMessage.parts.some((part) => part.type === "file") ||
    !params.persistedMessage.parts.some((part) => part.type === "file")
  ) {
    return params.liveMessage.parts;
  }

  return params.persistedMessage.parts;
}

function getMessageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function getObjectMetadata(message: UIMessage): Record<string, unknown> {
  return typeof message.metadata === "object" && message.metadata !== null
    ? { ...message.metadata }
    : {};
}
