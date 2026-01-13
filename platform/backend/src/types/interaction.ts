import { SupportedProvidersDiscriminatorSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import {
  Anthropic,
  Cerebras,
  Gemini,
  Ollama,
  OpenAi,
  Vllm,
} from "./llm-providers";

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
  Gemini.API.GenerateContentRequestSchema,
  Anthropic.API.MessagesRequestSchema,
  Cerebras.API.ChatCompletionRequestSchema,
  Vllm.API.ChatCompletionRequestSchema,
  Ollama.API.ChatCompletionRequestSchema,
]);

export const InteractionResponseSchema = z.union([
  OpenAi.API.ChatCompletionResponseSchema,
  Gemini.API.GenerateContentResponseSchema,
  Anthropic.API.MessagesResponseSchema,
  Cerebras.API.ChatCompletionResponseSchema,
  Vllm.API.ChatCompletionResponseSchema,
  Ollama.API.ChatCompletionResponseSchema,
]);

/**
 * Base database schema without discriminated union
 * This is what Drizzle actually returns from the database
 */
const BaseSelectInteractionSchema = createSelectSchema(
  schema.interactionsTable,
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
]);

export const InsertInteractionSchema = createInsertSchema(
  schema.interactionsTable,
  {
    type: SupportedProvidersDiscriminatorSchema,
    request: InteractionRequestSchema,
    processedRequest: InteractionRequestSchema.nullable().optional(),
    response: InteractionResponseSchema,
  },
);

export type UserInfo = z.infer<typeof UserInfoSchema>;

export type Interaction = z.infer<typeof SelectInteractionSchema>;
export type InsertInteraction = z.infer<typeof InsertInteractionSchema>;

export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;
