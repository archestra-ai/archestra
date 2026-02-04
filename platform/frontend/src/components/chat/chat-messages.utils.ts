import type { UIMessage } from "@ai-sdk/react";
import type { FileAttachment } from "./editable-user-message";
import type { McpUIMetadata } from "./mcp-ui-renderer";

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
 * Helper to extract MCP UI metadata from tool output.
 * Handles both object and JSON string inputs.
 */
export function tryToExtractMcpUiMetadata(output: unknown): McpUIMetadata | undefined {
  try {
    let data = output;
    // If output is a string, try to parse it as JSON
    if (typeof output === "string") {
      try {
        data = JSON.parse(output);
      } catch {
        return undefined; // Not JSON
      }
    }

    if (
      data &&
      typeof data === "object" &&
      "uiMetadata" in data &&
      typeof (data as any).uiMetadata === "object"
    ) {
      return data as McpUIMetadata;
    }
  } catch (err) {
    console.error("Error extracting MCP UI metadata", err);
  }
  return undefined;
}
