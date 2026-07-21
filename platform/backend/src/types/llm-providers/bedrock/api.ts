import { z } from "zod";
import {
  MessagesRequestSchema as AnthropicMessagesRequestSchema,
  MessagesResponseSchema as AnthropicMessagesResponseSchema,
} from "../anthropic/api";
import {
  MessageSchema,
  ResponseContentBlockSchema,
  SystemSchema,
} from "./messages";
import { ToolConfigSchema } from "./tools";

/**
 * Bedrock Converse API request/response schemas
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */

// =============================================================================
// CONFIGURATION SCHEMAS
// =============================================================================

// Inference configuration
const InferenceConfigSchema = z.object({
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
});

// Guardrail configuration
const GuardrailConfigSchema = z.object({
  guardrailIdentifier: z.string(),
  guardrailVersion: z.string(),
  trace: z.enum(["enabled", "disabled"]).optional(),
});

// Performance configuration
const PerformanceConfigSchema = z.object({
  latency: z.enum(["optimized"]).optional(),
});

// Service tier configuration
const ServiceTierSchema = z.object({
  type: z.enum(["default", "throughput"]).optional(),
});

// Prompt variable values (for prompt management)
const PromptVariableValuesSchema = z.union([
  z.object({ text: z.string() }),
  z.object({ json: z.record(z.string(), z.unknown()) }),
]);

// =============================================================================
// REQUEST SCHEMA
// =============================================================================

export const ConverseRequestSchema = z.object({
  modelId: z.string(),
  messages: z.array(MessageSchema).optional(),
  system: SystemSchema.optional(),
  inferenceConfig: InferenceConfigSchema.optional(),
  toolConfig: ToolConfigSchema.optional(),
  guardrailConfig: GuardrailConfigSchema.optional(),
  additionalModelRequestFields: z.record(z.string(), z.unknown()).optional(),
  additionalModelResponseFieldPaths: z.array(z.string()).optional(),
  promptVariables: z.record(z.string(), PromptVariableValuesSchema).optional(),
  performanceConfig: PerformanceConfigSchema.optional(),
  serviceTier: ServiceTierSchema.optional(),
  requestMetadata: z.record(z.string(), z.string()).optional(),
  // Internal flag set by routes based on endpoint URL (converse-stream vs converse)
  _isStreaming: z.boolean().optional(),
});

/**
 * Schema variant for AI SDK routes where modelId comes from URL path.
 * The route handler injects modelId from URL params before processing.
 */
export const ConverseRequestWithModelInUrlSchema = ConverseRequestSchema.extend(
  {
    modelId: z.string().optional(),
  },
);

// =============================================================================
// INVOKE MODEL (Anthropic Messages wire format)
// =============================================================================

/**
 * Bedrock InvokeModel request for Anthropic models. The body is the Anthropic
 * Messages API format (what the Anthropic SDK's Bedrock client and Claude Code
 * send), except:
 * - `model` is not in the body — it lives in the URL path; the route handler
 *   injects it before processing
 * - `anthropic_version` replaces the `anthropic-version` header
 * - `anthropic_beta` (array) replaces the `anthropic-beta` header
 * - streaming is selected by the endpoint (`invoke` vs
 *   `invoke-with-response-stream`), not a `stream` body field
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html
 */
export const InvokeRequestSchema = AnthropicMessagesRequestSchema.extend({
  model: z.string().optional(),
  anthropic_version: z.string().optional(),
  anthropic_beta: z.array(z.string()).optional(),
  // Internal flag set by routes based on endpoint URL
  // (invoke-with-response-stream vs invoke)
  _isStreaming: z.boolean().optional(),
});

/**
 * Bedrock InvokeModel response for Anthropic models: exactly the Anthropic
 * Messages API response.
 */
export const InvokeResponseSchema = AnthropicMessagesResponseSchema;

// =============================================================================
// RESPONSE SCHEMAS
// =============================================================================

// Token usage with cache support
export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheWriteInputTokens: z.number().optional(),
  // Per-TTL split of cache writes (sorted 1h before 5m). Needed to bill the 1h
  // write portion at the higher rate; Zod would strip it without this field.
  cacheDetails: z
    .array(
      z.object({
        ttl: z.string().optional(),
        inputTokens: z.number().optional(),
      }),
    )
    .optional(),
});

// Metrics
const MetricsSchema = z.object({
  latencyMs: z.number().optional(),
});

// Stop reason
const StopReasonSchema = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "guardrail_intervened",
  "content_filtered",
  "model_context_window_exceeded",
]);

// Output message
const OutputMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(ResponseContentBlockSchema),
});

// Converse output (union - can be message or content block)
const ConverseOutputSchema = z.object({
  message: OutputMessageSchema.optional(),
});

// Guardrail trace
const GuardrailTraceSchema = z.object({
  inputAssessment: z.record(z.string(), z.unknown()).optional(),
  outputAssessments: z.record(z.string(), z.unknown()).optional(),
  modelOutput: z.array(z.string()).optional(),
  actionReason: z.string().optional(),
});

// Prompt router trace
const PromptRouterTraceSchema = z.object({
  invokedModelId: z.string().optional(),
});

// Converse trace
const ConverseTraceSchema = z.object({
  guardrail: GuardrailTraceSchema.optional(),
  promptRouter: PromptRouterTraceSchema.optional(),
});

// Converse Response schema
export const ConverseResponseSchema = z.object({
  // AWS SDK metadata (not in official API response, but returned by SDK)
  $metadata: z
    .object({
      httpStatusCode: z.number().optional(),
      requestId: z.string().optional(),
      attempts: z.number().optional(),
      totalRetryDelay: z.number().optional(),
    })
    .optional(),
  // Main response fields from official API
  output: ConverseOutputSchema,
  stopReason: StopReasonSchema,
  usage: UsageSchema,
  metrics: MetricsSchema.optional(),
  additionalModelResponseFields: z.record(z.string(), z.unknown()).optional(),
  trace: ConverseTraceSchema.optional(),
  performanceConfig: PerformanceConfigSchema.optional(),
  serviceTier: ServiceTierSchema.optional(),
});

// =============================================================================
// HEADERS SCHEMA (for proxy)
// =============================================================================

export const ConverseHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .optional()
    .describe("Authorization header with Bearer token"),
});
