import logger from "@/logging";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import type { ChatMessage, ChatMessagePart } from "@/types";
import {
  isAttachmentRefUrl,
  parseAttachmentIdFromUrl,
} from "./extract-inline-attachments";

/**
 * Returns a deep copy of `messages` where any file part whose `url` is a
 * chat-attachment reference has been rehydrated to an inline `data:` URL for
 * the LLM call. Adds Anthropic `cache_control: ephemeral` to materialized
 * document parts so prompt caching kicks in across turns. Legacy inline
 * `data:` URLs pass through unchanged (backward compat).
 *
 * Refs are scoped to `conversationId` — a client crafting a message with an
 * attachment id from a different conversation will see the ref left
 * unresolved (the LLM call won't fetch it). This closes a path where any
 * org member could pull cross-conversation attachments via materialize.
 *
 * Does NOT mutate the input — the caller retains refs in the persisted
 * messages.
 */
export async function materializeAttachments(
  messages: ChatMessage[],
  conversationId: string,
): Promise<ChatMessage[]> {
  const refIds = collectRefIds(messages);
  // Even when there are no refs to rehydrate, we still walk every part —
  // data: URL file parts (legacy messages or same-tab follow-ups whose FE
  // state lags the backend rewrite) need cache_control applied here, since
  // the alternative is Anthropic re-billing the full file on every turn.
  const attachments =
    refIds.length === 0
      ? []
      : await ConversationAttachmentModel.findByIdsWithData(refIds);
  // Filter to attachments owned by the current conversation. Anything
  // referencing an id outside this conversation is silently dropped from
  // the rehydration map — those parts stay with their ref URL, which
  // doesn't resolve into provider-readable content.
  const byId = new Map(
    attachments
      .filter((a) => a.conversationId === conversationId)
      .map((a) => [a.id, a]),
  );

  return messages.map((message) => {
    if (!message.parts || message.parts.length === 0) {
      return { ...message };
    }
    return {
      ...message,
      parts: message.parts.map((part) => materializePart(part, byId)),
    };
  });
}

function collectRefIds(messages: ChatMessage[]): string[] {
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
  return Array.from(ids);
}

function materializePart(
  part: ChatMessagePart,
  byId: Map<
    string,
    Awaited<
      ReturnType<typeof ConversationAttachmentModel.findByIdsWithData>
    >[number]
  >,
): ChatMessagePart {
  if (part.type !== "file" || typeof part.url !== "string") {
    return { ...part };
  }
  if (!isAttachmentRefUrl(part.url)) {
    // Inline data: URL — either a legacy pre-v1 message persisted that way,
    // or a same-tab follow-up where the FE's local state still holds the
    // original data URL while the persisted state has a ref. Either way, the
    // LLM payload is correct (data URL inline), but we still want Anthropic
    // to prompt-cache the file across turns. Without this marker, the same
    // bytes get re-billed at full input price on every turn until reload.
    if (part.url.startsWith("data:")) {
      return withAnthropicCacheControl(part);
    }
    return { ...part };
  }

  const id = parseAttachmentIdFromUrl(part.url);
  if (!id) {
    logger.warn(
      { url: part.url },
      "[materializeAttachments] Malformed attachment ref URL",
    );
    return { ...part };
  }

  const attachment = byId.get(id);
  if (!attachment) {
    logger.warn(
      { attachmentId: id },
      "[materializeAttachments] Attachment row not found; skipping materialization",
    );
    return { ...part };
  }

  // PGlite (used by tests) returns bytea as a Uint8Array; node-postgres
  // returns a Buffer. Normalize before encoding so .toString("base64") is the
  // real Node Buffer method, not Array.prototype.toString (which gives a
  // comma-separated decimal list).
  const buffer = Buffer.isBuffer(attachment.fileData)
    ? attachment.fileData
    : Buffer.from(attachment.fileData as Uint8Array);
  const dataUrl = `data:${attachment.mimeType};base64,${buffer.toString("base64")}`;
  return {
    ...part,
    url: dataUrl,
    mediaType: attachment.mimeType,
    filename: attachment.originalName,
    // Mark the part for Anthropic ephemeral prompt caching. The AI SDK reads
    // this via the file UI part's provider metadata (`providerMetadata`);
    // convertToModelMessages translates it into the provider's cache_control
    // directive.
    providerMetadata: {
      ...(typeof part.providerMetadata === "object" &&
      part.providerMetadata !== null
        ? (part.providerMetadata as Record<string, unknown>)
        : {}),
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
    },
  };
}

function withAnthropicCacheControl(part: ChatMessagePart): ChatMessagePart {
  return {
    ...part,
    providerMetadata: {
      ...(typeof part.providerMetadata === "object" &&
      part.providerMetadata !== null
        ? (part.providerMetadata as Record<string, unknown>)
        : {}),
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
    },
  };
}
