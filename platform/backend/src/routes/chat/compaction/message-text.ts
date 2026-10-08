import type { SupportedProvider } from "@archestra/shared";
import logger from "@/logging";
import { ConversationAttachmentModel } from "@/models";
import {
  composeCompactionPrompt,
  renderCompactionTranscript,
  type TranscriptEntry,
  uiMessageTranscriptEntries,
} from "@/services/context-compaction";
import { getTokenizer } from "@/tokenizers";
import type { ChatMessage, ChatMessagePart } from "@/types";
import { estimateToolsTokens } from "../context-window-breakdown";
import {
  estimateFileTokens,
  isTextLikeMediaType,
} from "../normalization/estimate-message-tokens";
import {
  isAttachmentRefUrl,
  loadPdfParser,
  parseAttachmentIdFromUrl,
} from "../normalization/extract-inline-attachments";
import { isRealUserMessage } from "./history";

export function estimateChatMessagesTokens(params: {
  provider: SupportedProvider;
  /**
   * The model the estimate is for. Optional because a few call sites only ever
   * compare two estimates against each other (where a consistent yardstick is
   * all that matters), but pass it wherever the number is compared against the
   * context window — a reseller's provider id alone picks the wrong tokenizer
   * for Claude on Bedrock.
   */
  model?: string;
  systemPrompt?: string;
  tools?: Record<string, unknown>;
  messages: ChatMessage[];
}): number {
  const tokenizer = getTokenizer(params.provider, params.model);
  let extraTokens = 0;
  const providerMessages = params.messages.map((message) => {
    const estimate = getMessageTextForTokenEstimate(message);
    extraTokens += estimate.extraTokens;

    return {
      role: message.role,
      content: estimate.text,
    };
  });
  const messageTokens = tokenizer.countTokens(
    providerMessages as Parameters<typeof tokenizer.countTokens>[0],
  );
  const systemTokens = params.systemPrompt
    ? Math.ceil(params.systemPrompt.length / 4)
    : 0;
  const toolTokens = params.tools
    ? estimateToolsTokens({
        provider: params.provider,
        model: params.model ?? "",
        tools: params.tools,
      })
    : 0;

  return messageTokens + systemTokens + toolTokens + extraTokens;
}

/**
 * Builds the runtime user prompt for the configurable context compaction
 * subagent. The editable instructions live in
 * CONTEXT_COMPACTION_SYSTEM_PROMPT / the seeded built-in agent system prompt;
 * this function only assembles the current transcript and previous summary.
 */
export async function buildCompactionPrompt(params: {
  previousSummary: string | null;
  messages: ChatMessage[];
  conversationId: string;
}): Promise<string> {
  const entries = await Promise.all(
    params.messages.map((message) =>
      transcriptEntries(message, params.conversationId),
    ),
  );
  return composeCompactionPrompt({
    previousSummary: params.previousSummary,
    transcript: renderCompactionTranscript(entries.flat()),
    preamble: buildRecentUserMessagesReference(params.messages),
  });
}

export function decodeDataUrl(
  url: string,
): { mediaType: string; buffer: Buffer } | null {
  // split meta (everything between `data:` and the first `,`) from payload,
  // so media types with parameters like `text/plain;charset=utf-8;base64` parse correctly
  const match = /^data:([^,]*),(.*)$/s.exec(url);
  if (!match) {
    return null;
  }

  const { mediaType, isBase64 } = parseDataUrlMeta(match[1] ?? "");
  const payload = match[2] ?? "";
  try {
    const buffer = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mediaType, buffer };
  } catch {
    // malformed percent-encoding makes decodeURIComponent throw URIError;
    // treat the url as undecodable rather than aborting the chat turn.
    return null;
  }
}

export function getDataUrlMediaType(url: string): string {
  const match = /^data:([^,]*),/s.exec(url);
  return match
    ? parseDataUrlMeta(match[1] ?? "").mediaType
    : "application/octet-stream";
}

// =============================================================================
// Internal Helpers
// =============================================================================

// max number of recent real user messages serialized into the reference block
const RECENT_USER_REFERENCE_TURNS = 4;
const RECENT_USER_REFERENCE_MAX_CHARS = 6_000;
const MAX_FILE_TEXT_CHARS = 80_000;

function buildRecentUserMessagesReference(messages: ChatMessage[]): string {
  const userMessages = messages
    .filter(isRealUserMessage)
    .slice(-RECENT_USER_REFERENCE_TURNS);

  if (userMessages.length === 0) {
    return "";
  }

  const serialized = userMessages
    .map((message, index) => {
      const content = getUserMessageTextForReference(message);
      return `${index + 1}. USER: ${content}`;
    })
    .join("\n\n");

  return `Recent user messages to preserve in the summary as context, not active chat turns:
${serialized}

`;
}

function getUserMessageTextForReference(message: ChatMessage): string {
  const text = (message.parts ?? [])
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "file") {
        return fileHeader(part, "attached file");
      }
      return `[${part.type}]`;
    })
    .join("\n");

  if (text.length <= RECENT_USER_REFERENCE_MAX_CHARS) {
    return text;
  }

  return `${text.slice(0, RECENT_USER_REFERENCE_MAX_CHARS)}\n[truncated ${text.length - RECENT_USER_REFERENCE_MAX_CHARS} characters from recent user message]`;
}

/**
 * Shared transcript entries, except that file parts carry the text extracted
 * for the summarizer (the shared projection only notes an attachment).
 */
async function transcriptEntries(
  message: ChatMessage,
  conversationId: string,
): Promise<TranscriptEntry[]> {
  const perPart = await Promise.all(
    (message.parts ?? []).map(
      async (part): Promise<TranscriptEntry[]> =>
        part.type === "file"
          ? [
              {
                kind: "text",
                role: message.role,
                text: await getFilePartTextForSummary(part, conversationId),
              },
            ]
          : uiMessageTranscriptEntries({ role: message.role, parts: [part] }),
    ),
  );
  return perPart.flat();
}

function getMessageTextForTokenEstimate(message: ChatMessage): {
  text: string;
  extraTokens: number;
} {
  let extraTokens = 0;
  const text = (message.parts ?? [])
    .map((part) => {
      if (part.type === "file") {
        const fileEstimate = getFilePartTextForTokenEstimate(part);
        extraTokens += fileEstimate.extraTokens;
        return fileEstimate.text;
      }
      return getNonFilePartText(part);
    })
    .join("\n");

  return { text, extraTokens };
}

function getNonFilePartText(part: ChatMessagePart): string {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type?.startsWith("tool-")) {
    const output = part.output ?? part.result;
    return `[${part.type} ${part.toolName ?? ""} ${part.state ?? ""}] ${
      output === undefined ? "" : safeJson(output)
    }`;
  }
  return `[${part.type}]`;
}

function getFilePartTextForTokenEstimate(part: ChatMessagePart): {
  text: string;
  extraTokens: number;
} {
  const filename = String(part.filename ?? "");
  const fallbackMediaType = String(part.mediaType ?? "");
  const header = `[file ${filename} ${fallbackMediaType}]`;
  const url = typeof part.url === "string" ? part.url : "";

  // Ref to a chat_attachments row — use the byte size carried on the part
  // (set by extractInlineAttachments) so we don't need a DB hit on the
  // sync token-estimate hot path.
  if (isAttachmentRefUrl(url)) {
    const byteSize =
      typeof part.fileSize === "number" && part.fileSize > 0
        ? part.fileSize
        : 0;
    if (byteSize === 0) {
      return { text: header, extraTokens: 0 };
    }
    const extraTokens = estimateFileTokens({
      mediaType: fallbackMediaType || "application/octet-stream",
      byteLength: byteSize,
    });
    return {
      text: `${header}\n[binary file payload: ${byteSize} bytes]`,
      extraTokens,
    };
  }

  const decoded = decodeDataUrl(url);
  if (!decoded) {
    return { text: header, extraTokens: 0 };
  }

  const mediaType = getFilePartMediaType(part, decoded.mediaType);
  const mediaHeader = `[file ${filename} ${mediaType}]`;
  if (isTextLikeMediaType(mediaType)) {
    return {
      text: `${mediaHeader}\n${decoded.buffer.toString("utf8")}`,
      extraTokens: 0,
    };
  }

  return {
    text: `${mediaHeader}\n[binary file payload: ${decoded.buffer.length} bytes]`,
    extraTokens: estimateFileTokens({
      mediaType,
      byteLength: decoded.buffer.length,
    }),
  };
}

async function getFilePartTextForSummary(
  part: ChatMessagePart,
  conversationId: string,
): Promise<string> {
  const header = fileHeader(part, "attached file");
  const extractedText = await extractFileTextForCompaction(
    part,
    conversationId,
  );

  if (!extractedText) {
    return `${header}\nFile contents were not available to the compaction summarizer. Preserve this limitation in the summary if the file may matter later.`;
  }

  return `${header}\nExtracted file text for compaction:\n${extractedText}`;
}

function fileHeader(part: ChatMessagePart, defaultFilename: string): string {
  const url = typeof part.url === "string" ? part.url : "";
  const mediaType = getFilePartMediaType(part, getDataUrlMediaType(url));
  return `[file ${String(part.filename ?? defaultFilename)} ${mediaType}]`;
}

async function extractFileTextForCompaction(
  part: ChatMessagePart,
  conversationId: string,
): Promise<string | null> {
  const url = typeof part.url === "string" ? part.url : "";

  // Ref to a chat_attachments row — read the pre-extracted text_preview
  // (computed at upload time) instead of decoding + parsing the blob here.
  // The row's conversationId is verified against the request's
  // conversationId to prevent leaking another conversation's file content
  // via a crafted ref (same closure as the materialize-attachments ACL).
  if (isAttachmentRefUrl(url)) {
    const attachmentId = parseAttachmentIdFromUrl(url);
    if (!attachmentId) return null;
    try {
      const row = await ConversationAttachmentModel.findById(attachmentId);
      if (!row) return null;
      if (row.conversationId !== conversationId) return null;
      if (row.textPreviewStatus !== "ok" || !row.textPreview) return null;
      return truncateFileText(row.textPreview);
    } catch (error) {
      logger.warn(
        { error, attachmentId },
        "[ContextCompaction] failed to read text_preview for attachment ref",
      );
      return null;
    }
  }

  const data = decodeDataUrl(url);
  if (!data) {
    return null;
  }

  const mediaType = getFilePartMediaType(part, data.mediaType);
  try {
    if (isTextLikeMediaType(mediaType)) {
      return truncateFileText(data.buffer.toString("utf8"));
    }
    if (mediaType === "application/pdf") {
      const parsed = await loadPdfParser()(data.buffer);
      return truncateFileText(parsed.text);
    }
  } catch (error) {
    logger.warn(
      { error, filename: part.filename, mediaType },
      "[ContextCompaction] failed to extract uploaded file text",
    );
  }

  return null;
}

function truncateFileText(text: string): string {
  const normalized = text.replaceAll(String.fromCharCode(0), "").trim();
  if (normalized.length <= MAX_FILE_TEXT_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_FILE_TEXT_CHARS)}\n\n[truncated ${normalized.length - MAX_FILE_TEXT_CHARS} characters from extracted file text]`;
}

function getFilePartMediaType(
  part: ChatMessagePart,
  decodedMediaType: string,
): string {
  return typeof part.mediaType === "string" && part.mediaType.length > 0
    ? part.mediaType
    : decodedMediaType;
}

function parseDataUrlMeta(raw: string): {
  mediaType: string;
  isBase64: boolean;
} {
  const isBase64 = raw.endsWith(";base64");
  const meta = isBase64 ? raw.slice(0, -";base64".length) : raw;
  const mediaType = meta.split(";", 1)[0] || "application/octet-stream";
  return { mediaType, isBase64 };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
