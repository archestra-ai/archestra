import logger from "@/logging";
import { MessageModel } from "@/models";
import type { ChatMessage } from "@/types";
import { estimateMessagesSize } from "@/utils/message-size";
import { collectResolvedApprovalToolCallIds } from "./approval-resolution";
import { normalizeChatMessages } from "./normalization/normalize-chat-messages";

/**
 * Insert messages whose IDs aren't already in the DB, plus run the
 * approval-resolution sweep: when an incoming assistant message carries a
 * tool part in a terminal approval state (`approval-responded`,
 * `output-available`, `output-error`, `output-denied`) and a prior persisted
 * message still has that `toolCallId` in `approval-requested`, delete the
 * prior row so `tool_use` ids stay unique across the conversation.
 *
 * Caller contract: pass a fully resolved message list. From `onFinish` use
 * the `finalMessages` argument; from `onError` / `onExecuteError` use the
 * request body `messages`. From `earlyUserMsg` filter the request body to
 * user role only — the assistant on a continuation request is in an
 * intermediate state, and `getMessagesNotYetPersisted` dedups by
 * `content.id`, which would block `onFinish` from writing the final state.
 */
export async function persistNewMessages(
  conversationId: string,
  messages: unknown[],
  context: string,
): Promise<number> {
  try {
    const existingMessages =
      await MessageModel.findByConversation(conversationId);
    const uiMessages = messages as ChatMessage[];

    let didDeleteStale = false;
    const resolvedToolCallIds = collectResolvedApprovalToolCallIds(uiMessages);
    if (resolvedToolCallIds.size > 0) {
      const idsToDelete: string[] = [];
      for (const toolCallId of resolvedToolCallIds) {
        const stale = await MessageModel.findPriorApprovalRequestedByToolCallId(
          {
            conversationId,
            toolCallId,
          },
        );
        if (stale) idsToDelete.push(stale.id);
      }
      if (idsToDelete.length > 0) {
        await MessageModel.bulkDelete(idsToDelete);
        didDeleteStale = true;
        logger.info(
          {
            conversationId,
            deletedCount: idsToDelete.length,
            resolvedToolCallIds: Array.from(resolvedToolCallIds),
            context,
          },
          "[Chat] Deleted stale approval-requested messages",
        );
      }
    }

    const refreshed = didDeleteStale
      ? await MessageModel.findByConversation(conversationId)
      : existingMessages;

    const newMessages = getMessagesNotYetPersisted({
      existingMessages: refreshed,
      uiMessages,
    });

    if (newMessages.length === 0) {
      return 0;
    }

    let messagesToSave = newMessages;
    if (newMessages[newMessages.length - 1].parts?.length === 0) {
      messagesToSave = newMessages.slice(0, -1);
    }

    if (messagesToSave.length === 0) {
      return 0;
    }

    let messagesToStore: ChatMessage[];

    if (context === "onFinish") {
      const beforeSize = estimateMessagesSize(messagesToSave);
      messagesToStore = normalizeChatMessages(messagesToSave);
      const afterSize = estimateMessagesSize(messagesToStore);
      logger.info(
        {
          messageCount: messagesToSave.length,
          beforeSizeKB: Math.round(beforeSize.length / 1024),
          afterSizeKB: Math.round(afterSize.length / 1024),
          savedKB: Math.round((beforeSize.length - afterSize.length) / 1024),
          sizeEstimateReliable:
            !beforeSize.isEstimated && !afterSize.isEstimated,
        },
        "[Chat] Stripped messages before saving to DB",
      );
    } else {
      messagesToStore = normalizeChatMessages(messagesToSave);
    }

    const now = Date.now();
    const messageData = messagesToStore.map((msg, index) => ({
      conversationId,
      role: msg.role ?? "assistant",
      content: msg,
      createdAt: new Date(now + index),
    }));

    await MessageModel.bulkCreate(messageData);

    logger.info(
      `Appended ${messagesToSave.length} new messages to conversation ${conversationId} (${context})`,
    );

    return messagesToSave.length;
  } catch (error) {
    logger.error(
      { error, conversationId, context },
      `Failed to persist messages during ${context}`,
    );
    throw error;
  }
}

export function getMessagesNotYetPersisted(params: {
  existingMessages: Array<{ id: string; content: unknown }>;
  uiMessages: ChatMessage[];
}): ChatMessage[] {
  const existingIds = new Set<string>();

  for (const message of params.existingMessages) {
    existingIds.add(message.id);

    const contentId =
      typeof message.content === "object" &&
      message.content !== null &&
      "id" in message.content &&
      typeof message.content.id === "string"
        ? message.content.id
        : null;

    if (contentId) {
      existingIds.add(contentId);
    }
  }

  return params.uiMessages.filter((message) => {
    if (!message.id || typeof message.id !== "string") {
      return true;
    }

    return !existingIds.has(message.id);
  });
}
