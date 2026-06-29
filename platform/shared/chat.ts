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

/**
 * Stream event name for the per-category context window breakdown payload.
 * Used by both the backend emitter and frontend consumer — never use the raw
 * string literal in either place.
 */
export const CONTEXT_WINDOW_BREAKDOWN_EVENT =
  "data-context-window-breakdown" as const;

/**
 * Canonical display order of context window categories, matching the
 * top-to-bottom stack in the assembled request:
 *   system_prompt → tools → messages → tool_results → files
 *
 * The visualizer renders segments in this order; the estimator must produce
 * segments in this order so the stacked bar reads correctly.
 */
export const CONTEXT_WINDOW_CATEGORIES = [
  "system_prompt",
  "tools",
  "messages",
  "tool_results",
  "files",
] as const;

export type ContextWindowCategory = (typeof CONTEXT_WINDOW_CATEGORIES)[number];

/**
 * A single named contributor within a category (one tool definition, one
 * conversation turn, one tool-result block, one attached file).
 * Powers the drill-down list inside each gauge.
 */
export const ContextWindowItemSchema = z.object({
  /** Human-readable name of the contributor (tool name, file name, etc.). */
  label: z.string(),
  /** Estimated token count for this contributor. Always ≥ 0. */
  tokens: z.number().int().nonnegative(),
});

export type ContextWindowItem = z.infer<typeof ContextWindowItemSchema>;

/**
 * One category's share of the assembled request.
 * Only non-empty categories are included in `ContextWindowBreakdown.segments`.
 */
export const ContextWindowSegmentSchema = z.object({
  /** Which part of the request this segment represents. */
  category: z.enum(CONTEXT_WINDOW_CATEGORIES),
  /** Estimated tokens this category contributes to the request. Always ≥ 0. */
  tokens: z.number().int().nonnegative(),
  /**
   * Largest individual contributors in this category, sorted descending by
   * token count. Omitted when no per-item breakdown is available.
   */
  items: z.array(ContextWindowItemSchema).optional(),
});

export type ContextWindowSegment = z.infer<typeof ContextWindowSegmentSchema>;

/**
 * Per-category breakdown of the request about to be sent, streamed once per
 * turn at assembly time (event: `CONTEXT_WINDOW_BREAKDOWN_EVENT`).
 *
 * Token counts are estimates on the same yardstick that drives auto-compaction
 * (chars/token, PDF bytes/token). The provider's exact prompt size arrives
 * afterward via `TokenUsage` and supersedes `usedTokens` for the indicator.
 *
 * Invariant: `usedTokens === sum(segments[*].tokens)`.
 */
export const ContextWindowBreakdownSchema = z.object({
  /** LLM provider identifier (e.g. `"anthropic"`, `"openai"`). */
  provider: z.string(),
  /** Model ID as sent to the provider (e.g. `"claude-sonnet-4-6"`). */
  model: z.string(),
  /**
   * Provider's advertised maximum context length in tokens, or `null` when the
   * model's context length is not known. When `null`, `freeTokens` and
   * `usedPercent` are also `null` and the bar renders relative proportions only.
   */
  contextLength: z.number().int().positive().nullable(),
  /**
   * Sum of all segment token estimates. Always ≥ 0.
   * Must equal `sum(segments[*].tokens)`.
   */
  usedTokens: z.number().int().nonnegative(),
  /**
   * `contextLength - usedTokens`, or `null` when `contextLength` is `null`.
   * May be negative when the assembled request exceeds the model's limit.
   */
  freeTokens: z.number().int().nullable(),
  /**
   * Percentage of the context window occupied (0–100, inclusive), or `null`
   * when `contextLength` is `null`. Clamped to [0, 100] — values > 100 mean
   * the request is over-limit but are displayed as 100 to avoid breaking the
   * progress bar.
   */
  usedPercent: z.number().min(0).max(100).nullable(),
  /**
   * Estimated USD cost of sending this context once (input tokens only), or
   * `null` when no input price is configured for the model. The cost row in the
   * UI is hidden when this is `null`.
   */
  estimatedInputCostUsd: z.number().nonnegative().nullable(),
  /**
   * Non-empty segments in canonical stack order (`CONTEXT_WINDOW_CATEGORIES`).
   * Categories with zero tokens are omitted.
   */
  segments: z.array(ContextWindowSegmentSchema),
});

export type ContextWindowBreakdown = z.infer<
  typeof ContextWindowBreakdownSchema
>;

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
  "data-context-window-breakdown",
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

/**
 * Render-loop diagnostics from owned MCP App renders, attached once by the
 * chat UI to the next outgoing user message. Collected inside an untrusted
 * sandboxed iframe — the backend re-validates and frames them as data, never
 * as instructions, when injecting into the prompt.
 */
export const ChatAppDiagnosticsMetadataSchema = z
  .array(
    z.object({
      appId: z.string().uuid(),
      version: z.number().nullable(),
      entries: z
        .array(
          z.object({
            type: z.string().max(32),
            message: z.string().max(1000),
          }),
        )
        .max(50),
    }),
  )
  .max(10);

export type ChatAppDiagnosticsMetadata = z.infer<
  typeof ChatAppDiagnosticsMetadataSchema
>;

/** Chat message metadata. Permissive — only the keys we own are typed. */
export const ChatMessageMetadataSchema = z
  .object({
    skill: ChatSkillMetadataSchema.optional(),
    appDiagnostics: ChatAppDiagnosticsMetadataSchema.optional(),
  })
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
  | "application/toml"
  | "application/vnd.ms-excel"
  | "application/x-yaml"
  | "application/yaml"
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
  | "text/tab-separated-values"
  | "text/x-toml"
  | "text/xml"
  | "text/yaml"
  | "video/avi"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm";

// ============================================================================
// File Type Utilities
// ============================================================================

/**
 * Source of truth for inlineable text document MIME types. A text file of one of
 * these types that is small enough (see {@link INLINE_TEXT_MAX_BYTES}) is embedded
 * directly into the prompt as decoded text. The same list gates which non-image
 * uploads the composer accepts and which file parts the provider-prep path inlines,
 * so it must stay the single definition shared across frontend and backend.
 */
const INLINEABLE_TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "text/xml",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "text/yaml",
  "application/toml",
  "text/x-toml",
  // Legacy CSV aliases some browsers and operating systems report.
  "application/csv",
  "application/vnd.ms-excel",
] as const satisfies readonly SupportedChatUploadMimeType[];

const INLINEABLE_TEXT_MIME_TYPE_SET: ReadonlySet<string> = new Set(
  INLINEABLE_TEXT_MIME_TYPES,
);

/**
 * Whether a MIME type is an inlineable text document — embeddable in the prompt as
 * decoded text on any provider, rather than handed off as a binary attachment.
 */
export function isInlineableTextMimeType(mimeType: string): boolean {
  return INLINEABLE_TEXT_MIME_TYPE_SET.has(mimeType);
}

/**
 * Upper size bound for embedding a text document directly into the prompt. Larger
 * text files are routed to the sandbox when available, otherwise rejected at ingest.
 */
export const INLINE_TEXT_MAX_BYTES = 256 * 1024;

/**
 * Why an upload is not acceptable, or `null` when it is. Single source of truth
 * for the attachment policy shared by the backend ingest gate (authoritative)
 * and the frontend composer (mirrors it for UX). A file is acceptable when the
 * model can ingest its type, OR it is a small inlineable text document, OR a
 * sandbox is available to stage it within the sandbox artifact size limit.
 */
export type ChatUploadRejectionReason =
  | "text_too_large"
  | "too_large_for_sandbox"
  | "unsupported_type";

export function chatUploadRejectionReason(params: {
  mimeType: string;
  byteLength: number;
  ingestibleMimeTypes: Set<string>;
  sandboxAvailable: boolean;
  sandboxByteLimit: number;
}): ChatUploadRejectionReason | null {
  const {
    mimeType,
    byteLength,
    ingestibleMimeTypes,
    sandboxAvailable,
    sandboxByteLimit,
  } = params;

  const fitsSandbox = sandboxAvailable && byteLength <= sandboxByteLimit;

  // Inlineable text is size-gated even though a text-capable model lists these
  // MIMEs as readable: a large text file would otherwise blow the context
  // window. Checked before the generic ingestible short-circuit for that reason.
  if (isInlineableTextMimeType(mimeType)) {
    if (byteLength <= INLINE_TEXT_MAX_BYTES || fitsSandbox) return null;
    return sandboxAvailable ? "too_large_for_sandbox" : "text_too_large";
  }

  // Non-text types the model can ingest natively (images, PDFs, …) carry no
  // inline-text budget; the request body limit is the only size bound.
  if (ingestibleMimeTypes.has(mimeType)) return null;

  if (fitsSandbox) return null;
  return sandboxAvailable ? "too_large_for_sandbox" : "unsupported_type";
}

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
  // Text-capable models accept the inlineable text document types.
  text: [...INLINEABLE_TEXT_MIME_TYPES],
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
  text: "chat prompts and text files (.txt, .md, .csv, .tsv, .json, .xml, .yaml, .toml)",
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
    tsv: "text/tab-separated-values",
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/x-yaml",
    yml: "application/x-yaml",
    toml: "application/toml",
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
 * The MIME types a model can ingest directly, derived from its input
 * modalities. Unlike {@link getAcceptedFileTypes} (a comma-joined string for the
 * HTML `accept` attribute), this returns a Set for membership checks on the
 * provider-prep path: a file part whose mediaType is absent is not sent as a
 * document the provider would reject — it is referenced as a sandbox file
 * instead. Pass `undefined`/`null` modalities to fall back to a safe readable
 * default (text + images + PDF).
 */
export function getModelReadableMimeTypes(
  modalities: ModelInputModality[] | null | undefined,
): Set<string> {
  // Treat an empty array the same as null — "capabilities unknown" — matching
  // getAcceptedFileTypes / supportsFileUploads rather than "reads nothing".
  const source =
    modalities && modalities.length > 0
      ? modalities
      : DEFAULT_READABLE_MODALITIES;
  const mimeTypes = new Set<string>();
  for (const modality of source) {
    const types = MODALITY_TO_MIME_TYPES[modality];
    if (types) {
      for (const type of types) {
        mimeTypes.add(type);
      }
    }
  }
  return mimeTypes;
}

const DEFAULT_READABLE_MODALITIES: ModelInputModality[] = [
  "text",
  "image",
  "pdf",
];

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
