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
import { MAX_CONFIGURABLE_NUM_CTX } from "../../model";
import { MessageSchema, ToolCallSchema } from "./messages";
import { ToolSchema } from "./tools";

/**
 * The native `options` bag — sampling and context knobs.
 *
 * Ollama itself accepts an open `map[string]any` spanning two very different
 * groups (api/types.go `Options`): per-request generation settings, and runner
 * settings that decide how the model is loaded onto the host. This schema is a
 * strict `z.object`, so anything unlisted is stripped before the proxy forwards
 * the body.
 *
 * Deliberately KEPT — `num_ctx` and `num_predict`. Being able to send these is
 * the entire reason this provider exists; `/v1` discards them. `num_ctx` is
 * bounded by {@link MAX_CONFIGURABLE_NUM_CTX} so a typo cannot ask the server
 * for an impossible KV cache.
 *
 * Deliberately DROPPED — `num_gpu`, `main_gpu`, `num_batch`, `num_thread`,
 * `use_mmap`, `use_mlock`, `low_vram`. These configure the shared inference
 * host, not the request: on a multi-tenant Ollama any caller holding a virtual
 * key could otherwise exhaust VRAM or force repeated model reloads for everyone
 * else, with no attribution beyond "the host got slow".
 */
export const OptionsSchema = z.object({
  // Sampling / prediction.
  temperature: z.number().optional(),
  top_k: z.number().int().optional(),
  top_p: z.number().optional(),
  min_p: z.number().optional(),
  typical_p: z.number().optional(),
  seed: z.number().int().optional(),
  repeat_penalty: z.number().optional(),
  repeat_last_n: z.number().int().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  stop: z.array(z.string()).optional(),
  num_keep: z.number().int().optional(),
  // Context sizing — the point of the native transport.
  num_ctx: z.number().int().min(1).max(MAX_CONFIGURABLE_NUM_CTX).optional(),
  num_predict: z.number().int().min(-2).optional(),
});

/**
 * Upper bound for `keep_alive`, in seconds. Residency control is legitimate
 * (avoiding a reload between turns); pinning a model for weeks is not.
 */
export const MAX_KEEP_ALIVE_SECONDS = 60 * 60; // 1 hour

/**
 * `keep_alive` is a duration: seconds as a number, or a Go duration string
 * ("5m", "1h"). Negative values mean "load forever" to Ollama. Clamp both forms
 * so one caller cannot hold a shared host's memory indefinitely.
 */
export const KeepAliveSchema = z
  .union([z.string(), z.number()])
  .transform((value) => clampKeepAliveSeconds(value));

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
    keep_alive: KeepAliveSchema.optional(),
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

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Go duration units Ollama accepts, expressed in seconds. */
const KEEP_ALIVE_UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};

/**
 * Normalize a `keep_alive` value to a bounded number of seconds.
 *
 * Ollama treats any negative duration as "keep loaded indefinitely", and an
 * unparseable string as its own default, so both are collapsed to the ceiling
 * rather than passed through. The return is always a plain number, which Ollama
 * reads as seconds.
 */
function clampKeepAliveSeconds(value: string | number): number {
  const seconds = typeof value === "number" ? value : parseKeepAlive(value);
  if (seconds === null || seconds < 0) return MAX_KEEP_ALIVE_SECONDS;
  return Math.min(seconds, MAX_KEEP_ALIVE_SECONDS);
}

/** Parse a Go duration string ("5m", "1h30m", "-1s"); null when unparseable. */
function parseKeepAlive(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // A bare number is already seconds ("300", "-1").
  const bare = Number(trimmed);
  if (Number.isFinite(bare)) return bare;

  const matches = trimmed.matchAll(/(-?\d+(?:\.\d+)?)(ns|us|ms|s|m|h)/g);
  let total: number | null = null;
  for (const [, amount, unit] of matches) {
    total = (total ?? 0) + Number(amount) * KEEP_ALIVE_UNIT_SECONDS[unit];
  }
  return total;
}
