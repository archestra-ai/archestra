import logger from "@/logging";
import { ConversationAttachmentModel, ConversationModel } from "@/models";
import { isUuid } from "@/utils/uuid";

export async function loadConversationAttachmentSource(params: {
  organizationId: string;
  userId: string;
  conversationId: string | undefined;
  attachmentId?: string;
  filename?: string;
  latest?: boolean;
  latestMimeTypePrefix?: string;
}): Promise<
  { data: Buffer; mimeType: string; originalName: string } | { error: string }
> {
  const {
    organizationId,
    conversationId,
    attachmentId,
    filename,
    latest,
    latestMimeTypePrefix,
  } = params;
  if (!conversationId) {
    logRejected({ ...params, reason: "no_conversation_context" });
    return {
      error:
        "Using a chat attachment requires a conversation context. Select a file from the current conversation.",
    };
  }

  const lockedChatInfo =
    await ConversationModel.getLockedChatKeyInfo(conversationId);
  if (lockedChatInfo?.lockedChat) {
    return {
      error:
        "Files attached to a locked chat cannot be read here because they are encrypted with a key only the user's browser holds.",
    };
  }

  if (attachmentId != null && !isUuid(attachmentId)) {
    logRejected({ ...params, reason: "attachment_id_not_uuid" });
    return {
      error: `No accessible attachment with id "${attachmentId}" exists. Pass the attachment's id, or select it by filename instead.`,
    };
  }

  let attachment =
    attachmentId != null
      ? await ConversationAttachmentModel.findByIdWithData(attachmentId)
      : filename != null
        ? await ConversationAttachmentModel.findLatestByNameWithData({
            conversationId,
            originalName: filename,
          })
        : null;
  if (!attachment && latest) {
    const metadata =
      await ConversationAttachmentModel.findByConversationIdWithoutData(
        conversationId,
      );
    const newest = latestMimeTypePrefix
      ? metadata
          .slice()
          .reverse()
          .find((item) => item.mimeType.startsWith(latestMimeTypePrefix))
      : metadata.at(-1);
    attachment = newest
      ? await ConversationAttachmentModel.findByIdWithData(newest.id)
      : null;
  }
  if (!attachment || attachment.organizationId !== organizationId) {
    logRejected({
      ...params,
      reason: "attachment_not_found_or_wrong_org",
    });
    return {
      error:
        attachmentId != null
          ? `No accessible attachment with id ${attachmentId} exists.`
          : filename != null
            ? `No attachment named "${filename}" exists in this conversation.`
            : latestMimeTypePrefix === "image/"
              ? "No image attachment exists in this conversation. Attach an image, then retry."
              : "No attachment exists in this conversation.",
    };
  }
  if (attachment.conversationId !== conversationId) {
    logRejected({ ...params, reason: "cross_conversation_attachment" });
    return {
      error:
        "That attachment belongs to a different conversation and cannot be used here.",
    };
  }

  return {
    data: attachment.fileData,
    mimeType: attachment.mimeType,
    originalName: attachment.originalName,
  };
}

function logRejected(params: {
  organizationId: string;
  userId: string;
  conversationId: string | undefined;
  attachmentId?: string;
  filename?: string;
  latest?: boolean;
  latestMimeTypePrefix?: string;
  reason: string;
}) {
  logger.warn(
    params,
    "[ConversationAttachmentSource] rejected attachment read",
  );
}
