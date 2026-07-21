/**
 * Ollama native `/api/chat` request/response wire types.
 *
 * Verified against Ollama v0.32.1 source (api/types.go `ChatRequest`,
 * `ChatResponse`, `Metrics`) and the request body emitted by
 * `ollama-ai-provider-v2@3.6.0` (the client the internal chat route uses for the
 * `ollama-native` provider). Streaming is NDJSON (`application/x-ndjson`), one
 * `ChatResponse`-shaped object per line.
 */
import { z } from "zod";
import { MessageSchema, ToolCallSchema } from "./messages";
import { ToolSchema } from "./tools";

/**
 * The native `options` bag (num_ctx, num_predict, top_k, repeat_penalty, …).
 * Ollama accepts an open `map[string]any`; keep it permissive so per-model
 * configured parameters and any future option pass straight through.
 */
export const OptionsSchema = z.record(z.string(), z.unknown());

/** `think`: boolean, or one of "low" | "medium" | "high" | "max". */
export const ThinkSchema = z.union([z.boolean(), z.string()]);

export const ChatRequestSchema = z
  .looseObject({
    model: z.string(),
    messages: z.array(MessageSchema),
    tools: z.array(ToolSchema).optional(),
    format: z.unknown().optional(),
    options: OptionsSchema.optional(),
    stream: z.boolean().nullable().optional(),
    keep_alive: z.union([z.string(), z.number()]).optional(),
    think: ThinkSchema.optional(),
    // ollama-ai-provider-v2 also emits these top-level; declare them so the
    // route body validator doesn't strip them before the proxy forwards.
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    truncate: z.boolean().optional(),
    shift: z.boolean().optional(),
  })
  .describe("Ollama native /api/chat request");

const ResponseMessageSchema = z.looseObject({
  role: z.string(),
  content: z.string(),
  thinking: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).nullable().optional(),
});

export const ChatResponseSchema = z
  .looseObject({
    model: z.string(),
    created_at: z.string().optional(),
    message: ResponseMessageSchema,
    done: z.boolean(),
    done_reason: z.string().optional(),
    // Metrics — all omitempty on the wire, so absent (not zero) on non-final
    // streaming chunks. Durations are nanoseconds.
    total_duration: z.number().optional(),
    load_duration: z.number().optional(),
    prompt_eval_count: z.number().optional(),
    prompt_eval_duration: z.number().optional(),
    eval_count: z.number().optional(),
    eval_duration: z.number().optional(),
  })
  .describe("Ollama native /api/chat response");

export const ChatHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .optional()
    .describe("Bearer token for Ollama (typically not required)")
    .transform((authorization) =>
      authorization ? authorization.replace("Bearer ", "") : undefined,
    ),
});
