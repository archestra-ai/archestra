import type { UIMessage } from "@ai-sdk/react";
import type { FileAttachment } from "./editable-user-message";

/**
 * Extract file attachments from message parts.
 * Filters for file parts and maps them to FileAttachment format.
 */
export function extractFileAttachments(
  parts: UIMessage["parts"] | undefined,
): FileAttachment[] | undefined {
  return parts
    ?.filter((p) => p.type === "file")
    .map((p) => {
      const filePart = p as {
        type: "file";
        url: string;
        mediaType: string;
        filename?: string;
      };
      return {
        url: filePart.url,
        mediaType: filePart.mediaType,
        filename: filePart.filename,
      };
    });
}

/**
 * Check if a message has any text parts.
 */
export function hasTextPart(parts: UIMessage["parts"] | undefined): boolean {
  return parts?.some((p) => p.type === "text") ?? false;
}

/**
 * Check if a message is a file-only message (has file parts but no text parts).
 */
export function isFileOnlyMessage(
  parts: UIMessage["parts"] | undefined,
): boolean {
  if (!parts || parts.length === 0) return false;
  const hasFiles = parts.some((p) => p.type === "file");
  const hasText = parts.some((p) => p.type === "text");
  return hasFiles && !hasText;
}
