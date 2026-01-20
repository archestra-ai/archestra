import { z } from "zod";

const ToolParameterSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string().optional(),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  items: z.unknown().optional(),
});

const _ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameter_definitions: z.record(z.string(), ToolParameterSchema),
});

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameter_definitions: z.record(z.string(), ToolParameterSchema),
});
