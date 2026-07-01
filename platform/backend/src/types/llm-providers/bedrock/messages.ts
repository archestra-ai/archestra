import { z } from "zod";

/**
 * Bedrock Converse API message schemas
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */

const RoleSchema = z.enum(["user", "assistant"]);

// =============================================================================
// SOURCE SCHEMAS
// =============================================================================

// S3 location source
const S3LocationSchema = z.object({
  uri: z.string(),
  bucketOwner: z.string().optional(),
});

// Image source (bytes or S3)
const ImageSourceSchema = z.union([
  z.object({ bytes: z.string() }), // Base64 encoded
  z.object({ s3Location: S3LocationSchema }),
]);

// Document source (bytes or S3)
const DocumentSourceSchema = z.union([
  z.object({ bytes: z.string() }), // Base64 encoded
  z.object({ s3Location: S3LocationSchema }),
]);

// =============================================================================
// CONTENT BLOCK SCHEMAS
// =============================================================================

// Text content block
const TextContentBlockSchema = z.object({
  text: z.string(),
});

// Image content block
const ImageContentBlockSchema = z.object({
  image: z.object({
    format: z.enum(["png", "jpeg", "gif", "webp"]),
    source: ImageSourceSchema,
  }),
});

// Document content block
const DocumentContentBlockSchema = z.object({
  document: z.object({
    format: z.enum([
      "pdf",
      "csv",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "html",
      "txt",
      "md",
    ]),
    name: z.string(),
    source: DocumentSourceSchema,
  }),
});

// Guard content block
const GuardContentBlockSchema = z.object({
  guardContent: z.object({
    text: z.object({
      text: z.string(),
      qualifiers: z
        .array(z.enum(["grounding_source", "query", "guard_content"]))
        .optional(),
    }),
  }),
});

// Tool use content block (in assistant messages)
const ToolUseContentBlockSchema = z.object({
  toolUse: z.object({
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
});

// Tool result content item
const ToolResultContentItemSchema = z.union([
  z.object({ text: z.string() }),
  z.object({
    image: z.object({
      format: z.enum(["png", "jpeg", "gif", "webp"]),
      source: ImageSourceSchema,
    }),
  }),
  z.object({ json: z.record(z.string(), z.unknown()) }),
  z.object({
    document: z.object({
      format: z.enum([
        "pdf",
        "csv",
        "doc",
        "docx",
        "xls",
        "xlsx",
        "html",
        "txt",
        "md",
      ]),
      name: z.string(),
      source: DocumentSourceSchema,
    }),
  }),
]);

// Tool result content block (in user messages)
const ToolResultContentBlockSchema = z.object({
  toolResult: z.object({
    toolUseId: z.string(),
    content: z.array(ToolResultContentItemSchema),
    status: z.enum(["success", "error"]).optional(),
  }),
});

// Cache point block — a prompt-caching breakpoint. Bedrock Converse caches the
// content rendered before this block. Emitted by @ai-sdk/amazon-bedrock from
// `providerOptions.bedrock.cachePoint` and inserted into the message content
// array, so the proxy schema must accept it on every message role. `ttl` is
// kept so a pass-through request's cache duration ("5m"/"1h") survives instead
// of being silently dropped; `type` stays a string since AWS validates it.
const CachePointContentBlockSchema = z.object({
  cachePoint: z.object({
    type: z.string(),
    ttl: z.string().optional(),
  }),
});

// Reasoning content block — Claude extended-thinking output. On a multi-turn
// request @ai-sdk/amazon-bedrock echoes the prior assistant reasoning back as a
// `{ reasoningContent: ... }` block in the assistant message content, so the
// proxy must accept it or the whole request 400s with
// "body/messages/N/content/M Invalid input" (the same failure class as the
// system cachePoint block). Two variants per the Bedrock Converse API: plain
// reasoning text with a signature, or redacted reasoning bytes. `signature` is
// optional so a text variant without one still validates and passes through.
const ReasoningContentBlockSchema = z.object({
  reasoningContent: z.union([
    z.object({
      reasoningText: z.object({
        text: z.string(),
        signature: z.string().optional(),
      }),
    }),
    z.object({
      redactedReasoning: z.object({
        data: z.string(),
      }),
    }),
  ]),
});

// =============================================================================
// EXPORTED CONTENT BLOCK UNIONS
// =============================================================================

// Content block union for user messages
export const UserContentBlockSchema = z.union([
  TextContentBlockSchema,
  ImageContentBlockSchema,
  DocumentContentBlockSchema,
  GuardContentBlockSchema,
  ToolResultContentBlockSchema,
  CachePointContentBlockSchema,
]);

// Content block union for assistant messages
export const AssistantContentBlockSchema = z.union([
  TextContentBlockSchema,
  ToolUseContentBlockSchema,
  CachePointContentBlockSchema,
  ReasoningContentBlockSchema,
]);

// Content block union for all messages
export const ContentBlockSchema = z.union([
  TextContentBlockSchema,
  ImageContentBlockSchema,
  DocumentContentBlockSchema,
  GuardContentBlockSchema,
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
  CachePointContentBlockSchema,
  ReasoningContentBlockSchema,
]);

// =============================================================================
// MESSAGE SCHEMA
// =============================================================================

export const MessageSchema = z.object({
  role: RoleSchema,
  content: z.array(ContentBlockSchema),
});

// =============================================================================
// SYSTEM CONTENT
// =============================================================================

// System content block (text or guard content)
// Also accepts Anthropic-style { type: "text", text: string } blocks (e.g. from @ai-sdk/amazon-bedrock)
// and normalizes them to Bedrock format { text: string }
//
// Forward-compat fallback: Bedrock periodically introduces new system block
// shapes and @ai-sdk/amazon-bedrock forwards whatever the caller configures
// (the `cachePoint` block was one such addition — before it was modeled here,
// a Claude request with prompt caching failed with "body/system/1 Invalid
// input"). As a pass-through proxy we must not 400 a request just because a
// block isn't in our allowlist; AWS is the authoritative validator. Any object
// we don't explicitly model is accepted and forwarded to Bedrock unchanged.
// The known shapes stay first so their normalization/typing still applies.
const SystemContentBlockSchema = z.union([
  z
    .object({ type: z.literal("text"), text: z.string() })
    .transform(({ text }) => ({ text })),
  z.object({ text: z.string() }),
  GuardContentBlockSchema,
  CachePointContentBlockSchema,
  z.record(z.string(), z.unknown()),
]);

export const SystemSchema = z.array(SystemContentBlockSchema);

// =============================================================================
// RESPONSE CONTENT BLOCKS
// =============================================================================

const ResponseTextBlockSchema = z.object({
  text: z.string(),
});

const ResponseToolUseBlockSchema = z.object({
  toolUse: z.object({
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
});

export const ResponseContentBlockSchema = z.union([
  ResponseTextBlockSchema,
  ResponseToolUseBlockSchema,
]);
