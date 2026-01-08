/**
 * OpenRouter Message Schemas
 *
 * OpenRouter uses OpenAI-compatible message format.
 * We re-export the same schemas as OpenAI for consistency.
 */
import { z } from "zod";

const FunctionToolCallSchema = z.object({
    id: z.string(),
    type: z.enum(["function"]),
    function: z.object({
        arguments: z.string(),
        name: z.string(),
    }),
});

const CustomToolCallSchema = z.object({
    id: z.string(),
    type: z.enum(["custom"]),
    custom: z.object({
        input: z.string(),
        name: z.string(),
    }),
});

export const ToolCallSchema = z.union([FunctionToolCallSchema, CustomToolCallSchema]);

const ContentPartRefusalSchema = z.object({
    type: z.enum(["refusal"]),
    refusal: z.string(),
});

const ContentPartTextSchema = z.object({
    type: z.enum(["text"]),
    text: z.string(),
});

const ContentPartImageSchema = z.object({
    type: z.enum(["image_url"]),
    image_url: z.object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]),
    }),
});

const ContentPartInputAudioSchema = z.object({
    type: z.enum(["input_audio"]),
    input_audio: z.object({
        data: z.string(),
        format: z.enum(["wav", "mp3"]),
    }),
});

const ContentPartFileSchema = z.object({
    type: z.enum(["file"]),
    file: z.object({
        file_data: z.string().optional(),
        file_id: z.string().optional(),
        filename: z.string().optional(),
    }),
});

const ContentPartSchema = z.union([
    ContentPartTextSchema,
    ContentPartImageSchema,
    ContentPartInputAudioSchema,
    ContentPartFileSchema,
]);

const DeveloperMessageParamSchema = z.object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["developer"]),
    name: z.string().optional(),
});

const SystemMessageParamSchema = z.object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
});

const UserMessageParamSchema = z.object({
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
});

const AssistantMessageParamSchema = z.object({
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
        .optional(),
    name: z.string().optional(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
});

const ToolMessageParamSchema = z.object({
    role: z.enum(["tool"]),
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    tool_call_id: z.string(),
});

const FunctionMessageParamSchema = z.object({
    role: z.enum(["function"]),
    content: z.string().nullable(),
    name: z.string(),
});

export const MessageParamSchema = z.union([
    DeveloperMessageParamSchema,
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
    FunctionMessageParamSchema,
]);
