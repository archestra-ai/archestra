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
  /** Input tokens served from the provider's prompt cache, a subset of inputTokens. */
  cacheReadTokens?: number;
}

/**
 * Estimated context-window occupancy streamed at the start of a turn, on the
 * same token yardstick that drives auto-compaction. Seeds the context
 * indicator before the model responds; per-step `TokenUsage` then refines it
 * with the provider's actual prompt size.
 */
export interface ContextWindowEstimate {
  estimatedTokens: number;
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
  metadata?: unknown;
};

/**
 * Type of the inline hook-run debug part. A `data-*` part: persisted and
 * rendered in the chat thread, but dropped from the model conversion
 * (`convertToModelMessages`), so the LLM never sees it — same class as
 * `data-tool-ui-start`. Shared so the backend (emit) and frontend (render)
 * agree on the wire string.
 */
export const HOOK_RUN_PART_TYPE = "data-hook-run";

// Control/telemetry parts the chat UI skips and providers never see. An
// assistant turn left with only these (e.g. a `step-start` after a dangling
// tool call is stripped) renders nothing, so it must not count as content.
// `data-tool-ui-start` is deliberately absent — the UI renders it as an MCP app.
const NON_RENDERABLE_ASSISTANT_PART_TYPES: ReadonlySet<string> = new Set([
  "step-start",
  "data-token-usage",
  "data-heartbeat",
  "data-context-window-estimate",
  "data-context-compaction-start",
  "data-context-compaction-finish",
]);

/**
 * True when an assistant message still carries something the chat UI can
 * render: a non-empty text part, or any non-text part that is not a known
 * non-renderable control/telemetry marker (so completed tool results,
 * reasoning, files, MCP-app parts all count). An assistant turn left with no
 * parts — or only empty text / control parts — after normalization is not
 * renderable and must not be persisted or shown. Fails safe toward keeping:
 * an unrecognized part type counts as content. Structurally typed so both
 * backend `ChatMessagePart`s and the frontend's AI SDK `UIMessage` parts
 * satisfy it.
 */
export function hasRenderableAssistantContent(message: {
  parts?: ReadonlyArray<{ type: string; text?: unknown }>;
}): boolean {
  return (message.parts ?? []).some((part) => {
    if (part.type === "text") {
      return Boolean(part.text);
    }

    return !NON_RENDERABLE_ASSISTANT_PART_TYPES.has(part.type);
  });
}

// Tool states that survive normalization and render durably: a result, an
// error, a denial, or an approval prompt/answer. A tool part in any of these
// is real assistant content. Excludes `input-streaming`/`input-available` and
// bare `tool-call` parts — those are pending/dangling and get stripped before
// persistence.
const TERMINAL_TOOL_PART_STATES: ReadonlySet<string> = new Set([
  "output-available",
  "output-error",
  "output-denied",
  "approval-requested",
  "approval-responded",
]);

type AssistantContentPart = {
  type: string;
  text?: unknown;
  state?: unknown;
  toolCallId?: unknown;
  data?: unknown;
};

/**
 * Strict counterpart to {@link hasRenderableAssistantContent} for the persist
 * and read paths. Unlike the UI predicate (which keeps any unknown non-text
 * part so live streaming never blanks out), this fails safe toward *dropping*:
 * an assistant message is persistable only when it carries content that still
 * renders after a reload — non-empty text, reasoning, a file/image/source, a terminal
 * tool part, or a `data-tool-ui-start` MCP-app marker paired with a terminal
 * tool part in the same message. Everything else (no parts, `parts: []`,
 * `content: ""`, whitespace-only text, only `step-start`/telemetry `data-*`, or
 * an unpaired marker) is an empty bubble and must not be stored or shown.
 * Structurally typed so backend `ChatMessagePart`s and the frontend's AI SDK
 * `UIMessage` parts both satisfy it.
 */
export function hasPersistableAssistantContent(message: {
  parts?: ReadonlyArray<AssistantContentPart>;
}): boolean {
  const parts = message.parts;
  // read-path callers pass historical JSON that is only cast, so reject any
  // shape that is not an array of `type`-tagged parts before inspecting it.
  if (!Array.isArray(parts) || parts.length === 0) {
    return false;
  }

  const terminalToolCallIds = new Set<string>();
  for (const part of parts) {
    if (isTerminalToolPart(part) && typeof part.toolCallId === "string") {
      terminalToolCallIds.add(part.toolCallId);
    }
  }

  return parts.some((part) => {
    if (typeof part?.type !== "string") {
      return false;
    }

    if (part.type === "text" || part.type === "reasoning") {
      return typeof part.text === "string" && part.text.trim().length > 0;
    }

    // `image` covers model-generated images (e.g. Gemini image generation),
    // which the image-stripping normalizer deliberately preserves on assistant
    // turns for multi-turn image editing.
    if (
      part.type === "file" ||
      part.type === "image" ||
      part.type.startsWith("source")
    ) {
      return true;
    }

    // a hook-run debug chip is standalone renderable content; unlike a
    // `data-tool-ui-start` marker it needs no pairing, so a turn carrying only
    // hook entries is still persistable rather than dropped as an empty bubble.
    if (part.type === HOOK_RUN_PART_TYPE) {
      return true;
    }

    if (isTerminalToolPart(part)) {
      return true;
    }

    // an MCP-app marker only counts when its tool call actually resolved —
    // an orphaned marker reloads as a perpetually running tool, i.e. an empty
    // bubble.
    if (part.type.startsWith("data-tool-ui-start")) {
      const toolCallId =
        typeof part.data === "object" &&
        part.data !== null &&
        "toolCallId" in part.data
          ? (part.data as { toolCallId?: unknown }).toolCallId
          : undefined;
      return (
        typeof toolCallId === "string" && terminalToolCallIds.has(toolCallId)
      );
    }

    return false;
  });
}

function isTerminalToolPart(part: AssistantContentPart): boolean {
  if (typeof part?.type !== "string") {
    return false;
  }
  if (part.type === "tool-result") {
    return true;
  }
  const isToolPart =
    part.type.startsWith("tool-") || part.type === "dynamic-tool";
  return (
    isToolPart &&
    typeof part.state === "string" &&
    TERMINAL_TOOL_PART_STATES.has(part.state)
  );
}

/**
 * The skill a user explicitly invoked via slash command, carried on the user
 * message's metadata. The backend uses it to inject the skill's activation
 * block; the chat UI uses it to badge the message.
 */
export const ChatSkillMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type ChatSkillMetadata = z.infer<typeof ChatSkillMetadataSchema>;

/** Chat message metadata. Permissive — only the keys we own are typed. */
export const ChatMessageMetadataSchema = z
  .object({ skill: ChatSkillMetadataSchema.optional() })
  .passthrough();

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
  // Text-capable models can accept plain text, CSV, and JSON documents.
  text: [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
    "application/json",
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
  text: "chat prompts, .txt, .csv, .md, and .json uploads",
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
