import { z } from "zod";

const RoleSchema = z.enum(["user", "assistant"]);

const TextBlockSchema = z.object({
  citations: z.array(z.any()).nullable(),
  text: z.string(),
  type: z.enum(["text"]),
});

const ThinkingBlockSchema = z.object({
  signature: z.string(),
  thinking: z.string(),
  type: z.enum(["thinking"]),
});

const RedactedThinkingBlockSchema = z.object({
  data: z.string(),
  type: z.enum(["redacted_thinking"]),
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
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
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

// const ImageBlockParamSchema = z.any();
// const DocumentBlockParamSchema = z.any();
// const SearchResultBlockParamSchema = z.any();
// const ThinkingBlockParamSchema = z.any();
// const RedactedThinkingBlockParamSchema = z.any();
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
          // ImageBlockParamSchema,
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
  // ImageBlockParamSchema,
  // DocumentBlockParamSchema,
  // SearchResultBlockParamSchema,
  // ThinkingBlockParamSchema,
  // RedactedThinkingBlockParamSchema,
  ToolUseBlockParamSchema,
  ToolResultBlockParamSchema,
  // ServerToolUseBlockParamSchema,
  // WebSearchToolResultBlockParamSchema,
]);

export const MessageParamSchema = z.object({
  content: z.union([z.string(), z.array(ContentBlockParamSchema)]),
  role: RoleSchema,
});
