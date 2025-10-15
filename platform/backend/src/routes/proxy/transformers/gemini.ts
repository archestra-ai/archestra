import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { z } from "zod";
import type { Gemini } from "@/types";
import type { ProviderTransformer } from "./common";

/**
 * Gemini generateContent/streamGenerateContent transformer implementation
 * Converts between Gemini's generateContent/streamGenerateContent
 * Content/Part format and OpenAI's chatCompletions format
 */
export class GeminiGenerateContentTransformer implements ProviderTransformer {
  provider = "gemini:generateContent" as const;

  /**
   * Convert Gemini Content array to Common Messages
   */
  private contentsToOpenAIMessages(
    contents: z.infer<typeof Gemini.Messages.ContentSchema>[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    for (const content of contents) {
      const message: OpenAI.Chat.ChatCompletionMessageParam = {
        role: this.geminiRoleToOpenAI(content.role),
        content: null,
        tool_calls: undefined,
        tool_call_id: undefined,
      };

      // Process parts
      for (const part of content.parts) {
        if ("text" in part) {
          message.content = part.text;
        } else if ("functionCall" in part) {
          if (!message.tool_calls) {
            message.tool_calls = [];
          }
          message.tool_calls.push({
            id: `call_${randomUUID().replace(/-/g, "").substring(0, 24)}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        } else if ("functionResponse" in part) {
          // Function responses in Gemini become tool messages
          messages.push({
            role: "tool",
            content: JSON.stringify(part.functionResponse.response),
            tool_call_id: part.functionResponse.name, // Using name as ID for now
          });
        }
      }

      messages.push(message);
    }

    return messages;
  }

  /**
   * Convert Common Messages to Gemini Contents
   */
  private openAIMessagesToContents(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): z.infer<typeof Gemini.Messages.ContentSchema>[] {
    const contents: z.infer<typeof Gemini.Messages.ContentSchema>[] = [];

    for (const message of messages) {
      const parts: z.infer<typeof Gemini.Messages.PartSchema>[] = [];

      if (message.content) {
        parts.push({ text: message.content });
      }

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments),
            },
          });
        }
      }

      if (message.role === "tool" && message.tool_call_id) {
        parts.push({
          functionResponse: {
            name: message.tool_call_id,
            response: JSON.parse(message.content || "{}"),
          },
        });
      }

      // Only add non-empty contents
      if (parts.length > 0) {
        contents.push({
          role: this.openAIRoleToGemini(message.role),
          parts,
        });
      }
    }

    return contents;
  }

  /**
   * Convert role from Gemini to common format
   */
  private geminiRoleToOpenAI(
    role: "user" | "model" | "function",
  ): OpenAI.Chat.ChatCompletionMessageParam["role"] {
    switch (role) {
      case "model":
        return "assistant";
      case "function":
        return "tool";
      default:
        return role;
    }
  }

  /**
   * Convert role from common to Gemini format
   */
  private openAIRoleToGemini(
    role: OpenAI.Chat.ChatCompletionMessageParam["role"],
  ): "user" | "model" | "function" {
    switch (role) {
      case "assistant":
        return "model";
      case "tool":
        return "function";
      case "system":
        return "user"; // Gemini doesn't have system role, convert to user
      case "function":
        return "function";
      default:
        return "user";
    }
  }

  requestToOpenAI(
    request: z.infer<typeof Gemini.API.GenerateContentRequestSchema>,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const messages = this.contentsToOpenAIMessages(request.contents);

    // Extract system instruction if present
    if (request.systemInstruction?.parts?.[0]?.text) {
      const systemMessage: OpenAI.Chat.ChatCompletionMessageParam = {
        role: "system",
        content: request.systemInstruction.parts[0]?.text,
      };
      messages.unshift(systemMessage);
    }

    const tools: OpenAI.Chat.ChatCompletionTool[] = [];
    if (request.tools) {
      for (const tool of request.tools) {
        for (const func of tool.functionDeclarations) {
          tools.push({
            type: "function",
            function: {
              name: func.name,
              description: func.description,
              parameters: func.parameters as Record<string, unknown>,
            },
          });
        }
      }
    }

    return {
      model: "gemini-pro", // Default model, should be passed separately
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: false, // Will be determined by endpoint
      temperature: request.generationConfig?.temperature,
      max_tokens: request.generationConfig?.maxOutputTokens,
      tool_choice: request.toolConfig?.functionCallingConfig?.mode,
    };
  }

  requestFromOpenAI(
    request: OpenAI.Chat.ChatCompletionCreateParams,
  ): z.infer<typeof Gemini.API.GenerateContentRequestSchema> {
    // Extract system message if present
    let systemInstruction:
      | z.infer<typeof Gemini.API.SystemInstructionSchema>
      | undefined;
    const messages = [...request.messages];

    if (messages[0]?.role === "system") {
      const systemMessage = messages.shift()!;
      systemInstruction = {
        parts: [{ text: systemMessage.content || "" }],
      };
    }

    const contents = this.openAIMessagesToContents(messages);

    const tools: z.infer<
      typeof Gemini.API.GenerateContentRequestSchema
    >["tools"] = [];
    if (request.tools) {
      const functionDeclarations: z.infer<
        typeof Gemini.Tools.FunctionDeclarationSchema
      >[] = [];
      for (const tool of request.tools) {
        if (tool.type === "function") {
          functionDeclarations.push({
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters as any,
          });
        }
      }
      if (functionDeclarations.length > 0) {
        tools.push({ functionDeclarations });
      }
    }

    return {
      contents,
      tools: tools.length > 0 ? tools : undefined,
      systemInstruction,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.max_tokens,
      },
      toolConfig: request.tool_choice
        ? {
            functionCallingConfig: {
              mode: request.tool_choice as any,
            },
          }
        : undefined,
    };
  }

  responseToOpenAI(
    response: z.infer<typeof Gemini.API.GenerateContentResponseSchema>,
  ): OpenAI.Chat.ChatCompletion {
    const choices: OpenAI.Chat.ChatCompletion["choices"] = [];

    if (response.candidates) {
      for (const candidate of response.candidates) {
        if (candidate.content) {
          const messages = this.contentsToOpenAIMessages([candidate.content]);
          const message = messages[0] || {
            role: "assistant" as const,
            content: null,
          };

          choices.push({
            index: candidate.index || 0,
            message,
            finish_reason: this.mapFinishReason(candidate.finishReason),
            logprobs: null,
          });
        }
      }
    }

    // If no candidates (e.g., blocked), create an empty response
    if (choices.length === 0) {
      choices.push({
        index: 0,
        message: {
          role: "assistant",
          content: null,
          refusal: response.promptFeedback?.blockReason || null,
        },
        finish_reason: "stop",
        logprobs: null,
      });
    }

    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`,
      model: response.modelVersion || "gemini-pro",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      choices,
      usage: response.usageMetadata
        ? {
            prompt_tokens: response.usageMetadata.promptTokenCount || 0,
            completion_tokens: response.usageMetadata.candidatesTokenCount || 0,
            total_tokens: response.usageMetadata.totalTokenCount || 0,
          }
        : undefined,
    };
  }

  responseFromOpenAI(
    response: OpenAI.Chat.ChatCompletion,
  ): z.infer<typeof Gemini.API.GenerateContentResponseSchema> {
    const candidates: z.infer<typeof Gemini.API.CandidateSchema>[] = [];

    for (const choice of response.choices) {
      const parts: z.infer<typeof Gemini.Messages.PartSchema>[] = [];

      if (choice.message.content) {
        parts.push({ text: choice.message.content });
      }

      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments),
            },
          });
        }
      }

      candidates.push({
        content: {
          role: "model",
          parts,
        },
        finishReason: this.mapFinishReasonToGemini(choice.finish_reason),
        index: choice.index,
      });
    }

    return {
      candidates,
      usageMetadata: response.usage
        ? {
            promptTokenCount: response.usage.prompt_tokens,
            candidatesTokenCount: response.usage.completion_tokens,
            totalTokenCount: response.usage.total_tokens,
          }
        : undefined,
      modelVersion: response.model,
    };
  }

  chunkToOpenAI(
    chunk: z.infer<typeof Gemini.API.StreamGenerateContentChunkSchema>,
  ): OpenAI.Chat.ChatCompletionChunk {
    const choices: OpenAI.Chat.ChatCompletionChunk["choices"] = [];

    if (chunk.candidates) {
      for (const candidate of chunk.candidates) {
        if (candidate.content) {
          const messages = this.contentsToOpenAIMessages([candidate.content]);
          const delta = messages[0] || {};

          choices.push({
            index: candidate.index || 0,
            delta: {
              role: delta.role,
              content: delta.content,
              tool_calls: delta.tool_calls,
            },
            finish_reason: this.mapFinishReason(candidate.finishReason),
            logprobs: null,
          });
        }
      }
    }

    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: chunk.modelVersion || "gemini-pro",
      choices,
    };
  }

  chunkFromOpenAI(
    chunk: OpenAI.Chat.ChatCompletionChunk,
  ): z.infer<typeof Gemini.API.StreamGenerateContentChunkSchema> {
    const candidates: z.infer<typeof Gemini.API.CandidateSchema>[] = [];

    for (const choice of chunk.choices) {
      const parts: z.infer<typeof Gemini.Messages.PartSchema>[] = [];

      if (choice.delta.content) {
        parts.push({ text: choice.delta.content });
      }

      if (choice.delta.tool_calls) {
        for (const toolCall of choice.delta.tool_calls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments),
            },
          });
        }
      }

      if (parts.length > 0) {
        candidates.push({
          content: {
            role: "model",
            parts,
          },
          finishReason: this.mapFinishReasonToGemini(choice.finish_reason),
          index: choice.index,
        });
      }
    }

    return {
      candidates,
      modelVersion: chunk.model,
    };
  }

  private mapFinishReason(reason?: string): string | null {
    if (!reason) return null;

    switch (reason) {
      case "STOP":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "SAFETY":
        return "content_filter";
      default:
        return "stop";
    }
  }

  private mapFinishReasonToGemini(
    reason: string | null,
  ):
    | "FINISH_REASON_UNSPECIFIED"
    | "STOP"
    | "MAX_TOKENS"
    | "SAFETY"
    | "RECITATION"
    | "OTHER"
    | undefined {
    if (!reason) return undefined;

    switch (reason) {
      case "stop":
        return "STOP";
      case "length":
        return "MAX_TOKENS";
      case "content_filter":
        return "SAFETY";
      default:
        return "OTHER";
    }
  }
}
