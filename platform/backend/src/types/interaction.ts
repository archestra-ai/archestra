import {
  InteractionSourceSchema,
  SupportedProvidersDiscriminatorSchema,
} from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
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
  Minimax.API.ChatCompletionResponseSchema,
  OpenAi.API.ResponsesResponseSchema,
  Azure.API.ChatCompletionResponseSchema,
  Azure.API.ResponsesResponseSchema,
]);

const extendedFields = {
  source: InteractionSourceSchema.nullable().optional(),
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
 * Schema for computed request type field
 * - "main": Primary conversation requests (have Task tool for Claude Code)
 * - "subagent": Background/utility requests (no Task tool, prompt suggestions, etc.)
 */
export const RequestTypeSchema = z.enum(["main", "subagent"]);

/**
 * Discriminated union schema for API responses
 * This provides type safety based on the type field
 */
export const SelectInteractionSchema = z.discriminatedUnion("type", [
  BaseSelectInteractionSchema.extend({
    type: z.enum(["openai:chatCompletions"]),
    request: OpenAi.API.ChatCompletionRequestSchema,
    processedRequest:
      OpenAi.API.ChatCompletionRequestSchema.nullable().optional(),
    response: OpenAi.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["openai:responses"]),
    request: OpenAi.API.ResponsesRequestSchema,
    processedRequest: OpenAi.API.ResponsesRequestSchema.nullable().optional(),
    response: OpenAi.API.ResponsesResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["openai:embeddings"]),
    request: OpenAi.API.EmbeddingRequestSchema,
    processedRequest: OpenAi.API.EmbeddingRequestSchema.nullable().optional(),
    response: OpenAi.API.EmbeddingResponseSchema,
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["gemini:generateContent"]),
    request: Gemini.API.GenerateContentRequestSchema,
    processedRequest:
      Gemini.API.GenerateContentRequestSchema.nullable().optional(),
    response: Gemini.API.GenerateContentResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["anthropic:messages"]),
    request: Anthropic.API.MessagesRequestSchema,
    processedRequest: Anthropic.API.MessagesRequestSchema.nullable().optional(),
    response: Anthropic.API.MessagesResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["bedrock:converse"]),
    request: Bedrock.API.ConverseRequestSchema,
    processedRequest: Bedrock.API.ConverseRequestSchema.nullable().optional(),
    response: Bedrock.API.ConverseResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["cerebras:chatCompletions"]),
    request: Cerebras.API.ChatCompletionRequestSchema,
    processedRequest:
      Cerebras.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Cerebras.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["mistral:chatCompletions"]),
    request: Mistral.API.ChatCompletionRequestSchema,
    processedRequest:
      Mistral.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Mistral.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["perplexity:chatCompletions"]),
    request: Perplexity.API.ChatCompletionRequestSchema,
    processedRequest:
      Perplexity.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Perplexity.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["groq:chatCompletions"]),
    request: Groq.API.ChatCompletionRequestSchema,
    processedRequest:
      Groq.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Groq.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["xai:chatCompletions"]),
    request: Xai.API.ChatCompletionRequestSchema,
    processedRequest: Xai.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Xai.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["openrouter:chatCompletions"]),
    request: Openrouter.API.ChatCompletionRequestSchema,
    processedRequest:
      Openrouter.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Openrouter.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["vllm:chatCompletions"]),
    request: Vllm.API.ChatCompletionRequestSchema,
    processedRequest:
      Vllm.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Vllm.API.ChatCompletionResponseSchema,
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["ollama:chatCompletions"]),
    request: Ollama.API.ChatCompletionRequestSchema,
    processedRequest:
      Ollama.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Ollama.API.ChatCompletionResponseSchema,
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["cohere:chat"]),
    request: Cohere.API.ChatRequestSchema,
    processedRequest: Cohere.API.ChatRequestSchema.nullable().optional(),
    response: Cohere.API.ChatResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["zhipuai:chatCompletions"]),
    request: Zhipuai.API.ChatCompletionRequestSchema,
    processedRequest:
      Zhipuai.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Zhipuai.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["deepseek:chatCompletions"]),
    request: DeepSeek.API.ChatCompletionRequestSchema,
    processedRequest:
      DeepSeek.API.ChatCompletionRequestSchema.nullable().optional(),
    response: DeepSeek.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["minimax:chatCompletions"]),
    request: Minimax.API.ChatCompletionRequestSchema,
    processedRequest:
      Minimax.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Minimax.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["azure:chatCompletions"]),
    request: Azure.API.ChatCompletionRequestSchema,
    processedRequest:
      Azure.API.ChatCompletionRequestSchema.nullable().optional(),
    response: Azure.API.ChatCompletionResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionSchema.extend({
    type: z.enum(["azure:responses"]),
    request: Azure.API.ResponsesRequestSchema,
    processedRequest: Azure.API.ResponsesRequestSchema.nullable().optional(),
    response: Azure.API.ResponsesResponseSchema,
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
]);

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
  interactionId: z.string().nullable(), // Only set for single interactions (null session)
  requestCount: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCost: z.string().nullable(),
  totalBaselineCost: z.string().nullable(),
  totalToonCostSavings: z.string().nullable(),
  toonSkipReasonCounts: ToonSkipReasonCountsSchema,
  firstRequestTime: z.date(),
  lastRequestTime: z.date(),
  models: z.array(z.string()),
  profileId: z.string().nullable(), // null when profile was deleted
  profileName: z.string().nullable(),
  externalAgentIds: z.array(z.string()),
  externalAgentIdLabels: z.array(z.string().nullable()), // Resolved prompt names
  userNames: z.array(z.string()),
  lastInteractionRequest: z.unknown().nullable(),
  lastInteractionType: z.string().nullable(),
  conversationTitle: z.string().nullable(),
  claudeCodeTitle: z.string().nullable(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
