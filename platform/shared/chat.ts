import { z } from "zod";

// ============================================================================
// Token Usage Types
// ============================================================================

/**
 * Token usage data streamed from the backend after LLM response completes.
 * Used by the chat UI to display actual token counts.
 */
export interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

// ============================================================================
// Zod Schemas for Model Modalities
// ============================================================================

/**
 * Zod schema for input modalities.
 * Based on models.dev input modality types.
 */
export const ModelInputModalitySchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "pdf",
]);

/**
 * Zod schema for output modalities.
 */
export const ModelOutputModalitySchema = z.enum(["text", "image", "audio"]);

// ============================================================================
// TypeScript Types
// ============================================================================

export type ModelInputModality = z.infer<typeof ModelInputModalitySchema>;
export type ModelOutputModality = z.infer<typeof ModelOutputModalitySchema>;

// ============================================================================
// File Type Utilities
// ============================================================================

/**
 * Mapping from input modalities to accepted MIME type patterns.
 *
 * Note: "text" modality doesn't typically allow file uploads (text is entered directly).
 * The other modalities map to specific file types that models can process.
 */
const MODALITY_TO_MIME_TYPES: Record<ModelInputModality, string[] | null> = {
  // Text doesn't enable file uploads - text is entered directly
  text: null,
  // Image formats commonly supported by vision models
  image: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ],
  // Audio formats for speech-to-text and audio models
  audio: [
    "audio/mpeg",
    "audio/wav",
    "audio/mp3",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
  ],
  // Video formats for multimodal models
  video: ["video/mp4", "video/webm", "video/quicktime", "video/avi"],
  // PDF documents for document understanding models
  pdf: ["application/pdf"],
};

/**
 * Converts an array of input modalities to a comma-separated string of MIME types
 * suitable for use with the HTML input accept attribute.
 *
 * @param modalities - Array of input modalities from model capabilities
 * @returns Comma-separated MIME types string, or undefined if no file uploads are supported
 *
 * @example
 * // Model that supports images and PDFs
 * getAcceptedFileTypes(["text", "image", "pdf"])
 * // Returns: "image/jpeg,image/png,image/gif,image/webp,image/svg+xml,application/pdf"
 *
 * @example
 * // Model that only supports text
 * getAcceptedFileTypes(["text"])
 * // Returns: undefined (no file uploads)
 *
 * @example
 * // Model with full multimodal support
 * getAcceptedFileTypes(["text", "image", "audio", "video", "pdf"])
 * // Returns all supported MIME types
 */
export function getAcceptedFileTypes(
  modalities: ModelInputModality[] | null | undefined,
): string | undefined {
  if (!modalities || modalities.length === 0) {
    return undefined;
  }

  const mimeTypes: string[] = [];

  for (const modality of modalities) {
    const types = MODALITY_TO_MIME_TYPES[modality];
    if (types) {
      mimeTypes.push(...types);
    }
  }

  // If no MIME types were collected (e.g., only "text" modality), return undefined
  if (mimeTypes.length === 0) {
    return undefined;
  }

  // Remove duplicates and join
  return [...new Set(mimeTypes)].join(",");
}

/**
 * Checks if a model supports any file uploads based on its input modalities.
 *
 * @param modalities - Array of input modalities from model capabilities
 * @returns true if the model supports at least one file type, false otherwise
 */
export function supportsFileUploads(
  modalities: ModelInputModality[] | null | undefined,
): boolean {
  if (!modalities || modalities.length === 0) {
    return false;
  }

  // Check if any modality enables file uploads
  return modalities.some((modality) => {
    const types = MODALITY_TO_MIME_TYPES[modality];
    return types !== null && types.length > 0;
  });
}

/**
 * Gets a human-readable description of supported file types for display.
 *
 * @param modalities - Array of input modalities from model capabilities
 * @returns Description string or null if no file types are supported
 */
export function getSupportedFileTypesDescription(
  modalities: ModelInputModality[] | null | undefined,
): string | null {
  if (!modalities || modalities.length === 0) {
    return null;
  }

  const supportedTypes: string[] = [];

  if (modalities.includes("image")) {
    supportedTypes.push("images");
  }
  if (modalities.includes("pdf")) {
    supportedTypes.push("PDFs");
  }
  if (modalities.includes("audio")) {
    supportedTypes.push("audio");
  }
  if (modalities.includes("video")) {
    supportedTypes.push("video");
  }

  if (supportedTypes.length === 0) {
    return null;
  }

  return supportedTypes.join(", ");
}
