import config from "@/config";
import logger from "@/logging";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import { SKILL_SANDBOX_ATTACHMENTS_DIR } from "@/skills-sandbox/runtime-image";
import type { ChatMessage, ChatMessagePart } from "@/types";
import {
  isAttachmentRefUrl,
  parseAttachmentIdFromUrl,
} from "./extract-inline-attachments";
import { isInlineableTextDocumentMimeType } from "./prepare-for-provider";

type Attachment = Awaited<
  ReturnType<typeof ConversationAttachmentModel.findByIdsWithData>
>[number];

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
  ingestibleMimeTypes?: Set<string>,
  // Anthropic `cache_control` is an Anthropic-only request-body feature. Emit it
  // by default (it is inert metadata for non-Anthropic SDKs), but suppress it
  // when the call targets an Anthropic-compatible third-party endpoint that
  // rejects the marker with a turn-0 400. The caller knows the provider/endpoint.
  applyAnthropicCacheControl = true,
  // True for an Anthropic-compatible third-party endpoint (custom base URL, non
  // Claude model) that rejects an Anthropic `document` content block. A binary
  // document (e.g. a PDF) that such an endpoint can't accept is rerouted to the
  // sandbox instead of inlined as a block that 400s the whole turn.
  rerouteBinaryDocsToSandbox = false,
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
      parts: message.parts.flatMap((part) =>
        materializePart(
          part,
          byId,
          ingestibleMimeTypes,
          applyAnthropicCacheControl,
          rerouteBinaryDocsToSandbox,
        ),
      ),
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
  byId: Map<string, Attachment>,
  ingestibleMimeTypes: Set<string> | undefined,
  applyAnthropicCacheControl: boolean,
  rerouteBinaryDocsToSandbox: boolean,
): ChatMessagePart | ChatMessagePart[] {
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
      // No attachment row backs an inline data URL, so it was never staged into
      // the sandbox — a binary document an Anthropic-compatible endpoint rejects
      // can't be rerouted, only dropped with a notice (better than a turn-0 400).
      const mime = dataUrlMimeType(part);
      if (
        rerouteBinaryDocsToSandbox &&
        mime !== undefined &&
        isNonInlineableBinaryDocMimeType(mime)
      ) {
        return unavailableBinaryDocPart(part, mime);
      }
      return applyAnthropicCacheControl
        ? withAnthropicCacheControl(part)
        : { ...part };
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

  // A file the selected model can't read must not be inlined as a document the
  // provider would reject (which hard-errors the whole turn). Two cases:
  //   - the model's modalities don't cover this mime; or
  //   - an Anthropic-compatible third-party endpoint can't accept the binary
  //     `document` block this mime would become (PDF and other non-image,
  //     non-text-inlineable types), regardless of the model's nominal modality.
  // Either way the file has auto-staged into the sandbox, so reference it there.
  const modelCannotRead =
    ingestibleMimeTypes !== undefined &&
    !ingestibleMimeTypes.has(attachment.mimeType);
  const endpointRejectsBinaryDoc =
    rerouteBinaryDocsToSandbox &&
    isNonInlineableBinaryDocMimeType(attachment.mimeType);
  if (modelCannotRead || endpointRejectsBinaryDoc) {
    return referenceSandboxFilePart(attachment);
  }

  // findByIdsWithData normalizes bytea to Buffer at the model boundary
  const dataUrl = `data:${attachment.mimeType};base64,${attachment.fileData.toString("base64")}`;
  // Mark the part for Anthropic ephemeral prompt caching when the endpoint
  // accepts it. The AI SDK reads this via the file UI part's provider metadata
  // (`providerMetadata`); convertToModelMessages translates it into the
  // provider's cache_control directive. Suppressed for Anthropic-compatible
  // third-party endpoints that reject the marker; the bytes still inline.
  const filePart: ChatMessagePart = applyAnthropicCacheControl
    ? {
        ...part,
        url: dataUrl,
        mediaType: attachment.mimeType,
        filename: attachment.originalName,
        providerMetadata: {
          ...(typeof part.providerMetadata === "object" &&
          part.providerMetadata !== null
            ? (part.providerMetadata as Record<string, unknown>)
            : {}),
          anthropic: {
            cacheControl: { type: "ephemeral" },
          },
        },
      }
    : {
        ...part,
        url: dataUrl,
        mediaType: attachment.mimeType,
        filename: attachment.originalName,
      };

  // Dual availability: a text-document that is shown inline is ALSO auto-staged
  // into the sandbox (same byte limit), so the model can both read it in context
  // and process it with run_command. Point it there alongside the inline copy.
  const pointer = dualAvailabilityPointer(attachment);
  return pointer ? [filePart, pointer] : filePart;
}

/**
 * When the skill sandbox is enabled and a text-document attachment is within the
 * auto-staging size limit, it has been staged under
 * {@link SKILL_SANDBOX_ATTACHMENTS_DIR}. Return a text part telling the model the
 * inlined file is ALSO available there (distinct from
 * {@link referenceSandboxFilePart}, which replaces an attachment the model can't
 * see inline). Returns null when the sandbox is off, the file is over the limit
 * (not staged), or the mime type is not an inlineable text-document.
 *
 * `originalName` is client-controlled, so it is JSON-encoded to keep a crafted
 * filename from breaking out of this platform-generated notice.
 */
function dualAvailabilityPointer(
  attachment: Attachment,
): ChatMessagePart | null {
  if (
    !config.skillsSandbox.enabled ||
    !isInlineableTextDocumentMimeType(attachment.mimeType)
  ) {
    return null;
  }
  if (
    attachment.fileData.byteLength > config.skillsSandbox.artifactBytesLimit
  ) {
    return null;
  }

  const name = JSON.stringify(attachment.originalName ?? "attachment");
  return {
    type: "text",
    text: `[The attached file ${name} is also available in your sandbox under ${SKILL_SANDBOX_ATTACHMENTS_DIR} — run \`ls ${SKILL_SANDBOX_ATTACHMENTS_DIR}\` to find it (the filename may be sanitized), then process it with run_command.]`,
  };
}

/**
 * A mime that an Anthropic-compatible third-party endpoint can't accept inline.
 * Such an endpoint takes images (as image blocks) and the text documents
 * {@link prepareMessagesForProvider} inlines as text; everything else (PDF and
 * other binaries) only travels as a `document` block the endpoint rejects.
 */
function isNonInlineableBinaryDocMimeType(mime: string): boolean {
  return !mime.startsWith("image/") && !isInlineableTextDocumentMimeType(mime);
}

/** Mime of an inline `data:` file part, from `mediaType` or the URL prefix. */
function dataUrlMimeType(part: ChatMessagePart): string | undefined {
  if (part.type !== "file") return undefined;
  if (typeof part.mediaType === "string" && part.mediaType.length > 0) {
    return part.mediaType;
  }
  if (typeof part.url !== "string") return undefined;
  return /^data:([^;,]+)[;,]/.exec(part.url)?.[1];
}

/**
 * An inline `data:` binary document has no attachment row, so it was never
 * staged into the sandbox and can't be referenced there. Drop it with a notice
 * rather than emit a `document` block that 400s an Anthropic-compatible endpoint.
 */
function unavailableBinaryDocPart(
  part: ChatMessagePart,
  mime: string,
): ChatMessagePart {
  const filename =
    part.type === "file" && typeof part.filename === "string"
      ? part.filename
      : "attachment";
  const name = JSON.stringify(filename);
  return {
    type: "text",
    text: `[Attachment ${name} (${mime}) can't be shown to this model this turn.]`,
  };
}

/**
 * Replace a non-ingestible attachment file part with a text part that points
 * the model at the file in its sandbox. Within the auto-staging size limit the
 * file lives under {@link SKILL_SANDBOX_ATTACHMENTS_DIR} — we name the directory
 * (not an exact path, since the staged filename is sanitized and deduplicated
 * by the runtime) and tell the model to list it. Over the limit the file is not
 * staged at all, so the model is told it is unavailable this turn rather than
 * pointed at a session-authed URL it cannot fetch from the sandbox.
 *
 * `originalName` is client-controlled, so it is JSON-encoded to keep a crafted
 * filename from breaking out of this platform-generated notice.
 */
function referenceSandboxFilePart(attachment: Attachment): ChatMessagePart {
  const sizeBytes = attachment.fileData.byteLength;
  const name = JSON.stringify(attachment.originalName ?? "attachment");
  const label = `${name} (${attachment.mimeType}, ${sizeBytes} bytes)`;
  const limit = config.skillsSandbox.artifactBytesLimit;

  if (sizeBytes > limit) {
    return {
      type: "text",
      text: `[Attachment ${label} can't be shown to this model and is too large (limit ${limit} bytes) to use in your sandbox this turn.]`,
    };
  }

  return {
    type: "text",
    text: `[Attachment ${label} can't be shown to this model inline. It has been placed in your sandbox under ${SKILL_SANDBOX_ATTACHMENTS_DIR} — run \`ls ${SKILL_SANDBOX_ATTACHMENTS_DIR}\` to find it (the filename may be sanitized), then read it with run_command.]`,
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
