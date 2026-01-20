import { z } from "zod";
import { MessageParamSchema } from "./messages";
import { ToolSchema } from "./tools";

export const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageParamSchema),
  tools: z.array(ToolSchema).optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none"]),
      z.object({
        type: z.enum(["tool"]),
        name: z.string(),
      }),
    ])
    .optional(),
  temperature: z.number().min(0).max(5).optional(),
  max_tokens: z.number().positive().optional(),
  stream: z.boolean().optional(),
  preamble: z.string().optional(),
  prompt_truncation: z.enum(["AUTO", "OFF", "LAST_MESSAGES"]).optional(),
  connectors: z.array(z.record(z.string(), z.unknown())).optional(),
  search_queries_only: z.boolean().optional(),
  documents: z.array(z.record(z.string(), z.unknown())).optional(),
  citation_quality: z.enum(["fast", "accurate", "off"]).optional(),
});

export const UsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

const TextBlockSchema = z.object({
  type: z.enum(["text"]),
  text: z.string(),
});

const ToolCallBlockSchema = z.object({
  type: z.enum(["tool_call"]),
  name: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  id: z.string(),
});

const _ResponseBlockSchema = z.union([TextBlockSchema, ToolCallBlockSchema]);

export const ChatResponseSchema = z.object({
  id: z.string(),
  response: z.object({
    id: z.string(),
    text: z.string(),
    generation_id: z.string().optional(),
    finish_reason: z
      .enum([
        "COMPLETE",
        "MAX_TOKENS",
        "STOP_SEQUENCE",
        "TOOL_CALLS",
        "ERROR",
        "ERROR_TOXIC",
      ])
      .optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          parameters: z.record(z.string(), z.unknown()),
        }),
      )
      .optional(),
    citations: z.array(z.record(z.string(), z.unknown())).optional(),
    documents: z.array(z.record(z.string(), z.unknown())).optional(),
    search_queries: z.array(z.record(z.string(), z.unknown())).optional(),
    search_results: z.array(z.record(z.string(), z.unknown())).optional(),
    meta: z
      .object({
        api_version: z
          .object({
            version: z.string(),
          })
          .optional(),
        billed_units: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
          })
          .optional(),
        tokens: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
  model: z.string().optional(),
});

export const ChatStreamEventSchema = z.discriminatedUnion("event_type", [
  z.object({
    event_type: z.enum(["stream-start"]),
    generation_id: z.string(),
  }),
  z.object({
    event_type: z.enum(["text-generation"]),
    text: z.string(),
  }),
  z.object({
    event_type: z.enum(["tool-calls-generation"]),
    tool_calls: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
  z.object({
    event_type: z.enum(["stream-end"]),
    finish_reason: z
      .enum([
        "COMPLETE",
        "MAX_TOKENS",
        "STOP_SEQUENCE",
        "TOOL_CALLS",
        "ERROR",
        "ERROR_TOXIC",
      ])
      .optional(),
    response: z
      .object({
        id: z.string(),
        text: z.string(),
        generation_id: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              parameters: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
        citations: z.array(z.record(z.string(), z.unknown())).optional(),
        documents: z.array(z.record(z.string(), z.unknown())).optional(),
        search_queries: z.array(z.record(z.string(), z.unknown())).optional(),
        search_results: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .optional(),
    usage: UsageSchema.optional(),
  }),
]);

export const ChatHeadersSchema = z.object({
  authorization: z.string().optional(),
  "cohere-version": z.string().optional(),
  "user-agent": z.string().optional(),
});
