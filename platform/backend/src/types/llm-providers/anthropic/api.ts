import { z } from "zod";
import { MessageContentBlockSchema, MessageParamSchema } from "./messages";
import { ToolSchema } from "./tools";

const ToolChoiceAutoSchema = z.object({
  type: z.enum(["auto"]),
  disable_parallel_tool_use: z.boolean().optional(),
});

const ToolChoiceAnySchema = z.object({
  type: z.enum(["any"]),
  disable_parallel_tool_use: z.boolean().optional(),
});

const ToolChoiceToolSchema = z.object({
  type: z.enum(["tool"]),
  name: z.string(),
  disable_parallel_tool_use: z.boolean().optional(),
});

const ToolChoiceNoneSchema = z.object({
  type: z.enum(["none"]),
});

const ToolChoiceSchema = z.union([
  ToolChoiceAutoSchema,
  ToolChoiceAnySchema,
  ToolChoiceToolSchema,
  ToolChoiceNoneSchema,
]);

// Mirrors @anthropic-ai/sdk BetaJSONOutputFormat / BetaOutputConfig.
// Sent by the Vercel AI SDK to enable native structured output on opus-4-6.
// Loose: Claude Code also sends keys this schema does not list, such as
// `task_budget`, and a dropped key silently turns that capability off.
const OutputConfigSchema = z.looseObject({
  effort: z.string().nullable().optional(),
  format: z
    .object({
      type: z.literal("json_schema"),
      schema: z.record(z.string(), z.unknown()),
    })
    .nullable()
    .optional(),
});

// Mirrors @anthropic-ai/sdk BetaThinkingConfigParam (SDK 0.131). `display`
// sets how thinking comes back: "summarized" returns the thinking text,
// "omitted" returns only the signature (the newest models' default), and
// "updates" is a newer beta mode that Claude Code sends on interactive
// requests. Fastify replaces the request body with the Zod parse result, so a
// thinking field that this schema drops never reaches the upstream provider.
// Thus each variant keeps keys it does not list, and a thinking type that it
// does not list goes upstream unchanged. Anthropic validates the config there,
// so a new thinking option does not cause a 400 from the proxy.
const ThinkingDisplaySchema = z
  .enum(["summarized", "omitted", "updates"])
  .nullable()
  .optional();
// Sets what Anthropic does when a thinking block sent back in `messages` fails
// its conversation check.
const ThinkingBlockBindingSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .optional();
const ThinkingConfigSchema = z.union([
  z
    .object({
      type: z.literal("enabled"),
      budget_tokens: z.number(),
      display: ThinkingDisplaySchema,
      block_binding: ThinkingBlockBindingSchema,
    })
    .passthrough(),
  z.object({ type: z.literal("disabled") }).passthrough(),
  z.object({ type: z.literal("between_tools") }).passthrough(),
  z
    .object({
      type: z.literal("adaptive"),
      display: ThinkingDisplaySchema,
      block_binding: ThinkingBlockBindingSchema,
    })
    .passthrough(),
  z.object({ type: z.string() }).passthrough(),
]);

// Loose at the top level, like `thinking`: Fastify replaces the request body
// with this parse, so a field the schema does not list would never reach the
// upstream. Claude Code adds request fields over releases (for example
// `safeguards`, which asks the server to review auto mode actions) and expects
// a gateway to forward them unchanged.
// https://code.claude.com/docs/en/llm-gateway-protocol#forward-as-open-lists
export const MessagesRequestSchema = z.looseObject({
  model: z.string(),
  messages: z.array(MessageParamSchema),
  max_tokens: z.number(),
  container: z.string().nullable().optional(),
  context_management: z.looseObject({}).nullable().optional(),
  mcp_servers: z.array(z.any()).optional(),
  metadata: z
    .looseObject({
      user_id: z.string().nullable().optional(),
    })
    .optional(),
  output_config: OutputConfigSchema.optional(),
  service_tier: z.any().optional(),
  speed: z.enum(["fast", "standard"]).optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  system: z
    .union([
      z.string(),
      z.looseObject({
        type: z.enum(["text"]),
        text: z.string(),
        cache_control: z.any().nullable().optional(),
        citations: z.array(z.any()).nullable().optional(),
      }),
      z.array(
        z.looseObject({
          type: z.enum(["text"]),
          text: z.string(),
          cache_control: z.any().nullable().optional(),
          citations: z.array(z.any()).nullable().optional(),
        }),
      ),
    ])
    .optional(),
  temperature: z.number().optional(),
  thinking: ThinkingConfigSchema.optional(),
  tool_choice: ToolChoiceSchema.optional(),
  tools: z.array(ToolSchema).optional(),
  top_k: z.number().optional(),
  top_p: z.number().optional(),
});

export const UsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  // Per-TTL split of cache_creation_input_tokens. 1h writes are billed higher
  // than 5m, so the cost calc needs the breakdown, not just the total.
  cache_creation: z
    .object({
      ephemeral_1h_input_tokens: z.number().nullish(),
      ephemeral_5m_input_tokens: z.number().nullish(),
    })
    .nullish(),
});

export const MessagesResponseSchema = z.object({
  id: z.string(),
  content: z.array(MessageContentBlockSchema),
  model: z.string(),
  role: z.enum(["assistant"]),
  // Anthropic/Bedrock may omit these keys rather than null them; requiring the
  // key fails Fastify response serialization (500).
  stop_reason: z.any().nullish(),
  stop_sequence: z.string().nullish(),
  type: z.enum(["message"]),
  usage: UsageSchema,
});

// What the proxy routes serialize. The response serializer drops keys its
// schema does not list, and clients read keys added over releases (for example
// `safeguard_results`, the server's auto mode verdicts), so the wire schema
// keeps them. MessagesResponseSchema stays closed for the inferred type, which
// SDK `Message` values must stay assignable to.
export const MessagesResponseWireSchema = MessagesResponseSchema.extend({
  usage: UsageSchema.loose(),
}).loose();

export const MessagesHeadersSchema = z
  .object({
    "user-agent": z
      .string()
      .optional()
      .describe("The user agent of the client"),
    "anthropic-version": z.string(),
    "anthropic-beta": z
      .string()
      .optional()
      .describe("Beta features to enable (comma-separated)"),
    "x-api-key": z.string().optional(),
    authorization: z
      .string()
      .optional()
      .describe("Authorization header (Bearer token for OAuth)"),
  })
  .describe(`https://docs.claude.com/en/api/messages#parameter-anthropic-beta`);
