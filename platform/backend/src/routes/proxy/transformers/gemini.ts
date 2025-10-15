import { randomUUID } from "node:crypto";
import type OpenAIProvider from "openai";
import type { z } from "zod";
import type { Gemini, OpenAi } from "@/types";
import type { ProviderTransformer } from "./common";

type GenerateContentRequest = z.infer<
  typeof Gemini.API.GenerateContentRequestSchema
>;
type GenerateContentResponse = z.infer<
  typeof Gemini.API.GenerateContentResponseSchema
>;
type GeminiRole = z.infer<typeof Gemini.Messages.RoleSchema>;
type GeminiTool = z.infer<typeof Gemini.Tools.ToolSchema>;
type GeminiFinishReason = z.infer<typeof Gemini.API.FinishReasonSchema>;
type GeminiMessageContent = z.infer<typeof Gemini.Messages.ContentSchema>;
type GeminiMessagePart = z.infer<typeof Gemini.Messages.PartSchema>;

type OpenAiMessage = z.infer<typeof OpenAi.Messages.MessageParamSchema>;
type OpenAiRole = OpenAiMessage["role"];
type OpenAiFinishReason = z.infer<typeof OpenAi.API.FinishReasonSchema>;
type OpenAiRequest = OpenAIProvider.Chat.ChatCompletionCreateParams;
type OpenAiResponse = OpenAIProvider.Chat.ChatCompletion;
type OpenAiChunk = OpenAIProvider.Chat.ChatCompletionChunk;

/**
 * Gemini generateContent/streamGenerateContent transformer implementation
 * Converts between Gemini's generateContent/streamGenerateContent
 * Content/Part format and OpenAI's chatCompletions format
 */
export class GeminiGenerateContentTransformer
  implements
    ProviderTransformer<
      GenerateContentRequest,
      GenerateContentResponse,
      GenerateContentResponse
    >
{
  provider = "gemini:generateContent" as const;

  /**
   * Convert Gemini Content array to OpenAI Messages
   */
  private contentsToOpenAIMessages(
    contents: GeminiMessageContent[],
  ): OpenAiMessage[] {
    const messages: OpenAiMessage[] = [];

    for (const content of contents) {
      const message: OpenAiMessage = {
        role: this.geminiRoleToOpenAI(content.role),
        content: null,
        tool_calls: undefined,
        tool_call_id: undefined,
      };

      // Process parts
      for (const part of content.parts) {
        const partData = part.data;
        if ("text" in partData) {
          message.content = partData.text;
        } else if ("functionCall" in partData) {
          if (!message.tool_calls) {
            message.tool_calls = [];
          }
          message.tool_calls.push({
            id: `call_${randomUUID().replace(/-/g, "").substring(0, 24)}`,
            type: "function",
            function: {
              name: partData.functionCall.name,
              arguments: JSON.stringify(partData.functionCall.args),
            },
          });
        } else if ("functionResponse" in partData) {
          // Function responses in Gemini become tool messages
          messages.push({
            role: "tool",
            content: JSON.stringify(partData.functionResponse.response),
            tool_call_id: partData.functionResponse.name, // Using name as ID for now
          });
        }
      }

      messages.push(message);
    }

    return messages;
  }

  /**
   * Convert OpenAI Messages to Gemini Contents
   */
  private openAIMessagesToContents(
    messages: OpenAiMessage[],
  ): GeminiMessageContent[] {
    const contents: GeminiMessageContent[] = [];

    for (const message of messages) {
      const parts: GeminiMessagePart[] = [];

      if (message.content) {
        parts.push({
          data: { text: message.content },
          metadata: {} as any,
        });
      }

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          parts.push({
            data: {
              functionCall: {
                name: toolCall.function.name,
                args: JSON.parse(toolCall.function.arguments),
              },
            },
            metadata: {} as any,
          });
        }
      }

      if (message.role === "tool" && message.tool_call_id) {
        parts.push({
          data: {
            functionResponse: {
              name: message.tool_call_id,
              response: JSON.parse(message.content || "{}"),
            },
          },
          metadata: {} as any,
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
   * Convert role from Gemini to openai format
   */
  private geminiRoleToOpenAI(role: GeminiRole): OpenAiRole {
    switch (role) {
      case "model":
        return "assistant";
      case "user":
        return "user";
      case "function":
        return "tool";
      default:
        return role;
    }
  }

  /**
   * Convert role from openai to Gemini format
   */
  private openAIRoleToGemini(role: OpenAiRole): GeminiRole {
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

  requestToOpenAI(request: GenerateContentRequest): OpenAiRequest {
    const messages = this.contentsToOpenAIMessages(request.contents);

    // Extract system instruction if present
    if (request.systemInstruction?.parts?.[0]?.text) {
      const systemMessage: OpenAiMessage = {
        role: "system",
        content: request.systemInstruction.parts[0]?.text,
      };
      messages.unshift(systemMessage);
    }

    const tools: OpenAiRequest["tools"] = [];
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

  requestFromOpenAI(request: OpenAiRequest): GenerateContentRequest {
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

    const tools: GeminiTool[] = [];
    if (request.tools) {
      const functionDeclarations: GeminiTool["functionDeclarations"] = [];
      for (const tool of request.tools) {
        if (tool.type === "function") {
          functionDeclarations.push({
            name: tool.function.name,
            description: tool.function.description || "",
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

  responseToOpenAI(response: GenerateContentResponse): OpenAiResponse {
    const choices: OpenAiResponse["choices"] = [];

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
      model: response.modelVersion,
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

  responseFromOpenAI(response: OpenAiResponse): GenerateContentResponse {
    const candidates: z.infer<typeof Gemini.API.CandidateSchema>[] = [];

    for (const choice of response.choices) {
      const parts: GeminiMessagePart[] = [];

      if (choice.message.content) {
        parts.push({
          data: { text: choice.message.content },
          metadata: {} as any,
        });
      }

      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          parts.push({
            data: {
              functionCall: {
                name: toolCall.function.name,
                args: JSON.parse(toolCall.function.arguments),
              },
            },
            metadata: {} as any,
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
        safetyRatings: [],
        citationMetadata: { citationSources: [] },
        tokenCount: 0,
        groundingAttributions: [],
        groundingMetadata: undefined,
        avgLogprobs: 0,
        logprobsResult: undefined,
        urlContextMetadata: undefined,
      });
    }

    return {
      candidates,
      usageMetadata: response.usage
        ? {
            promptTokenCount: response.usage.prompt_tokens,
            cachedContentTokenCount: 0,
            candidatesTokenCount: response.usage.completion_tokens,
            toolUsePromptTokenCount: 0,
            thoughtsTokenCount: 0,
            totalTokenCount: response.usage.total_tokens,
            promptTokensDetails: [],
            cacheTokensDetails: [],
            candidatesTokensDetails: [],
            toolUsePromptTokensDetails: [],
          }
        : undefined,
      modelVersion: response.model,
      promptFeedback: { safetyRatings: [] },
    };
  }

  chunkToOpenAI(chunk: GenerateContentResponse): OpenAiChunk {
    const choices: OpenAiChunk["choices"] = [];

    for (const candidate of chunk.candidates) {
      if (candidate.content) {
        const messages = this.contentsToOpenAIMessages([candidate.content]);
        const message = messages[0];

        const delta: OpenAiChunk["choices"][number]["delta"] = {};
        if (message) {
          if (message.role === "assistant" || message.role === "user" || message.role === "system" || message.role === "developer" || message.role === "tool") {
            delta.role = message.role;
          }
          if (message.content) {
            delta.content = message.content;
          }
          if ("tool_calls" in message && message.tool_calls) {
            delta.tool_calls = message.tool_calls;
          }
        }

        choices.push({
          index: candidate.index || 0,
          delta,
          finish_reason: this.mapFinishReason(candidate.finishReason) || null,
          logprobs: null,
        });
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

  private mapFinishReason(reason?: GeminiFinishReason): OpenAiFinishReason {
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
    reason: OpenAiFinishReason,
  ): GeminiFinishReason {
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
