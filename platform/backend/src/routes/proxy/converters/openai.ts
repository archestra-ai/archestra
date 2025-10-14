import type { z } from "zod";
import type { OpenAi } from "@/types";
import type {
  CommonChatCompletionRequest,
  CommonChatCompletionResponse,
  CommonChatCompletionChunk,
  CommonMessage,
  CommonTool,
  ProviderConverter,
} from "../types/common";

/**
 * OpenAI converter implementation
 * Since our common format is based on OpenAI's format, most conversions are direct mappings
 */
export class OpenAIConverter implements ProviderConverter {
  provider = "openai" as const;

  requestToCommon(
    request: z.infer<typeof OpenAi.API.ChatCompletionRequestSchema>
  ): CommonChatCompletionRequest {
    return {
      model: request.model,
      messages: request.messages as CommonMessage[],
      tools: request.tools as CommonTool[],
      stream: request.stream ?? false,
      temperature: request.temperature ?? undefined,
      max_tokens: request.max_tokens ?? undefined,
      tool_choice: request.tool_choice,
    };
  }

  requestFromCommon(
    request: CommonChatCompletionRequest
  ): z.infer<typeof OpenAi.API.ChatCompletionRequestSchema> {
    return {
      model: request.model,
      messages: request.messages as any,
      tools: request.tools as any,
      stream: request.stream,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      tool_choice: request.tool_choice as any,
    };
  }

  responseToCommon(
    response: z.infer<typeof OpenAi.API.ChatCompletionResponseSchema>
  ): CommonChatCompletionResponse {
    return {
      id: response.id,
      model: response.model,
      object: "chat.completion",
      created: response.created,
      choices: response.choices.map((choice) => ({
        index: choice.index,
        message: choice.message as CommonMessage,
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs,
      })),
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  responseFromCommon(
    response: CommonChatCompletionResponse
  ): z.infer<typeof OpenAi.API.ChatCompletionResponseSchema> {
    return {
      id: response.id,
      model: response.model,
      object: "chat.completion",
      created: response.created,
      choices: response.choices as any,
      usage: response.usage as any,
      system_fingerprint: null,
    };
  }

  chunkToCommon(chunk: any): CommonChatCompletionChunk {
    return {
      id: chunk.id,
      object: "chat.completion.chunk",
      created: chunk.created,
      model: chunk.model,
      choices: chunk.choices.map((choice: any) => ({
        index: choice.index,
        delta: choice.delta,
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs,
      })),
    };
  }

  chunkFromCommon(chunk: CommonChatCompletionChunk): any {
    return chunk; // Direct mapping for OpenAI
  }
}