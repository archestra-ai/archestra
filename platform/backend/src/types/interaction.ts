import {
  InteractionSourceSchema,
  SupportedProvidersDiscriminatorSchema,
} from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SelectConversationChatErrorSchema } from "./conversation-chat-error";
import { DualLlmAnalysisSchema } from "./dual-llm";
import { UnsafeContextBoundarySchema } from "./interaction-guardrails";
import {
  Anthropic,
  Azure,
  Bedrock,
  Cerebras,
  Cohere,
  DeepSeek,
  Gemini,
  GithubCopilot,
  Groq,
  Minimax,
  Mistral,
  Ollama,
  OpenAi,
  Openrouter,
  Perplexity,
  Vllm,
  Xai,
  Zhipuai,
} from "./llm-providers";
import { ToonSkipReasonSchema } from "./tool-result-compression";

export { InteractionSourceSchema };

export const UserInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const InteractionAuthMethodSchema = z.enum([
  "provider_key",
  "virtual_key",
  "passthrough_virtual_key",
  "jwks",
  "oauth_client_credentials",
  "oauth_user",
  "internal",
  "unknown",
]);

/**
 * A failed upstream call is persisted with the provider `type` but this shape
 * in place of a provider response (the proxy error path in llm-proxy-handler).
 * The insert union and every read arm accept it so the row round-trips instead
 * of poisoning the whole interactions list on read-back.
 */
export const InteractionErrorResponseSchema = z.object({ error: z.string() });

/**
 * Request/Response schemas that accept any provider type
 * These are used for the database schema definition
 */
export const InteractionRequestSchema = z.union([
  OpenAi.API.ChatCompletionRequestSchema,
  OpenAi.API.EmbeddingRequestSchema,
  Gemini.API.GenerateContentRequestSchema,
  Anthropic.API.MessagesRequestSchema,
  Bedrock.API.ConverseRequestSchema,
  Cerebras.API.ChatCompletionRequestSchema,
  Mistral.API.ChatCompletionRequestSchema,
  Perplexity.API.ChatCompletionRequestSchema,
  Groq.API.ChatCompletionRequestSchema,
  Xai.API.ChatCompletionRequestSchema,
  Openrouter.API.ChatCompletionRequestSchema,
  Vllm.API.ChatCompletionRequestSchema,
  Ollama.API.ChatCompletionRequestSchema,
  Cohere.API.ChatRequestSchema,
  Zhipuai.API.ChatCompletionRequestSchema,
  DeepSeek.API.ChatCompletionRequestSchema,
  GithubCopilot.API.ChatCompletionRequestSchema,
  Minimax.API.ChatCompletionRequestSchema,
  OpenAi.API.ResponsesRequestSchema,
  Azure.API.ChatCompletionRequestSchema,
  Azure.API.ResponsesRequestSchema,
]);

export const InteractionResponseSchema = z.union([
  OpenAi.API.ChatCompletionResponseSchema,
  OpenAi.API.EmbeddingResponseSchema,
  Gemini.API.GenerateContentResponseSchema,
  Anthropic.API.MessagesResponseSchema,
  Bedrock.API.ConverseResponseSchema,
  Cerebras.API.ChatCompletionResponseSchema,
  Mistral.API.ChatCompletionResponseSchema,
  Perplexity.API.ChatCompletionResponseSchema,
  Groq.API.ChatCompletionResponseSchema,
  Xai.API.ChatCompletionResponseSchema,
  Openrouter.API.ChatCompletionResponseSchema,
  Vllm.API.ChatCompletionResponseSchema,
  Ollama.API.ChatCompletionResponseSchema,
  Cohere.API.ChatResponseSchema,
  Zhipuai.API.ChatCompletionResponseSchema,
  DeepSeek.API.ChatCompletionResponseSchema,
  GithubCopilot.API.ChatCompletionResponseSchema,
  Minimax.API.ChatCompletionResponseSchema,
  OpenAi.API.ResponsesResponseSchema,
  Azure.API.ChatCompletionResponseSchema,
  Azure.API.ResponsesResponseSchema,
  InteractionErrorResponseSchema,
]);

const extendedFields = {
  source: InteractionSourceSchema.nullable().optional(),
  authMethod: InteractionAuthMethodSchema.nullable().optional(),
  toonSkipReason: ToonSkipReasonSchema.nullable().optional(),
  dualLlmAnalyses: z.array(DualLlmAnalysisSchema).nullable().optional(),
  unsafeContextBoundary: UnsafeContextBoundarySchema.nullable().optional(),
};

/**
 * Base database schema without discriminated union
 * This is what Drizzle actually returns from the database
 */
const BaseSelectInteractionSchema = createSelectSchema(
  schema.interactionsTable,
  extendedFields,
);

/**
 * Delta-encoding bookkeeping columns. They live on the Drizzle table (and so on
 * the row the model reads) so the delta manager can walk parent chains, but they
 * are internal plumbing: the `request` / `processedRequest` returned by the model
 * is always fully reconstructed, so these must never leak into the public API
 * surface (OpenAPI spec, generated response types). Omit them from every response
 * schema. The internal row type stays available via Drizzle's `$inferSelect`.
 */
const DELTA_ENCODING_COLUMNS = {
  threadId: true,
  parentId: true,
  requestSharedPrefix: true,
  processedRequestSharedPrefix: true,
  requestLastMessageIdx: true,
} as const;

const BaseSelectInteractionResponseSchema = BaseSelectInteractionSchema.omit(
  DELTA_ENCODING_COLUMNS,
).extend({
  chatErrors: z.array(SelectConversationChatErrorSchema).optional(),
});

/**
 * Schema for computed request type field
 * - "main": Primary conversation requests (have Task tool for Claude Code)
 * - "subagent": Background/utility requests (no Task tool, prompt suggestions, etc.)
 */
export const RequestTypeSchema = z.enum(["main", "subagent"]);

/**
 * Each arm's read schema accepts either the provider response or a persisted
 * error response, so a failed interaction (stored with the provider `type`)
 * still serializes on read-back.
 */
const withErrorResponse = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, InteractionErrorResponseSchema]);

/**
 * Discriminated union schema for API responses
 * This provides type safety based on the type field
 */
export const SelectInteractionSchema = z.discriminatedUnion("type", [
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openai:chatCompletions"]),
    request: OpenAi.API.ChatCompletionRequestSchema,
    processedRequest:
      OpenAi.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(OpenAi.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openai:responses"]),
    request: OpenAi.API.ResponsesRequestSchema,
    processedRequest: OpenAi.API.ResponsesRequestSchema.nullable().optional(),
    response: withErrorResponse(OpenAi.API.ResponsesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openai:embeddings"]),
    request: OpenAi.API.EmbeddingRequestSchema,
    processedRequest: OpenAi.API.EmbeddingRequestSchema.nullable().optional(),
    response: withErrorResponse(OpenAi.API.EmbeddingResponseSchema),
  }),
  // Gemini embeddings are persisted through the OpenAI-compatible embedding
  // client, so they share OpenAI's embedding request/response shape.
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["gemini:embeddings"]),
    request: OpenAi.API.EmbeddingRequestSchema,
    processedRequest: OpenAi.API.EmbeddingRequestSchema.nullable().optional(),
    response: withErrorResponse(OpenAi.API.EmbeddingResponseSchema),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["gemini:generateContent"]),
    request: Gemini.API.GenerateContentRequestSchema,
    processedRequest:
      Gemini.API.GenerateContentRequestSchema.nullable().optional(),
    response: withErrorResponse(Gemini.API.GenerateContentResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["anthropic:messages"]),
    request: Anthropic.API.MessagesRequestSchema,
    processedRequest: Anthropic.API.MessagesRequestSchema.nullable().optional(),
    response: withErrorResponse(Anthropic.API.MessagesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["bedrock:converse"]),
    request: Bedrock.API.ConverseRequestSchema,
    processedRequest: Bedrock.API.ConverseRequestSchema.nullable().optional(),
    response: withErrorResponse(Bedrock.API.ConverseResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["cerebras:chatCompletions"]),
    request: Cerebras.API.ChatCompletionRequestSchema,
    processedRequest:
      Cerebras.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Cerebras.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["mistral:chatCompletions"]),
    request: Mistral.API.ChatCompletionRequestSchema,
    processedRequest:
      Mistral.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Mistral.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["perplexity:chatCompletions"]),
    request: Perplexity.API.ChatCompletionRequestSchema,
    processedRequest:
      Perplexity.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Perplexity.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["groq:chatCompletions"]),
    request: Groq.API.ChatCompletionRequestSchema,
    processedRequest:
      Groq.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Groq.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["xai:chatCompletions"]),
    request: Xai.API.ChatCompletionRequestSchema,
    processedRequest: Xai.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Xai.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openrouter:chatCompletions"]),
    request: Openrouter.API.ChatCompletionRequestSchema,
    processedRequest:
      Openrouter.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Openrouter.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["vllm:chatCompletions"]),
    request: Vllm.API.ChatCompletionRequestSchema,
    processedRequest:
      Vllm.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Vllm.API.ChatCompletionResponseSchema),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["ollama:chatCompletions"]),
    request: Ollama.API.ChatCompletionRequestSchema,
    processedRequest:
      Ollama.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Ollama.API.ChatCompletionResponseSchema),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["cohere:chat"]),
    request: Cohere.API.ChatRequestSchema,
    processedRequest: Cohere.API.ChatRequestSchema.nullable().optional(),
    response: withErrorResponse(Cohere.API.ChatResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["zhipuai:chatCompletions"]),
    request: Zhipuai.API.ChatCompletionRequestSchema,
    processedRequest:
      Zhipuai.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Zhipuai.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["deepseek:chatCompletions"]),
    request: DeepSeek.API.ChatCompletionRequestSchema,
    processedRequest:
      DeepSeek.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(DeepSeek.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["github-copilot:chatCompletions"]),
    request: GithubCopilot.API.ChatCompletionRequestSchema,
    processedRequest:
      GithubCopilot.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(GithubCopilot.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["minimax:chatCompletions"]),
    request: Minimax.API.ChatCompletionRequestSchema,
    processedRequest:
      Minimax.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Minimax.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["azure:chatCompletions"]),
    request: Azure.API.ChatCompletionRequestSchema,
    processedRequest:
      Azure.API.ChatCompletionRequestSchema.nullable().optional(),
    response: withErrorResponse(Azure.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["azure:responses"]),
    request: Azure.API.ResponsesRequestSchema,
    processedRequest: Azure.API.ResponsesRequestSchema.nullable().optional(),
    response: withErrorResponse(Azure.API.ResponsesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
]);

/**
 * Per-`type` read schema for the `response` field, derived from the
 * discriminated union above so it can never drift from the arms.
 */
const responseSchemaByInteractionType = new Map<string, z.ZodTypeAny>(
  SelectInteractionSchema.options.map((arm) => [
    arm.shape.type.options[0],
    arm.shape.response,
  ]),
);

/**
 * Coerce a stored `response` that no longer matches its provider's read schema
 * (provider-schema drift, partial/aborted-stream bodies, legacy error shapes)
 * into a serializable sentinel, so a single unparseable row can't 500 the whole
 * interactions list. Returns the response unchanged when it already conforms.
 */
export function normalizeInteractionResponse(
  type: string,
  response: unknown,
): unknown {
  const schema = responseSchemaByInteractionType.get(type);
  if (!schema) {
    return response;
  }
  return schema.safeParse(response).success
    ? response
    : { error: "Malformed stored interaction response" };
}

export const InsertInteractionSchema = createInsertSchema(
  schema.interactionsTable,
  {
    ...extendedFields,
    type: SupportedProvidersDiscriminatorSchema,
    request: InteractionRequestSchema,
    processedRequest: InteractionRequestSchema.nullable().optional(),
    response: InteractionResponseSchema,
  },
).extend({
  // Override profileId - required for proxy interactions, nullable for system interactions
  // (e.g., knowledge base embeddings/reranking have no associated profile)
  profileId: z.string().uuid().nullable(),
});

export type UserInfo = z.infer<typeof UserInfoSchema>;

export type Interaction = z.infer<typeof SelectInteractionSchema>;
export type InsertInteraction = z.infer<typeof InsertInteractionSchema>;
export type InteractionAuthMethod = z.infer<typeof InteractionAuthMethodSchema>;

export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

/**
 * TOON skip reason counts for session summaries
 */
export const ToonSkipReasonCountsSchema = z.object({
  applied: z.number(),
  notEnabled: z.number(),
  notEffective: z.number(),
  noToolResults: z.number(),
});

/**
 * Session summary schema for the sessions endpoint
 */
export const SessionSummarySchema = z.object({
  sessionId: z.string().nullable(),
  sessionSource: z.string().nullable(),
  source: InteractionSourceSchema.nullable(),
  sources: z.array(InteractionSourceSchema),
  interactionId: z.string().nullable(), // Only set for single interactions (null session)
  requestCount: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCacheReadTokens: z.number(),
  totalCacheWriteTokens: z.number(),
  totalCost: z.string().nullable(),
  totalBaselineCost: z.string().nullable(),
  totalToonCostSavings: z.string().nullable(),
  totalCacheSavings: z.string().nullable(),
  toonSkipReasonCounts: ToonSkipReasonCountsSchema,
  firstRequestTime: z.date(),
  lastRequestTime: z.date(),
  models: z.array(z.string()),
  profileId: z.string().nullable(), // null when profile was deleted
  profileName: z.string().nullable(),
  externalAgentIds: z.array(z.string()),
  externalAgentIdLabels: z.array(z.string().nullable()), // Resolved prompt names
  authMethods: z.array(InteractionAuthMethodSchema),
  authenticatedAppNames: z.array(z.string()),
  userNames: z.array(z.string()),
  lastInteractionRequest: z.unknown().nullable(),
  lastInteractionType: z.string().nullable(),
  conversationTitle: z.string().nullable(),
  claudeCodeTitle: z.string().nullable(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
