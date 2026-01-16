import logger from "@/logging";
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
 * Supported document MIME types for knowledge graph ingestion
 * These are text-based formats that can be meaningfully indexed
 */
const SUPPORTED_DOCUMENT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json",
  "text/csv",
  "text/xml",
  "application/xml",
  "text/html",
  "text/yaml",
  "application/x-yaml",
  // Common code files
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "text/x-python",
  "text/x-java",
  "text/x-c",
  "text/x-cpp",
];

/**
 * File extensions that map to supported document types
 * Used as fallback when MIME type is generic or missing
 */
const SUPPORTED_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".xml",
  ".html",
  ".htm",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rs",
  ".go",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".sql",
  ".graphql",
  ".css",
  ".scss",
  ".less",
];

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
 * Extract text content from a base64 data URL
 */
function extractContentFromDataUrl(dataUrl: string): string | null {
  try {
    // Format: data:[<mediatype>][;base64],<data>
    const match = dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
    if (!match) return null;

    const [, , data] = match;
    if (!data) return null;

    // Decode base64
    const decoded = Buffer.from(data, "base64").toString("utf-8");
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
    const content = extractContentFromDataUrl(part.url);
    if (content) {
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
      return {
        content,
        filename: filename || "unknown",
      };
    } catch {
      // Not valid base64, might be raw content
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

  // Ingest documents asynchronously (fire and forget)
  // We don't await these to avoid blocking the chat response
  for (const doc of documentsToIngest) {
    ingestDocument({
      content: doc.content,
      filename: doc.filename,
    }).catch((error) => {
      logger.error(
        {
          filename: doc.filename,
          error: error instanceof Error ? error.message : String(error),
        },
        "[KnowledgeGraph] Background document ingestion failed",
      );
    });
  }
}
