import logger from "@/logging";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import type { ChatMessage, ChatMessagePart } from "@/types";
import { loadPdfParser } from "../context-compaction";

const ATTACHMENT_URL_PREFIX = "/api/chat/attachments/";
const ATTACHMENT_URL_SUFFIX = "/content";
const TEXT_PREVIEW_MAX_CHARS = 80_000;
const SYNC_PDF_PARSE_MAX_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Walks the in-memory messages, finds file parts with `data:` URLs, stores the
 * bytes in `chat_attachments`, and rewrites the part's `url` to a server-side
 * reference. Mutates `messages` in place. Idempotent across re-uploads of the
 * same bytes within an org (content-hash dedup).
 */
export async function extractInlineAttachments(args: {
  messages: ChatMessage[];
  conversationId: string;
  organizationId: string;
  uploadedByUserId: string;
}): Promise<void> {
  const { messages, conversationId, organizationId, uploadedByUserId } = args;

  for (const message of messages) {
    if (!message.parts) continue;
    // Skip messages already persisted to the DB on a prior turn. The FE
    // re-sends the full conversation history on every send, so without this
    // we'd re-decode + re-hash + DB-hit every legacy inline data: URL on
    // every new turn. Settled messages never get rewritten back into the
    // persisted row anyway — persistNewMessages only appends.
    if (isAlreadyPersistedMessage(message)) continue;

    for (const part of message.parts) {
      if (!isExtractableFilePart(part)) continue;

      try {
        const decoded = decodeDataUrl(part.url);
        if (!decoded) continue;

        const { buffer, mimeType } = decoded;
        const contentHash =
          ConversationAttachmentModel.computeContentHash(buffer);
        const filename =
          typeof part.filename === "string" && part.filename.length > 0
            ? part.filename
            : `attachment-${contentHash.slice(0, 12)}`;
        const partMime =
          typeof part.mediaType === "string" && part.mediaType.length > 0
            ? part.mediaType
            : mimeType;

        // Conversation-scoped dedup: when the AI SDK client re-sends history
        // on each turn, prior messages may still carry inline data URLs in
        // memory. Reusing the same row within one conversation avoids
        // creating orphan attachment rows on every turn. Scope is intentional
        // — same conversation = same security boundary, no cross-conv issues.
        let attachment =
          await ConversationAttachmentModel.findByConversationAndContentHash(
            conversationId,
            contentHash,
          );
        if (!attachment) {
          attachment = await ConversationAttachmentModel.create({
            organizationId,
            conversationId,
            uploadedByUserId,
            originalName: filename,
            mimeType: partMime,
            fileSize: buffer.byteLength,
            contentHash,
            fileData: buffer,
            textPreviewStatus: "pending",
          });
          await extractTextPreview(attachment.id, partMime, buffer);
        }

        rewritePartToRef(
          part,
          attachment.id,
          attachment.fileSize,
          attachment.mimeType,
        );
      } catch (err) {
        logger.warn(
          { err, conversationId, role: message.role },
          "[extractInlineAttachments] Failed to extract inline attachment; leaving inline",
        );
        // Leave the data: URL in place — the request can still proceed
        // (legacy path), only this attachment misses the optimization.
      }
    }
  }
}

function isExtractableFilePart(
  part: ChatMessagePart,
): part is ChatMessagePart & {
  url: string;
} {
  return (
    part.type === "file" &&
    typeof part.url === "string" &&
    part.url.startsWith("data:")
  );
}

function isAlreadyPersistedMessage(message: ChatMessage): boolean {
  if (
    !("metadata" in message) ||
    typeof message.metadata !== "object" ||
    message.metadata === null
  ) {
    return false;
  }
  const persistedId = (message.metadata as { persistedMessageId?: unknown })
    .persistedMessageId;
  return typeof persistedId === "string" && persistedId.length > 0;
}

function decodeDataUrl(
  url: string,
): { buffer: Buffer; mimeType: string } | null {
  const commaIdx = url.indexOf(",");
  if (commaIdx < 5) return null;

  const meta = url.slice(5, commaIdx);
  const payload = url.slice(commaIdx + 1);

  const isBase64 = meta.endsWith(";base64");
  const mimeType =
    (isBase64 ? meta.slice(0, -7) : meta) || "application/octet-stream";

  let buffer: Buffer;
  if (isBase64) {
    buffer = Buffer.from(payload, "base64");
  } else {
    buffer = Buffer.from(decodeURIComponent(payload), "utf8");
  }

  if (buffer.byteLength === 0) return null;
  return { buffer, mimeType };
}

async function extractTextPreview(
  attachmentId: string,
  mimeType: string,
  buffer: Buffer,
): Promise<void> {
  if (isTextLikeMimeType(mimeType)) {
    const text = buffer
      .toString("utf8")
      .replaceAll(String.fromCharCode(0), "")
      .slice(0, TEXT_PREVIEW_MAX_CHARS);
    await ConversationAttachmentModel.updateTextPreview(
      attachmentId,
      "ok",
      text,
    );
    return;
  }

  if (
    mimeType !== "application/pdf" ||
    buffer.byteLength > SYNC_PDF_PARSE_MAX_BYTES
  ) {
    await ConversationAttachmentModel.updateTextPreview(
      attachmentId,
      "unsupported",
      null,
    );
    return;
  }

  try {
    const parsed = await loadPdfParser()(buffer);
    // NUL bytes are valid in PDF streams but Postgres text columns reject
    // them ("invalid byte sequence for encoding UTF8: 0x00"). Strip them
    // before storing — same as context-compaction.ts does at write time.
    const text = (parsed.text ?? "")
      .replaceAll(String.fromCharCode(0), "")
      .slice(0, TEXT_PREVIEW_MAX_CHARS);
    await ConversationAttachmentModel.updateTextPreview(
      attachmentId,
      "ok",
      text,
    );
  } catch (err) {
    logger.warn(
      { err, attachmentId },
      "[extractInlineAttachments] PDF text extraction failed",
    );
    await ConversationAttachmentModel.updateTextPreview(
      attachmentId,
      "failed",
      null,
    );
  }
}

function isTextLikeMimeType(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  return (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/csv" ||
    mime === "application/x-yaml" ||
    mime === "application/yaml"
  );
}

function rewritePartToRef(
  part: ChatMessagePart,
  attachmentId: string,
  byteSize: number,
  mimeType: string,
): void {
  part.url = `${ATTACHMENT_URL_PREFIX}${attachmentId}${ATTACHMENT_URL_SUFFIX}`;
  // Carry the byte size on the part so compaction's sync token-estimate path
  // can compute a real estimate without a DB hit. Persisted into the JSONB
  // row; LLM never sees it (the materialize step rebuilds the part).
  part.fileSize = byteSize;
  if (!part.mediaType || typeof part.mediaType !== "string") {
    part.mediaType = mimeType;
  }
}

export function isAttachmentRefUrl(url: unknown): boolean {
  return (
    typeof url === "string" &&
    url.startsWith(ATTACHMENT_URL_PREFIX) &&
    url.endsWith(ATTACHMENT_URL_SUFFIX)
  );
}

export function parseAttachmentIdFromUrl(url: string): string | null {
  if (
    !url.startsWith(ATTACHMENT_URL_PREFIX) ||
    !url.endsWith(ATTACHMENT_URL_SUFFIX)
  ) {
    return null;
  }
  const id = url.slice(
    ATTACHMENT_URL_PREFIX.length,
    url.length - ATTACHMENT_URL_SUFFIX.length,
  );
  // Strict UUID — Postgres uuid column rejects anything else with `invalid
  // input syntax for type uuid`, which would surface as a 500 in fork /
  // materialize / compaction. The route handler's UuidIdSchema does the
  // authoritative check for the GET endpoint; this guards the internal paths.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  )
    ? id
    : null;
}

export { ATTACHMENT_URL_PREFIX, ATTACHMENT_URL_SUFFIX };
