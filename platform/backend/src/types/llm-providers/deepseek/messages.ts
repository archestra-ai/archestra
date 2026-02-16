import { z } from "zod";

const FunctionToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["function"]),
    function: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .describe(
        "DeepSeek function call parameters",
      ),
  })
  .describe(
    "DeepSeek function tool call",
  );

export const ToolCallSchema = z
  .union([FunctionToolCallSchema])
  .describe(
    "DeepSeek tool call (OpenAI-compatible format)",
  );

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe(
    "DeepSeek text content part",
  );

const ContentPartImageSchema = z
  .object({
    type: z.enum(["image_url"]),
    image_url: z
      .object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .describe(
        "DeepSeek image URL details",
      ),
  })
  .describe(
    "DeepSeek image content part",
  );

const ContentPartSchema = z
  .union([
    ContentPartTextSchema,
    ContentPartImageSchema,
  ])
  .describe(
    "DeepSeek message content part",
  );

const SystemMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
  })
  .describe(
    "DeepSeek system message",
  );

const UserMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
  })
  .describe(
    "DeepSeek user message",
  );

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    function_call: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .nullable()
      .optional()
      .describe(
        "DeepSeek function call (deprecated, use tool_calls)",
      ),
    name: z.string().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe(
    "DeepSeek assistant message",
  );

const ToolMessageParamSchema = z
  .object({
    role: z.enum(["tool"]),
    content: z.union([
      z.string(),
      z.array(z.union([ContentPartTextSchema, ContentPartImageSchema])),
    ]),
    tool_call_id: z.string(),
  })
  .describe(
    "DeepSeek tool message",
  );

const FunctionMessageParamSchema = z
  .object({
    role: z.enum(["function"]),
    content: z.string().nullable(),
    name: z.string(),
  })
  .describe(
    "DeepSeek function message (deprecated)",
  );

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
    FunctionMessageParamSchema,
  ])
  .describe(
    "DeepSeek message parameter (OpenAI-compatible format)",
  );