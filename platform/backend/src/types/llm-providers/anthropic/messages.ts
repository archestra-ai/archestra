import { z } from "zod";

// "system" covers mid-conversation system messages (anthropic-beta:
// mid-conversation-system-2026-04-07), which Claude Code injects into
// `messages` for hook output and similar context — distinct from the
// top-level `system` field.
const RoleSchema = z.enum(["user", "assistant", "system"]);

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
  // Anthropic accepts either an inline base64 source or a URL source it fetches
  // itself. https://platform.claude.com/docs/en/build-with-claude/vision
  source: z.union([
    z.object({
      type: z.enum(["base64"]),
      media_type: z.string(),
      data: z.string(),
    }),
    z.object({
      type: z.enum(["url"]),
      url: z.string(),
    }),
  ]),
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
const ThinkingBlockParamSchema = z.object({
  type: z.enum(["thinking"]),
  thinking: z.string(),
  signature: z.string(),
});

const RedactedThinkingBlockParamSchema = z.object({
  type: z.enum(["redacted_thinking"]),
  data: z.string(),
});

// Server-tool and container blocks are forwarded verbatim and never inspected
// by Archestra, so only the discriminator is validated. Loose parsing keeps
// every other field intact — a plain z.object would strip them before the
// request reaches the upstream API.
const ServerToolBlockParamSchema = z.looseObject({
  type: z.enum([
    "search_result",
    "server_tool_use",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "tool_search_tool_result",
    "container_upload",
  ]),
});

// Forward-compat escape hatch: Anthropic ships new content block types behind
// beta flags faster than this schema is updated (interleaved thinking broke
// Claude Code through the proxy this way). Any other object with a string
// `type` is forwarded verbatim — the upstream API is the authority on
// validity. Cast to `never` so it adds no member to the inferred union and
// type-narrowing in the adapters is unaffected.
const UnknownBlockParamSchema = z.looseObject({
  type: z.string(),
}) as unknown as z.ZodType<never>;

const ContentBlockParamSchema = z.union([
  TextBlockParamSchema,
  ImageBlockParamSchema,
  DocumentBlockParamSchema,
  ThinkingBlockParamSchema,
  RedactedThinkingBlockParamSchema,
  ToolUseBlockParamSchema,
  ToolResultBlockParamSchema,
  ServerToolBlockParamSchema,
  UnknownBlockParamSchema,
]);

export const MessageParamSchema = z.object({
  content: z.union([z.string(), z.array(ContentBlockParamSchema)]),
  role: RoleSchema,
});
