import logger from "@/logging";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import type { ChatMessage } from "@/types";
import {
  ATTACHMENT_URL_PREFIX,
  ATTACHMENT_URL_SUFFIX,
  isAttachmentRefUrl,
  parseAttachmentIdFromUrl,
} from "./extract-inline-attachments";

/**
 * Clone attachment refs in a forked conversation. Each unique source-row id
 * referenced from `sourceMessages` is copied into a new `chat_attachments`
 * row scoped to the fork's `conversationId`, then the corresponding part
 * urls are rewritten to point at the new ids. Without this, the fork's
 * materialize step (which filters by conversationId) silently drops every
 * attachment from the LLM call, breaking the file context.
 *
 * Returns a new array of messages with refs rewritten; does not mutate
 * the input.
 */
export async function cloneAttachmentsForFork(args: {
  sourceMessages: ChatMessage[];
  sourceConversationId: string;
  newConversationId: string;
  newOrganizationId: string;
  newUploadedByUserId: string;
}): Promise<ChatMessage[]> {
  const {
    sourceMessages,
    sourceConversationId,
    newConversationId,
    newOrganizationId,
    newUploadedByUserId,
  } = args;

  const sourceIds = collectAttachmentIds(sourceMessages);
  if (sourceIds.size === 0) {
    return sourceMessages;
  }

  const allRows = await ConversationAttachmentModel.findByIdsWithData(
    Array.from(sourceIds),
  );
  // ACL: only clone rows that actually belong to the source conversation.
  // A client can persist a crafted ref (`/api/chat/attachments/<foreign-id>/content`)
  // into their own conversation's messages.content — `extractInlineAttachments`
  // only rewrites `data:` URLs and leaves other urls untouched. Without this
  // filter, fork would copy any reachable row by id into the attacker's new
  // conversation, where the GET endpoint's org+convo checks pass against the
  // freshly-minted row, exfiltrating the bytes.
  const rows = allRows.filter(
    (row) => row.conversationId === sourceConversationId,
  );
  const idMap = new Map<string, string>();
  for (const row of rows) {
    try {
      const cloned = await ConversationAttachmentModel.create({
        organizationId: newOrganizationId,
        conversationId: newConversationId,
        uploadedByUserId: newUploadedByUserId,
        originalName: row.originalName,
        mimeType: row.mimeType,
        fileSize: row.fileSize,
        contentHash: row.contentHash,
        fileData: row.fileData,
        textPreview: row.textPreview,
        textPreviewStatus: row.textPreviewStatus as
          | "ok"
          | "failed"
          | "unsupported"
          | "pending",
      });
      idMap.set(row.id, cloned.id);
    } catch (err) {
      logger.warn(
        { err, sourceAttachmentId: row.id, newConversationId },
        "[cloneAttachmentsForFork] Failed to clone attachment; rewriting will skip it",
      );
    }
  }

  return sourceMessages.map((message) => rewriteMessageRefs(message, idMap));
}

function collectAttachmentIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!message.parts) continue;
    for (const part of message.parts) {
      if (part.type !== "file" || typeof part.url !== "string") continue;
      if (!isAttachmentRefUrl(part.url)) continue;
      const id = parseAttachmentIdFromUrl(part.url);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function rewriteMessageRefs(
  message: ChatMessage,
  idMap: Map<string, string>,
): ChatMessage {
  if (!message.parts) return { ...message };
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "file" || typeof part.url !== "string") return part;
      if (!isAttachmentRefUrl(part.url)) return part;
      const oldId = parseAttachmentIdFromUrl(part.url);
      if (!oldId) return part;
      const newId = idMap.get(oldId);
      if (!newId) return part;
      return {
        ...part,
        url: `${ATTACHMENT_URL_PREFIX}${newId}${ATTACHMENT_URL_SUFFIX}`,
      };
    }),
  };
}
