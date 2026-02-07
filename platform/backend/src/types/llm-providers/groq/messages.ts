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
        `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1165`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1144`,
  );

const CustomToolCallSchema = z
  .object({
    id: z.string(),
    type: z.enum(["custom"]),
    custom: z
      .object({
        input: z.string(),
        name: z.string(),
      })
      .describe(
        `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1128`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1107`,
  );

export const ToolCallSchema = z
  .union([FunctionToolCallSchema, CustomToolCallSchema])
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1197`,
  );

const ContentPartRefusalSchema = z
  .object({
    type: z.enum(["refusal"]),
    refusal: z.string(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L805`,
  );

const ContentPartTextSchema = z
  .object({
    type: z.enum(["text"]),
    text: z.string(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L821`,
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
        `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L765`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L755`,
  );

const ContentPartInputAudioSchema = z
  .object({
    type: z.enum(["input_audio"]),
    input_audio: z
      .object({
        data: z.string(),
        format: z.enum(["wav", "mp3"]),
      })
      .describe(
        `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L792`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L782`,
  );

const ContentPartFileSchema = z
  .object({
    type: z.enum(["file"]),
    file: z
      .object({
        file_data: z.string().optional(),
        file_id: z.string().optional(),
        filename: z.string().optional(),
      })
      .describe(
        `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L732`,
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L722`,
  );

const ContentPartSchema = z
  .union([
    ContentPartTextSchema,
    ContentPartImageSchema,
    ContentPartInputAudioSchema,
    ContentPartFileSchema,
  ])
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L711`,
  );

const DeveloperMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["developer"]),
    name: z.string().optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L936`,
  );

const SystemMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1318`,
  );

const UserMessageParamSchema = z
  .object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1434`,
  );

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    audio: z
      .object({
        id: z.string(),
      })
      .nullable()
      .optional(),
    content: z
      .union([
        z.string(),
        z.array(ContentPartTextSchema),
        z.array(ContentPartRefusalSchema),
      ])
      .nullable()
      .optional(),

    function_call: z
      .object({
        arguments: z.string(),
        name: z.string(),
      })
      .nullable()
      .optional()
      .describe(
        `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L431`,
      ),
    name: z.string().optional(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L374`,
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
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1413`,
  );

const FunctionMessageParamSchema = z
  .object({
    role: z.enum(["function"]),
    content: z.string().nullable(),
    name: z.string(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L968`,
  );

export const MessageParamSchema = z
  .union([
    DeveloperMessageParamSchema,
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
    FunctionMessageParamSchema,
  ])
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1186`,
  );
