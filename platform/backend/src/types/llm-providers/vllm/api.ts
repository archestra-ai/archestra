/**
 * vLLM API type definitions
 * vLLM uses an OpenAI-compatible API at configurable base URL
 * These types mirror OpenAI's types for compatibility.
 */
import { z } from "zod";
import * as OpenAiAPI from "../openai/api";

// Re-export OpenAI schemas since vLLM is OpenAI-compatible
export const ChatCompletionsHeadersSchema =
    OpenAiAPI.ChatCompletionsHeadersSchema;
export const ChatCompletionRequestSchema =
    OpenAiAPI.ChatCompletionRequestSchema;
export const ChatCompletionResponseSchema =
    OpenAiAPI.ChatCompletionResponseSchema;
export const ChatCompletionUsageSchema = OpenAiAPI.ChatCompletionUsageSchema;
export const FinishReasonSchema = OpenAiAPI.FinishReasonSchema;
