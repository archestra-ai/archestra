/**
 * x.ai (Grok) API type definitions
 * x.ai uses an OpenAI-compatible API at https://api.x.ai/v1
 * These types mirror OpenAI's types for compatibility.
 */
import { z } from "zod";
import * as OpenAiAPI from "../openai/api";

// Re-export OpenAI schemas since x.ai is OpenAI-compatible
export const ChatCompletionsHeadersSchema =
    OpenAiAPI.ChatCompletionsHeadersSchema;
export const ChatCompletionRequestSchema =
    OpenAiAPI.ChatCompletionRequestSchema;
export const ChatCompletionResponseSchema =
    OpenAiAPI.ChatCompletionResponseSchema;
export const ChatCompletionUsageSchema = OpenAiAPI.ChatCompletionUsageSchema;
export const FinishReasonSchema = OpenAiAPI.FinishReasonSchema;
