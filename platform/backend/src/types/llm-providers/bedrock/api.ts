import { z } from "zod";
import { MessageSchema, ResponseContentBlockSchema, SystemSchema } from "./messages";
import { ToolConfigSchema } from "./tools";

/**
 * Bedrock Converse API request/response schemas
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */

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

// Additional model request fields (for provider-specific features)
const AdditionalModelRequestFieldsSchema = z.record(z.string(), z.unknown()).optional();

// Converse Request schema
export const ConverseRequestSchema = z.object({
  modelId: z.string(),
  messages: z.array(MessageSchema),
  system: SystemSchema.optional(),
  inferenceConfig: InferenceConfigSchema.optional(),
  toolConfig: ToolConfigSchema.optional(),
  guardrailConfig: GuardrailConfigSchema.optional(),
  additionalModelRequestFields: AdditionalModelRequestFieldsSchema,
  additionalModelResponseFieldPaths: z.array(z.string()).optional(),
  // Internal fields for proxy compatibility
  stream: z.boolean().optional(),
});

// Token usage
export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number().optional(),
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
]);

// Output message
const OutputMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(ResponseContentBlockSchema),
});

// Converse Response schema
export const ConverseResponseSchema = z.object({
  // Response metadata
  $metadata: z.object({
    httpStatusCode: z.number().optional(),
    requestId: z.string().optional(),
    attempts: z.number().optional(),
    totalRetryDelay: z.number().optional(),
  }).optional(),
  // Main response fields
  output: z.object({
    message: OutputMessageSchema.optional(),
  }),
  stopReason: StopReasonSchema,
  usage: UsageSchema,
  metrics: MetricsSchema.optional(),
  additionalModelResponseFields: z.record(z.string(), z.unknown()).optional(),
  trace: z.any().optional(),
});

// Headers schema for the proxy
export const ConverseHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  "x-amz-access-key-id": z.string().optional().describe("AWS Access Key ID"),
  "x-amz-secret-access-key": z.string().optional().describe("AWS Secret Access Key"),
  "x-amz-session-token": z.string().optional().describe("AWS Session Token"),
  "x-amz-region": z.string().optional().describe("AWS Region"),
  authorization: z.string().optional().describe("Authorization header"),
});
