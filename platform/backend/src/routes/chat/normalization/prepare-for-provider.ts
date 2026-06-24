import type { SupportedProvider } from "@archestra/shared";
import type { ChatMessage, ChatMessagePart } from "@/types";

/**
 * Rewrite materialized messages into a shape the target provider's SDK accepts
 * before `convertToModelMessages`.
 *
 * Text-document file parts (CSV/JSON/Markdown/…) are handled three ways:
 * - `anthropic`/`bedrock`: rewrite the document part's mediaType to text/plain
 *   (their SDKs base64-decode text/plain documents natively).
 * - `gemini`: pass through — @ai-sdk/google inlines any file part as inlineData,
 *   which is base64 the Gemini API decodes server-side.
 * - every other provider, including `cohere`: the document is inlined as a
 *   `text` part with its decoded content. OpenAI-compatible/groq/xai/mistral
 *   SDKs throw `UnsupportedFunctionalityError` for any non-image/-pdf file part
 *   (including text/plain); @ai-sdk/cohere instead relays a data-URL file part's
 *   raw base64 body as document text WITHOUT decoding it (its media-type
 *   handling only runs for `Uint8Array` data, never our data-URL strings), so
 *   the model would see base64. Inlining the decoded text fixes both.
 */
export function prepareMessagesForProvider(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
}): ChatMessage[] {
  const { messages, provider } = params;

  if (provider === "anthropic") {
    return messages.map(normalizeAnthropicMessageFileParts);
  }

  if (provider === "bedrock") {
    return messages
      .map(normalizeBedrockMessageFileParts)
      .map((message) =>
        ensureBedrockMessageHasContent(
          ensureBedrockUserMessageHasTextPart(message),
        ),
      );
  }

  // @ai-sdk/google inlines any file part as inlineData — the document survives.
  if (provider === "gemini") {
    return messages;
  }

  return messages.map(inlineTextDocumentMessageFileParts);
}

// ===== Inline-as-text path (providers that reject document file parts) =====

function inlineTextDocumentMessageFileParts(message: ChatMessage): ChatMessage {
  if (!message.parts?.length) {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    const inlined = inlineTextDocumentFilePart(part);
    if (inlined !== part) {
      changed = true;
    }
    return inlined;
  });

  return changed ? { ...message, parts } : message;
}

function inlineTextDocumentFilePart(part: ChatMessagePart): ChatMessagePart {
  if (
    part.type !== "file" ||
    typeof part.mediaType !== "string" ||
    !isInlineableTextDocumentMimeType(part.mediaType)
  ) {
    return part;
  }

  const decoded = decodeBase64DataUrlText(
    typeof part.url === "string" ? part.url : undefined,
    part.mediaType,
  );
  if (decoded === null) {
    // Either not a base64 data: URL we can decode (e.g. an unresolved ref), or
    // the bytes are not valid UTF-8 (e.g. a binary .xls mislabeled as a text
    // document). Leave the part as-is rather than inlining replacement-char
    // garbage — the provider SDK rejects it and the error mapper names the
    // unsupported media type.
    return part;
  }

  const name =
    typeof part.filename === "string" && part.filename.length > 0
      ? part.filename
      : "attachment";
  return {
    type: "text",
    text: `[Attachment ${JSON.stringify(name)} (${part.mediaType})]\n\n${decoded}`,
  };
}

/**
 * Text-document mime types whose content can be inlined as a text part for
 * providers that reject document file parts. Kept separate from
 * {@link isAnthropicTextDocumentMimeType} so the anthropic rewrite path stays
 * byte-identical (it intentionally excludes text/plain).
 */
export function isInlineableTextDocumentMimeType(mediaType: string): boolean {
  return (
    mediaType === "text/csv" ||
    mediaType === "application/csv" ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType === "text/markdown" ||
    mediaType === "application/json" ||
    mediaType === "text/plain"
  );
}

// Decodes the base64 body of a `data:<mediaType>;base64,...` URL as UTF-8.
// Returns null for any other URL shape (the pipeline always produces this exact
// form; see materialize-attachments + normalizeDataUrlMediaType) OR when the
// bytes are not valid UTF-8 — a fatal decoder rejects binary content so we never
// inline replacement-character garbage as authoritative attachment text.
function decodeBase64DataUrlText(
  url: string | undefined,
  mediaType: string,
): string | null {
  const prefix = `data:${mediaType};base64,`;
  if (!url?.startsWith(prefix)) {
    return null;
  }
  const bytes = Buffer.from(url.slice(prefix.length), "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ===== Anthropic =====

function normalizeAnthropicMessageFileParts(message: ChatMessage): ChatMessage {
  if (!message.parts?.length) {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    const normalizedPart = normalizeAnthropicFilePart(part);
    if (normalizedPart !== part) {
      changed = true;
    }
    return normalizedPart;
  });

  return changed ? { ...message, parts } : message;
}

function normalizeAnthropicFilePart(part: ChatMessagePart): ChatMessagePart {
  if (
    part.type !== "file" ||
    typeof part.mediaType !== "string" ||
    !isAnthropicTextDocumentMimeType(part.mediaType)
  ) {
    return part;
  }

  return {
    ...part,
    mediaType: "text/plain",
    url: normalizeDataUrlMediaType({
      url: typeof part.url === "string" ? part.url : undefined,
      fromMediaType: part.mediaType,
      toMediaType: "text/plain",
    }),
  };
}

function isAnthropicTextDocumentMimeType(mediaType: string): boolean {
  return (
    mediaType === "text/csv" ||
    mediaType === "text/markdown" ||
    mediaType === "application/csv" ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType === "application/json"
  );
}

// ===== Bedrock =====

function normalizeBedrockMessageFileParts(message: ChatMessage): ChatMessage {
  if (!message.parts?.length) {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    const normalizedPart = normalizeBedrockFilePart(part);
    if (normalizedPart !== part) {
      changed = true;
    }
    return normalizedPart;
  });

  return changed ? { ...message, parts } : message;
}

function normalizeBedrockFilePart(part: ChatMessagePart): ChatMessagePart {
  if (
    part.type !== "file" ||
    typeof part.mediaType !== "string" ||
    !isBedrockTextNormalizableMimeType(part.mediaType)
  ) {
    return part;
  }

  return {
    ...part,
    mediaType: "text/plain",
    url: normalizeDataUrlMediaType({
      url: typeof part.url === "string" ? part.url : undefined,
      fromMediaType: part.mediaType,
      toMediaType: "text/plain",
    }),
  };
}

// MIMEs that contain text content but aren't in Bedrock's natively supported
// document list — normalize to text/plain so the AI SDK can relay them.
function isBedrockTextNormalizableMimeType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType === "application/csv";
}

// Bedrock rejects user messages that contain a file/document block but no text
// block ("A text block must be included when using documents."). When the user
// sends a file with an empty prompt, prepend a placeholder so the request is
// accepted.
function ensureBedrockUserMessageHasTextPart(
  message: ChatMessage,
): ChatMessage {
  if (message.role !== "user" || !message.parts?.length) {
    return message;
  }

  let hasFilePart = false;
  let hasNonEmptyTextPart = false;
  for (const part of message.parts) {
    if (part.type === "file") {
      hasFilePart = true;
    } else if (
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
    ) {
      hasNonEmptyTextPart = true;
    }
  }

  if (!hasFilePart || hasNonEmptyTextPart) {
    return message;
  }

  return {
    ...message,
    parts: [
      { type: "text", text: BEDROCK_DOCUMENT_PLACEHOLDER_TEXT },
      ...message.parts,
    ],
  };
}

/**
 * Workaround for AI SDK Bedrock conversion sending empty assistant content.
 *
 * The AI SDK can split assistant UI messages at `step-start` boundaries, then
 * drop provider-invisible parts during Bedrock conversion and send
 * `content: []`. Keep this until the upstream provider fix is released:
 * https://github.com/vercel/ai/issues/15248
 * https://github.com/vercel/ai/pull/15250
 */
function ensureBedrockMessageHasContent(message: ChatMessage): ChatMessage {
  if (message.role === "system" || message.role === "tool") {
    return message;
  }
  if (message.role === "assistant") {
    return ensureBedrockAssistantMessageHasContent(message);
  }
  if (message.parts?.some(producesBedrockContentBlock)) {
    return message;
  }

  return {
    ...message,
    parts: message.parts
      ? [...message.parts, createBedrockEmptyContentPlaceholder()]
      : [createBedrockEmptyContentPlaceholder()],
  };
}

function ensureBedrockAssistantMessageHasContent(
  message: ChatMessage,
): ChatMessage {
  if (!message.parts?.length) {
    return {
      ...message,
      parts: [createBedrockEmptyContentPlaceholder()],
    };
  }

  let changed = false;
  let blockHasAnyPart = false;
  let blockHasContent = false;
  const parts: ChatMessagePart[] = [];

  const padCurrentBlockIfEmpty = () => {
    if (blockHasAnyPart && !blockHasContent) {
      parts.push(createBedrockEmptyContentPlaceholder());
      changed = true;
    }
    blockHasAnyPart = false;
    blockHasContent = false;
  };

  for (const part of message.parts) {
    if (part.type === "step-start") {
      padCurrentBlockIfEmpty();
      parts.push(part);
      continue;
    }

    parts.push(part);
    blockHasAnyPart = true;
    if (producesBedrockContentBlock(part)) {
      blockHasContent = true;
    }
  }

  padCurrentBlockIfEmpty();

  return changed ? { ...message, parts } : message;
}

function createBedrockEmptyContentPlaceholder(): ChatMessagePart {
  return {
    type: "text",
    text: BEDROCK_EMPTY_CONTENT_PLACEHOLDER_TEXT,
  };
}

// Mirrors the AI SDK's UI-to-model conversion plus Bedrock's converter:
// data/control parts are ignored without a converter, streaming tool inputs are
// dropped, and empty text/reasoning blocks are not provider-visible content.
function producesBedrockContentBlock(part: ChatMessagePart): boolean {
  if (part.type === "text") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  if (part.type === "file") {
    return true;
  }
  if (part.type === "reasoning") {
    const providerMetadata =
      (part.providerMetadata as { bedrock?: unknown } | undefined) ??
      (part.providerOptions as { bedrock?: unknown } | undefined);
    const bedrock = providerMetadata?.bedrock as
      | { signature?: unknown; redactedData?: unknown }
      | undefined;
    return Boolean(bedrock?.signature || bedrock?.redactedData);
  }
  if (part.type.startsWith("tool-")) {
    return part.state !== "input-streaming";
  }
  return false;
}

const BEDROCK_DOCUMENT_PLACEHOLDER_TEXT =
  "Please review the attached document.";
const BEDROCK_EMPTY_CONTENT_PLACEHOLDER_TEXT = "(no content)";

function normalizeDataUrlMediaType(params: {
  url: string | undefined;
  fromMediaType: string;
  toMediaType: string;
}): string | undefined {
  const { url, fromMediaType, toMediaType } = params;

  if (!url?.startsWith(`data:${fromMediaType};`)) {
    return url;
  }

  return url.replace(`data:${fromMediaType};`, `data:${toMediaType};`);
}
