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
]);

// Content block union for assistant messages
export const AssistantContentBlockSchema = z.union([
  TextContentBlockSchema,
  ToolUseContentBlockSchema,
]);

// Content block union for all messages
export const ContentBlockSchema = z.union([
  TextContentBlockSchema,
  ImageContentBlockSchema,
  DocumentContentBlockSchema,
  GuardContentBlockSchema,
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
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
const SystemContentBlockSchema = z.union([
  z.object({ text: z.string() }),
  GuardContentBlockSchema,
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
