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
// const DocumentBlockParamSchema = z.any();
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
          // SearchResultBlockParamSchema,
          // DocumentBlockParamSchema,
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
  // DocumentBlockParamSchema,
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
