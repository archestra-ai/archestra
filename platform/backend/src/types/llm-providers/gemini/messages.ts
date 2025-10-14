import { z } from "zod";

/**
 * Role Schema - Gemini uses different roles than OpenAI
 */
export const RoleSchema = z.enum(["user", "model", "function"]);

/**
 * Text Part Schema
 */
export const TextPartSchema = z.object({
  text: z.string(),
});

/**
 * Inline Data Part Schema (for images, etc.)
 */
export const InlineDataPartSchema = z.object({
  inlineData: z.object({
    mimeType: z.string(),
    data: z.string(), // base64 encoded
  }),
});

/**
 * File Data Part Schema
 */
export const FileDataPartSchema = z.object({
  fileData: z.object({
    mimeType: z.string(),
    fileUri: z.string(),
  }),
});

/**
 * Function Call Part Schema
 */
export const FunctionCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.any()),
});

export const FunctionCallPartSchema = z.object({
  functionCall: FunctionCallSchema,
});

/**
 * Function Response Part Schema
 */
export const FunctionResponsePartSchema = z.object({
  functionResponse: z.object({
    name: z.string(),
    response: z.record(z.string(), z.any()),
  }),
});

/**
 * Union of all Part types
 */
export const PartSchema = z.union([
  TextPartSchema,
  InlineDataPartSchema,
  FileDataPartSchema,
  FunctionCallPartSchema,
  FunctionResponsePartSchema,
]);

/**
 * Content Schema - represents a message in Gemini
 */
export const ContentSchema = z.object({
  role: RoleSchema,
  parts: z.array(PartSchema),
});
