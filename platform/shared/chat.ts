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
// Chat Message Part Types
// ============================================================================

export type ChatMessagePart = {
  type: string;
  output?: unknown;
  result?: unknown;
  toolName?: string;
  text?: string;
  toolCallId?: string;
  state?: string;
  source?: unknown;
  // Chat history consumers touch loosely-typed UI message parts coming from the
  // AI SDK and persisted JSON payloads, so this remains permissive until we
  // have a stable discriminated union for all supported part shapes.
  [key: string]: unknown;
};

export type ChatMessage = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  parts?: ChatMessagePart[];
};

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
export type ModalityOption<T extends string> = {
  value: T;
  label: string;
  description: string;
};
export type SupportedChatUploadMimeType =
  | "application/csv"
  | "application/json"
  | "application/octet-stream"
  | "application/pdf"
  | "application/vnd.ms-excel"
  | "application/xml"
  | "audio/flac"
  | "audio/mpeg"
  | "audio/mp3"
  | "audio/ogg"
  | "audio/wav"
  | "audio/webm"
  | "image/gif"
  | "image/bmp"
  | "image/jpeg"
  | "image/png"
  | "image/svg+xml"
  | "image/webp"
  | "image/x-icon"
  | "text/csv"
  | "text/markdown"
  | "text/plain"
  | "video/avi"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm";

// ============================================================================
// File Type Utilities
// ============================================================================

/**
 * Mapping from input modalities to accepted MIME type patterns.
 *
 * Note: "text" modality doesn't typically allow file uploads (text is entered directly).
 * The other modalities map to specific file types that models can process.
 */
const MODALITY_TO_MIME_TYPES: Record<
  ModelInputModality,
  SupportedChatUploadMimeType[] | null
> = {
  // Text-capable models can accept plain text and CSV documents.
  text: [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
  ],
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

const MODALITY_TO_FILE_TYPE_DESCRIPTION: Record<ModelInputModality, string> = {
  text: "chat prompts, .txt, .csv, and .md uploads",
  image: "images",
  audio: "audio",
  video: "video",
  pdf: "PDFs",
};

type FileLikeWithMediaType = {
  name: string;
  type: string;
};

const INPUT_MODALITY_OPTION_MAP: Record<
  ModelInputModality,
  ModalityOption<ModelInputModality>
> = {
  text: {
    value: "text",
    label: "Text",
    description: "Chat prompts, .txt, .csv, and .md uploads",
  },
  image: {
    value: "image",
    label: "Image",
    description: "Image file uploads",
  },
  audio: {
    value: "audio",
    label: "Audio",
    description: "Audio file uploads",
  },
  video: {
    value: "video",
    label: "Video",
    description: "Video file uploads",
  },
  pdf: {
    value: "pdf",
    label: "PDF",
    description: "PDF file uploads",
  },
};

const OUTPUT_MODALITY_OPTION_MAP: Record<
  ModelOutputModality,
  ModalityOption<ModelOutputModality>
> = {
  text: {
    value: "text",
    label: "Text",
    description: "Standard text responses",
  },
  image: {
    value: "image",
    label: "Image",
    description: "Generated image responses",
  },
  audio: {
    value: "audio",
    label: "Audio",
    description: "Generated audio responses",
  },
};

export const INPUT_MODALITY_OPTIONS = Object.values(INPUT_MODALITY_OPTION_MAP);
export const OUTPUT_MODALITY_OPTIONS = Object.values(
  OUTPUT_MODALITY_OPTION_MAP,
);

/**
 * Get MIME type from a file-like object, with fallback to extension-based
 * detection for browsers/environments that leave `type` blank.
 */
export function getMediaType(file: FileLikeWithMediaType): string {
  if (file.type) {
    return file.type;
  }

  const lastDotIndex = file.name.lastIndexOf(".");
  const ext =
    lastDotIndex > 0 && lastDotIndex < file.name.length - 1
      ? file.name.slice(lastDotIndex + 1).toLowerCase()
      : undefined;

  const extensionMap: Record<string, SupportedChatUploadMimeType> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/avi",
    pdf: "application/pdf",
    csv: "text/csv",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    xml: "application/xml",
  };

  return ext
    ? extensionMap[ext] || "application/octet-stream"
    : "application/octet-stream";
}

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
 * // Returns: "text/plain,text/csv"
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

  const mimeTypes = new Set<SupportedChatUploadMimeType>();

  for (const modality of modalities) {
    const types = MODALITY_TO_MIME_TYPES[modality];
    if (types) {
      for (const type of types) {
        mimeTypes.add(type);
      }
    }
  }

  // If no MIME types were collected, return undefined.
  if (mimeTypes.size === 0) {
    return undefined;
  }

  return [...mimeTypes].join(",");
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

  const supportedTypes = modalities
    .filter((modality) => {
      const types = MODALITY_TO_MIME_TYPES[modality];
      return types !== null && types.length > 0;
    })
    .map((modality) => MODALITY_TO_FILE_TYPE_DESCRIPTION[modality]);

  if (supportedTypes.length === 0) {
    return null;
  }

  return supportedTypes.join(", ");
}
