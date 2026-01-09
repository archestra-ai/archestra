import { z } from "zod";
import { ChatMessageSchema } from "./messages";
import { CohereToolSchema } from "./tools";

export const ChatRequestSchema = z.object({
    model: z.string(),
    messages: z.array(ChatMessageSchema),
    tools: z.array(CohereToolSchema).optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().optional(),
    temperature: z.number().optional(),
    seed: z.number().optional(),
    response_format: z.any().optional(),
});

export const UsageSchema = z.object({
    billed_units: z.object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
    }).optional(),
    tokens: z.object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
    }).optional(),
});

export const ChatResponseSchema = z.object({
    id: z.string(),
    model: z.string(),
    message: z.object({
        role: z.literal("assistant"),
        content: z.array(z.object({
            type: z.literal("text"),
            text: z.string(),
        })),
        tool_calls: z.array(z.any()).optional(),
    }).optional(),
    usage: UsageSchema.optional(),
    finish_reason: z.enum(["COMPLETE", "STOP_SEQUENCE", "MAX_TOKENS", "TOOL_USE"]).optional(),
});

export const ChatHeadersSchema = z.object({
    "Authorization": z.string().optional(),
});

// Streaming types
export const StreamChunkSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("message-start"),
        id: z.string(),
        delta: z.object({
            message: z.object({
                role: z.literal("assistant"),
            }),
        }),
    }),
    z.object({
        type: z.literal("content-start"),
        index: z.number(),
    }),
    z.object({
        type: z.literal("content-delta"),
        index: z.number(),
        delta: z.object({
            message: z.object({
                content: z.string(),
            }),
        }),
    }),
    z.object({
        type: z.literal("content-end"),
        index: z.number(),
    }),
    z.object({
        type: z.literal("message-end"),
        delta: z.object({
            finish_reason: z.string().optional(),
            usage: UsageSchema.optional(),
        }).optional(),
    }),
    z.object({
        type: z.literal("tool-call-start"),
        index: z.number(),
        delta: z.object({
            message: z.object({
                tool_calls: z.object({
                    id: z.string().optional(),
                    type: z.string().optional(),
                    function: z.object({
                        name: z.string().optional(),
                        arguments: z.string().optional(),
                    }).optional(),
                }).optional(),
            }),
        }),
    }),
    z.object({
        type: z.literal("tool-call-delta"),
        index: z.number(),
        delta: z.object({
            message: z.object({
                tool_calls: z.object({
                    function: z.object({
                        arguments: z.string().optional(),
                    }).optional(),
                }).optional(),
            }),
        }),
    }),
    z.object({
        type: z.literal("tool-call-end"),
        index: z.number(),
    }),
]);
