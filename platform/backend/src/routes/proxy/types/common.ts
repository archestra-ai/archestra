import { z } from "zod";
import type { SupportedProvider } from "@/types";

/**
 * Common message format that both providers will be converted to/from
 */
export interface CommonMessage {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content: string | null;
  name?: string;
  tool_calls?: CommonToolCall[];
  tool_call_id?: string;
  refusal?: string | null;
}

export interface CommonToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CommonToolCallDelta extends Partial<CommonToolCall> {
  index?: number;
}

export interface CommonTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CommonChatCompletionRequest {
  model: string;
  messages: CommonMessage[];
  tools?: CommonTool[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tool_choice?: unknown;
}

export interface CommonChatCompletionResponse {
  id: string;
  model: string;
  object: "chat.completion";
  created: number;
  choices: CommonChoice[];
  usage?: CommonUsage;
}

export interface CommonChoice {
  index: number;
  message: CommonMessage;
  finish_reason: string | null;
  logprobs?: unknown;
}

export interface CommonUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CommonChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: CommonChunkChoice[];
}

export interface CommonChunkChoice {
  index: number;
  delta: Partial<CommonMessage> & {
    tool_calls?: CommonToolCallDelta[];
  };
  finish_reason: string | null;
  logprobs?: unknown;
}

/**
 * Provider-specific converter interface
 */
export interface ProviderConverter {
  provider: SupportedProvider;
  
  /**
   * Convert provider-specific request to common format
   */
  requestToCommon(request: unknown): CommonChatCompletionRequest;
  
  /**
   * Convert common format to provider-specific request
   */
  requestFromCommon(request: CommonChatCompletionRequest): unknown;
  
  /**
   * Convert provider-specific response to common format
   */
  responseToCommon(response: unknown): CommonChatCompletionResponse;
  
  /**
   * Convert common format to provider-specific response
   */
  responseFromCommon(response: CommonChatCompletionResponse): unknown;
  
  /**
   * Convert provider-specific streaming chunk to common format
   */
  chunkToCommon?(chunk: unknown): CommonChatCompletionChunk;
  
  /**
   * Convert common format to provider-specific streaming chunk
   */
  chunkFromCommon?(chunk: CommonChatCompletionChunk): unknown;
}