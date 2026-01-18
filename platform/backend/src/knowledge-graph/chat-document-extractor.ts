import logger from "@/logging";
import {
  MAX_CONCURRENT_INGESTIONS,
  MAX_DOCUMENT_SIZE_BYTES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_EXTENSIONS,
} from "./constants";
import { ingestDocument, isKnowledgeGraphEnabled } from "./index";

/**
 * Message part structure from AI SDK UIMessage
 */
interface MessagePart {
  type: string;
  text?: string;
  /** File URL - can be data URL (base64) or blob URL */
  url?: string;
  /** MIME type of the file */
  mediaType?: string;
  /** Original filename */
  filename?: string;
  /** Some SDKs use 'data' for base64 content */
  data?: string;
  [key: string]: unknown;
}

/**
 * Message structure from AI SDK
 */
interface Message {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  parts?: MessagePart[];
  content?: string | MessagePart[];
}

/**
 * Check if a MIME type is a supported document type
 */
function isSupportedDocumentType(mediaType?: string): boolean {
  if (!mediaType) return false;
  return SUPPORTED_DOCUMENT_TYPES.some(
    (type) => mediaType === type || mediaType.startsWith(`${type};`),
  );
}

/**
 * Check if a filename has a supported extension
 */
function hasSupportedExtension(filename?: string): boolean {
  if (!filename) return false;
  const lowerFilename = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext));
}

/**
 * Estimate decoded size from base64 length
 * Base64 encoding increases size by ~4/3, so decoded ≈ base64Length * 3/4
 */
function estimateDecodedSize(base64Length: number): number {
  return Math.ceil(base64Length * 0.75);
}

/**
 * Check if decoded content contains invalid UTF-8 sequences
 * The Unicode replacement character (U+FFFD) appears when invalid bytes are encountered
 */
function containsInvalidUtf8(content: string): boolean {
  return content.includes("\uFFFD");
}

/**
 * Extract text content from a base64 data URL
 * Returns null if the content exceeds size limits, cannot be decoded, or contains invalid UTF-8
 */
function extractContentFromDataUrl(
  dataUrl: string,
  filename?: string,
): string | null {
  try {
    // Format: data:[<mediatype>][;base64],<data>
    const match = dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
    if (!match) return null;

    const [, , data] = match;
    if (!data) return null;

    // Early size check before decoding to prevent memory spikes
    const estimatedSize = estimateDecodedSize(data.length);
    if (estimatedSize > MAX_DOCUMENT_SIZE_BYTES) {
      logger.warn(
        { estimatedSize },
        "[KnowledgeGraph] Skipping data URL that likely exceeds size limit",
      );
      return null;
    }

    // Decode base64
    const decoded = Buffer.from(data, "base64").toString("utf-8");

    // Validate UTF-8 content - skip files with invalid encoding
    // (likely binary files incorrectly labeled as text)
    if (containsInvalidUtf8(decoded)) {
      logger.warn(
        { filename },
        "[KnowledgeGraph] Skipping file with invalid UTF-8 content",
      );
      return null;
    }

    return decoded;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[KnowledgeGraph] Failed to decode data URL",
    );
    return null;
  }
}

/**
 * Extract document content from a message part
 */
function extractDocumentContent(part: MessagePart): {
  content: string;
  filename: string;
} | null {
  // Check if it's a file part with supported type
  if (part.type !== "file") return null;

  const mediaType = part.mediaType;
  const filename = part.filename;

  // Check if the file type is supported
  const isSupported =
    isSupportedDocumentType(mediaType) || hasSupportedExtension(filename);

  if (!isSupported) {
    logger.debug(
      { mediaType, filename },
      "[KnowledgeGraph] Skipping unsupported file type",
    );
    return null;
  }

  // Try to extract content from data URL
  if (part.url?.startsWith("data:")) {
    const content = extractContentFromDataUrl(part.url, filename);
    if (content) {
      // Check document size limit
      if (Buffer.byteLength(content, "utf-8") > MAX_DOCUMENT_SIZE_BYTES) {
        logger.warn(
          { filename, size: Buffer.byteLength(content, "utf-8") },
          "[KnowledgeGraph] Skipping document that exceeds size limit",
        );
        return null;
      }
      return {
        content,
        filename: filename || "unknown",
      };
    }
  }

  // Try to extract from 'data' field (some SDKs use this)
  if (part.data && typeof part.data === "string") {
    try {
      const content = Buffer.from(part.data, "base64").toString("utf-8");

      // Validate UTF-8 content
      if (containsInvalidUtf8(content)) {
        logger.warn(
          { filename },
          "[KnowledgeGraph] Skipping file with invalid UTF-8 content",
        );
        return null;
      }

      // Check document size limit
      if (Buffer.byteLength(content, "utf-8") > MAX_DOCUMENT_SIZE_BYTES) {
        logger.warn(
          { filename, size: Buffer.byteLength(content, "utf-8") },
          "[KnowledgeGraph] Skipping document that exceeds size limit",
        );
        return null;
      }
      return {
        content,
        filename: filename || "unknown",
      };
    } catch {
      // Not valid base64, might be raw content
      // Validate UTF-8 content
      if (containsInvalidUtf8(part.data)) {
        logger.warn(
          { filename },
          "[KnowledgeGraph] Skipping file with invalid UTF-8 content",
        );
        return null;
      }

      // Check document size limit
      if (Buffer.byteLength(part.data, "utf-8") > MAX_DOCUMENT_SIZE_BYTES) {
        logger.warn(
          { filename, size: Buffer.byteLength(part.data, "utf-8") },
          "[KnowledgeGraph] Skipping document that exceeds size limit",
        );
        return null;
      }
      return {
        content: part.data,
        filename: filename || "unknown",
      };
    }
  }

  logger.debug(
    { filename, hasUrl: !!part.url, hasData: !!part.data },
    "[KnowledgeGraph] Could not extract content from file part",
  );
  return null;
}

/**
 * Extract and ingest documents from chat messages into the knowledge graph
 *
 * This function processes messages sent to the chat endpoint, finds any
 * file attachments that are text-based documents, and ingests them into
 * the configured knowledge graph provider.
 *
 * The ingestion happens asynchronously (fire and forget) to avoid blocking
 * the chat response.
 *
 * @param messages - Array of messages from the chat request
 */
export async function extractAndIngestDocuments(
  messages: unknown[],
): Promise<void> {
  // Check if knowledge graph is enabled
  if (!isKnowledgeGraphEnabled()) {
    return;
  }

  // Cast to Message array
  const typedMessages = messages as Message[];

  // Find user messages (documents are typically attached to user messages)
  const userMessages = typedMessages.filter((msg) => msg.role === "user");

  if (userMessages.length === 0) {
    return;
  }

  // Extract documents from all user messages
  const documentsToIngest: Array<{ content: string; filename: string }> = [];

  for (const message of userMessages) {
    const parts = message.parts || [];

    for (const part of parts) {
      const doc = extractDocumentContent(part as MessagePart);
      if (doc) {
        documentsToIngest.push(doc);
      }
    }

    // Also check 'content' array if parts is empty (some SDKs use this)
    if (parts.length === 0 && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "object" && part !== null) {
          const doc = extractDocumentContent(part as MessagePart);
          if (doc) {
            documentsToIngest.push(doc);
          }
        }
      }
    }
  }

  if (documentsToIngest.length === 0) {
    return;
  }

  logger.info(
    { documentCount: documentsToIngest.length },
    "[KnowledgeGraph] Ingesting documents from chat",
  );

  // Ingest documents asynchronously with concurrency limit
  // This prevents overwhelming the LightRAG service with too many parallel requests
  // Using a Set instead of Array to avoid race conditions when multiple promises
  // complete simultaneously (splice during iteration is unsafe)
  const ingestWithConcurrencyLimit = async () => {
    const inProgress = new Set<Promise<void>>();

    for (const doc of documentsToIngest) {
      const promise: Promise<void> = ingestDocument({
        content: doc.content,
        filename: doc.filename,
      })
        .then(() => {
          // Discard boolean return value, we just need void
        })
        .catch((error) => {
          logger.error(
            {
              filename: doc.filename,
              error: error instanceof Error ? error.message : String(error),
            },
            "[KnowledgeGraph] Background document ingestion failed",
          );
        })
        .finally(() => {
          // Remove completed promise from tracking set
          inProgress.delete(promise);
        });

      inProgress.add(promise);

      // Wait for one to complete if we've hit the concurrency limit
      if (inProgress.size >= MAX_CONCURRENT_INGESTIONS) {
        await Promise.race(inProgress);
      }
    }

    // Wait for remaining ingestions to complete
    await Promise.all(inProgress);
  };

  // Fire and forget - don't block the chat response
  ingestWithConcurrencyLimit().catch((error) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "[KnowledgeGraph] Background document ingestion batch failed",
    );
  });
}
