import { z } from "zod";

const RoleSchema = z.enum(["user", "assistant"]);

const TextBlockSchema = z.object({
  citations: z.array(z.any()).nullable(),
  text: z.string(),
  type: z.enum(["text"]),
});

const ToolUseBlockSchema = z.object({
  id: z.string(),
  input: z.any(),
  name: z.string(),
  type: z.enum(["tool_use"]),
});

const ServerToolUseBlockSchema = z.any();
const WebSearchToolResultBlockSchema = z.any();

export const MessageContentBlockSchema = z.union([
  TextBlockSchema,
  ToolUseBlockSchema,
  ServerToolUseBlockSchema,
  WebSearchToolResultBlockSchema,
]);

const TextBlockParamSchema = z.object({
  text: z.string(),
  type: z.enum(["text"]),
  cache_control: z.any().nullable().optional(),
  citations: z.array(z.any()).nullable().optional(),
});

const ImageBlockParamSchema = z.object({
  type: z.enum(["image"]),
  source: z.object({
    type: z.enum(["base64"]),
    media_type: z.string(),
    data: z.string(),
  }),
  cache_control: z.any().nullable().optional(),
});

const ContentBlockSourceSchema = z.object({
  type: z.enum(["content"]),
  content: z.union([
    z.string(),
    z.array(z.union([TextBlockParamSchema, ImageBlockParamSchema])),
  ]),
});

const DocumentBlockParamSchema = z
  .object({
    type: z.enum(["document"]),
    source: z.union([
      z.object({
        type: z.enum(["base64"]),
        media_type: z.enum(["application/pdf"]),
        data: z.string(),
      }),
      z.object({
        type: z.enum(["text"]),
        media_type: z.enum(["text/plain"]),
        data: z.string(),
      }),
      z.object({
        type: z.enum(["url"]),
        url: z.string().url(),
      }),
      ContentBlockSourceSchema,
    ]),
    title: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    citations: z
      .object({
        enabled: z.boolean(),
      })
      .nullable()
      .optional(),
    cache_control: z.any().nullable().optional(),
  })
  .describe(
    'Anthropic Messages API request `DocumentBlockParam`. This models a user `content` item with `type: "document"` and supports the source union exposed by Anthropic: `Base64PDFSource | PlainTextSource | ContentBlockSource | URLPDFSource`. API reference: https://platform.claude.com/docs/en/api/messages#document_block_param',
  );

// const SearchResultBlockParamSchema = z.any();
const ToolUseBlockParamSchema = z.object({
  id: z.string(),
  input: z.any(),
  name: z.string(),
  type: z.enum(["tool_use"]),
  cache_control: z.any().nullable().optional(),
});
const ToolResultBlockParamSchema = z.object({
  tool_use_id: z.string(),
  type: z.enum(["tool_result"]),
  cache_control: z.any().nullable().optional(),
  content: z
    .union([
      z.string(),
      z.array(
        z.union([
          TextBlockParamSchema,
          ImageBlockParamSchema,
          DocumentBlockParamSchema,
          // SearchResultBlockParamSchema,
        ]),
      ),
    ])
    .optional(),
  is_error: z.boolean().optional(),
});
// const ServerToolUseBlockParamSchema = z.any();
// const WebSearchToolResultBlockParamSchema = z.any();

const ContentBlockParamSchema = z.union([
  TextBlockParamSchema,
  ImageBlockParamSchema,
  DocumentBlockParamSchema,
  // SearchResultBlockParamSchema,
  ToolUseBlockParamSchema,
  ToolResultBlockParamSchema,
  // ServerToolUseBlockParamSchema,
  // WebSearchToolResultBlockParamSchema,
]);

export const MessageParamSchema = z.object({
  content: z.union([z.string(), z.array(ContentBlockParamSchema)]),
  role: RoleSchema,
});
