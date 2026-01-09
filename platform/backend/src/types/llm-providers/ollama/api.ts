/**
 * Ollama API Types
 *
 * Ollama provides an OpenAI-compatible API, so we re-export
 * OpenAI's schemas for maximum compatibility.
 */
import { z } from "zod";
import * as OpenAiAPI from "../openai/api";

// Re-export OpenAI schemas for Ollama compatibility
export const ChatCompletionRequestSchema = OpenAiAPI.ChatCompletionRequestSchema;
export const ChatCompletionResponseSchema = OpenAiAPI.ChatCompletionResponseSchema;
export const ChatCompletionsHeadersSchema = OpenAiAPI.ChatCompletionsHeadersSchema;
export const ChatCompletionUsageSchema = OpenAiAPI.ChatCompletionUsageSchema;
export const FinishReasonSchema = OpenAiAPI.FinishReasonSchema;

// Ollama-specific: model pull/list endpoints could be added here in the future
export const OllamaModelInfoSchema = z.object({
    name: z.string(),
    modified_at: z.string().optional(),
    size: z.number().optional(),
});
