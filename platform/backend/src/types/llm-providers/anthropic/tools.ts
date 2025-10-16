import { z } from "zod";

const InputSchemaJsonSchemaSchema = z.record(z.string(), z.unknown());

export const CustomToolSchema = z.object({
  name: z.string(),
  type: z.enum(["custom"]).nullable().optional(),
  cache_control: z.any().nullable().optional(),
  input_schema: InputSchemaJsonSchemaSchema,
  description: z.string().optional(),
});

const ToolBash20250124Schema = z.object({
  name: z.enum(["bash"]),
  type: z.enum(["bash_20250124"]),
  cache_control: z.any().nullable().optional(),
});
const ToolTextEditor20250124Schema = z.object({
  name: z.enum(["str_replace_editor"]),
  type: z.enum(["text_editor_20250124"]),
  cache_control: z.any().nullable().optional(),
});
const ToolTextEditor20250429Schema = z.object({
  name: z.enum(["str_replace_based_edit_tool"]),
  type: z.enum(["text_editor_20250429"]),
  cache_control: z.any().nullable().optional(),
});
const ToolTextEditor20250728Schema = z.object({
  name: z.enum(["str_replace_based_edit_tool"]),
  type: z.enum(["text_editor_20250728"]),
  cache_control: z.any().nullable().optional(),
  max_characters: z.number().nullable().optional(),
});
const WebSearchToolSchema = z.object({
  name: z.enum(["web_search"]),
  type: z.enum(["web_search_20250305"]),
  allowed_domains: z.array(z.string()).nullable().optional(),
  blocked_domains: z.array(z.string()).nullable().optional(),
  cache_control: z.any().nullable().optional(),
  max_uses: z.number().nullable().optional(),
  user_location: z.any().nullable().optional(),
});

export const ToolSchema = z.discriminatedUnion("type", [
  CustomToolSchema,
  ToolBash20250124Schema,
  ToolTextEditor20250124Schema,
  ToolTextEditor20250429Schema,
  ToolTextEditor20250728Schema,
  WebSearchToolSchema,
]);
