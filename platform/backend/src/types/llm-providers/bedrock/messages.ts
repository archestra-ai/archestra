import { z } from "zod";

/**
 * Bedrock Converse API message schemas
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */

const RoleSchema = z.enum(["user", "assistant"]);

// Text content block
const TextContentBlockSchema = z.object({
  text: z.string(),
});

// Image content block
const ImageContentBlockSchema = z.object({
  image: z.object({
    format: z.enum(["png", "jpeg", "gif", "webp"]),
    source: z.object({
      bytes: z.string(), // Base64 encoded
    }),
  }),
});

// Document content block (for PDFs, etc.)
const DocumentContentBlockSchema = z.object({
  document: z.object({
    format: z.enum(["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"]),
    name: z.string(),
    source: z.object({
      bytes: z.string(), // Base64 encoded
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

// Tool result content block (in user messages)
const ToolResultContentBlockSchema = z.object({
  toolResult: z.object({
    toolUseId: z.string(),
    content: z.array(
      z.union([
        z.object({ text: z.string() }),
        z.object({
          image: z.object({
            format: z.enum(["png", "jpeg", "gif", "webp"]),
            source: z.object({
              bytes: z.string(),
            }),
          }),
        }),
        z.object({ json: z.record(z.string(), z.unknown()) }),
        z.object({
          document: z.object({
            format: z.enum(["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"]),
            name: z.string(),
            source: z.object({
              bytes: z.string(),
            }),
          }),
        }),
      ]),
    ),
    status: z.enum(["success", "error"]).optional(),
  }),
});

// Content block union for user messages
export const UserContentBlockSchema = z.union([
  TextContentBlockSchema,
  ImageContentBlockSchema,
  DocumentContentBlockSchema,
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
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
]);

// Message schema
export const MessageSchema = z.object({
  role: RoleSchema,
  content: z.array(ContentBlockSchema),
});

// System content block (can be text or guard content)
const SystemContentBlockSchema = z.union([
  z.object({ text: z.string() }),
  z.object({
    guardContent: z.object({
      text: z.object({
        text: z.string(),
        qualifiers: z.array(z.enum(["grounding_source", "query", "guard_content"])).optional(),
      }),
    }),
  }),
]);

export const SystemSchema = z.array(SystemContentBlockSchema);

// Response content blocks
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
