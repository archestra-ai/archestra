import { MessageModel } from "@/models";
import { compactionSummaryText } from "@/services/context-compaction";
import type { ChatMessage } from "@/types";
import type { ConversationCompaction } from "@/types/conversation-compaction";

/**
 * Split the messages after the previous compaction boundary into the prefix
 * the summary replaces and the suffix kept verbatim: the latest real user
 * message stays live only while it is still unanswered.
 */
export function splitMessagesForCompaction(messages: ChatMessage[]): {
  compactable: ChatMessage[];
  recent: ChatMessage[];
} {
  const latestRealUserIndex = messages.findLastIndex(isRealUserMessage);
  if (latestRealUserIndex !== messages.length - 1) {
    // no real user turn, or it has been resolved by later turns (assistant /
    // tool-result-only pseudo-user messages); compact everything, no anchor
    return { compactable: messages, recent: [] };
  }
  return {
    compactable: messages.slice(0, latestRealUserIndex),
    recent: messages.slice(latestRealUserIndex),
  };
}

// a "real" user message is one the human authored — role: user with at least
// one user-authored text or file part. messages whose parts are only tool
// results (type starts with "tool-") happen to share role: user but should be
// treated as transcript content, not as a fresh user turn.
export function isRealUserMessage(message: ChatMessage): boolean {
  if (message.role !== "user" || !message.parts?.length) {
    return false;
  }

  return message.parts.some((part) => {
    if (part.type === "text") {
      return typeof part.text === "string" && part.text.length > 0;
    }
    return part.type === "file";
  });
}

export function buildSummaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    parts: [{ type: "text", text: compactionSummaryText(summary) }],
  };
}

/**
 * Replace the prefix covered by a stored compaction with its summary message.
 * A compaction whose boundary is not in the list is stale and unusable.
 * `boundaryIds` are every id the boundary message is known by (see
 * `getCompactionBoundaryIds`).
 */
export function resolveUsableCompaction<
  T extends Pick<ConversationCompaction, "summary">,
>(
  messages: ChatMessage[],
  compaction: T | null,
  boundaryIds: string[],
): { compaction: T | null; boundaryIndex: number; messages: ChatMessage[] } {
  const ids = new Set(boundaryIds);
  const boundaryIndex = compaction
    ? messages.findIndex((message) =>
        getMessageIdentityIds(message).some((id) => ids.has(id)),
      )
    : -1;
  if (!compaction || boundaryIndex < 0) {
    return { compaction: null, boundaryIndex: -1, messages };
  }

  return {
    compaction,
    boundaryIndex,
    messages: [
      buildSummaryMessage(compaction.summary),
      ...messages.slice(boundaryIndex + 1),
    ],
  };
}

/**
 * Every id the stored boundary message may carry in the live list: the
 * stored id, the persisted row id, and the client content id.
 */
export async function getCompactionBoundaryIds(
  compaction: Pick<ConversationCompaction, "compactedThroughMessageId"> | null,
  conversationId: string,
): Promise<string[]> {
  const boundaryId = compaction?.compactedThroughMessageId;
  if (!boundaryId) {
    return [];
  }

  const ids = new Set([boundaryId]);
  const boundaryMessage = await MessageModel.findByAnyIdInConversation(
    boundaryId,
    conversationId,
  );
  if (boundaryMessage?.id) {
    ids.add(boundaryMessage.id);
  }
  const contentId = getPersistedContentMessageId(boundaryMessage?.content);
  if (contentId) {
    ids.add(contentId);
  }

  return [...ids];
}

export async function resolveCompactionBoundaryMessageId(
  message: ChatMessage,
  conversationId: string,
): Promise<string | null> {
  const persistedMessageId = getPersistedMessageMetadataId(message);
  if (persistedMessageId) {
    return persistedMessageId;
  }

  if (!message.id) {
    return null;
  }

  // Conversation-scoped: content ids are client-supplied (non-unique across
  // conversations), and the scoped lookup stays correct under content
  // encryption where the SQL content->>'id' path cannot see into envelopes.
  const persistedMessage = await MessageModel.findByAnyIdInConversation(
    message.id,
    conversationId,
  );
  return persistedMessage?.id ?? message.id;
}

// =============================================================================
// Internal Helpers
// =============================================================================

function getPersistedContentMessageId(content: unknown): string | null {
  if (
    typeof content === "object" &&
    content !== null &&
    "id" in content &&
    typeof content.id === "string"
  ) {
    return content.id;
  }

  return null;
}

function getMessageIdentityIds(message: ChatMessage): string[] {
  const persistedMessageId = getPersistedMessageMetadataId(message);
  return [message.id, persistedMessageId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

function getPersistedMessageMetadataId(message: ChatMessage): string | null {
  const metadata =
    "metadata" in message &&
    typeof message.metadata === "object" &&
    message.metadata !== null
      ? (message.metadata as Record<string, unknown>)
      : null;
  const persistedMessageId = metadata?.persistedMessageId;
  return typeof persistedMessageId === "string" && persistedMessageId.length > 0
    ? persistedMessageId
    : null;
}
