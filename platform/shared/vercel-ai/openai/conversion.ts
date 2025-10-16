import type {
  LanguageModelV3,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ToolChoice,
} from "vercel-ai-source-code/packages/provider/src/language-model/v3/index.ts";
import { OpenAIChatLanguageModel } from "vercel-ai-source-code/packages/openai/src/chat/openai-chat-language-model";
import type OpenAI from "openai";
import type { JSONSchema7 } from "json-schema";

export type OpenAIChatRequest = OpenAI.Chat.ChatCompletionCreateParams;
export type VercelTools = Parameters<LanguageModelV3["doGenerate"]>[0]["tools"];

export class OpenAIChatLanguageModelExtended extends OpenAIChatLanguageModel {
  /**
   * Converts request provided in request OpenAI Chat Completions API format to request in Vercel AI SDK format
   * @see https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1487
   */
  async convertRequestProviderToVercel(
    request: OpenAI.Chat.ChatCompletionCreateParams,
  ): Promise<Parameters<LanguageModelV3["doGenerate"]>[0]> {
    // Convert messages to LanguageModelV3Prompt
    const prompt = this.convertMessages(request.messages);

    // Convert tools
    const tools = request.tools
      ? request.tools.map((tool): LanguageModelV3FunctionTool => {
          if (tool.type === "function") {
            return {
              type: "function",
              name: tool.function.name,
              description: tool.function.description,
              inputSchema: (tool.function.parameters || {}) as JSONSchema7,
            };
          }
          // Handle custom tools - convert to function tool
          throw new Error("Custom tools are not yet supported");
        })
      : undefined;

    // Convert tool_choice
    let toolChoice: LanguageModelV3ToolChoice | undefined;
    if (request.tool_choice) {
      if (typeof request.tool_choice === "string") {
        switch (request.tool_choice) {
          case "none":
            toolChoice = { type: "none" };
            break;
          case "auto":
            toolChoice = { type: "auto" };
            break;
          case "required":
            toolChoice = { type: "required" };
            break;
        }
      } else if (typeof request.tool_choice === "object") {
        if (request.tool_choice.type === "function") {
          toolChoice = {
            type: "tool",
            toolName: request.tool_choice.function.name,
          };
        }
      }
    }

    return {
      prompt,
      maxOutputTokens: request.max_tokens ?? undefined,
      temperature: request.temperature ?? undefined,
      topP: request.top_p ?? undefined,
      presencePenalty: request.presence_penalty ?? undefined,
      frequencyPenalty: request.frequency_penalty ?? undefined,
      seed: request.seed ?? undefined,
      tools,
      toolChoice,
      stopSequences: request.stop
        ? Array.isArray(request.stop)
          ? request.stop
          : [request.stop]
        : undefined,
    };
  }

  /**
   * Convert OpenAI messages to LanguageModelV3Prompt
   */
  private convertMessages(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): LanguageModelV3Prompt {
    const prompt: LanguageModelV3Prompt = [];

    for (const message of messages) {
      switch (message.role) {
        case "system":
        case "developer": {
          // System and developer messages are converted to simple system messages
          const content =
            typeof message.content === "string"
              ? message.content
              : message.content
                  ?.map((part: { text: string }) => part.text)
                  .join("") || "";

          prompt.push({
            role: "system",
            content,
          });
          break;
        }

        case "user": {
          // User messages need content parts conversion
          const content =
            typeof message.content === "string"
              ? [{ type: "text" as const, text: message.content }]
              : message.content.map(
                  (part: OpenAI.Chat.ChatCompletionContentPart) => {
                    if (part.type === "text") {
                      return { type: "text" as const, text: part.text };
                    }
                    if (part.type === "image_url") {
                      // Convert image_url to file part
                      const url = part.image_url.url;
                      const isDataUrl = url.startsWith("data:");

                      if (isDataUrl) {
                        // Extract media type and data from data URL
                        const match = url.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                          const [, mediaType, base64Data] = match;
                          // Convert base64 to Uint8Array
                          const binaryString = atob(base64Data);
                          const bytes = new Uint8Array(binaryString.length);
                          for (let i = 0; i < binaryString.length; i++) {
                            bytes[i] = binaryString.charCodeAt(i);
                          }
                          return {
                            type: "file" as const,
                            data: bytes,
                            mediaType: mediaType || "image/jpeg",
                          };
                        }
                      }

                      // Handle URL images
                      return {
                        type: "file" as const,
                        data: new URL(url),
                        mediaType: "image/*",
                      };
                    }
                    if (part.type === "input_audio") {
                      // Convert audio input to file part
                      const base64Data = part.input_audio.data;
                      const binaryString = atob(base64Data);
                      const bytes = new Uint8Array(binaryString.length);
                      for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }

                      const mediaType =
                        part.input_audio.format === "wav"
                          ? "audio/wav"
                          : "audio/mp3";

                      return {
                        type: "file" as const,
                        data: bytes,
                        mediaType,
                      };
                    }
                    if (part.type === "file") {
                      // Handle PDF files
                      if (part.file.file_id) {
                        // File ID reference
                        return {
                          type: "file" as const,
                          data: part.file.file_id,
                          mediaType: "application/pdf",
                          filename: part.file.filename,
                        };
                      }
                      if (part.file.file_data) {
                        // Extract data URL
                        const match = part.file.file_data.match(
                          /^data:([^;]+);base64,(.+)$/,
                        );
                        if (match) {
                          const [, mediaType, base64Data] = match;
                          const binaryString = atob(base64Data);
                          const bytes = new Uint8Array(binaryString.length);
                          for (let i = 0; i < binaryString.length; i++) {
                            bytes[i] = binaryString.charCodeAt(i);
                          }
                          return {
                            type: "file" as const,
                            data: bytes,
                            mediaType: mediaType || "application/pdf",
                            filename: part.file.filename,
                          };
                        }
                      }
                    }

                    // Fallback to text for unknown parts
                    return { type: "text" as const, text: "" };
                  },
                );

          prompt.push({
            role: "user",
            content,
          });
          break;
        }

        case "assistant": {
          // Assistant messages can have text content and tool calls
          type AssistantContent = Array<
            | { type: "text"; text: string }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                input: unknown;
              }
          >;
          const content: AssistantContent = [];

          // Handle text content
          if (message.content) {
            const textContent =
              typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                  ? message.content
                      .map((part: { text?: string; refusal?: string }) => {
                        if (typeof part === "object" && "text" in part) {
                          return part.text;
                        }
                        return "";
                      })
                      .join("")
                  : "";

            if (textContent) {
              content.push({
                type: "text",
                text: textContent,
              });
            }
          }

          // Convert tool_calls to tool-call parts
          if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
              if (toolCall.type === "function") {
                content.push({
                  type: "tool-call",
                  toolCallId: toolCall.id,
                  toolName: toolCall.function.name,
                  input: JSON.parse(toolCall.function.arguments),
                });
              } else if (toolCall.type === "custom") {
                // Type guard for custom tool calls
                const customToolCall = toolCall as unknown as {
                  type: "custom";
                  id: string;
                  custom: { name: string; input: string };
                };
                content.push({
                  type: "tool-call",
                  toolCallId: customToolCall.id,
                  toolName: customToolCall.custom.name,
                  input: JSON.parse(customToolCall.custom.input),
                });
              }
            }
          }

          prompt.push({
            role: "assistant",
            content,
          });
          break;
        }

        case "tool": {
          // Tool messages contain tool results
          const content =
            typeof message.content === "string"
              ? message.content
              : Array.isArray(message.content)
                ? message.content
                    .map((part: { text: string }) => part.text)
                    .join("")
                : "";

          // Try to parse as JSON, otherwise treat as text
          let output;
          try {
            const parsed = JSON.parse(content);
            output = { type: "json" as const, value: parsed };
          } catch {
            output = { type: "text" as const, value: content };
          }

          prompt.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: message.tool_call_id,
                toolName: "", // Note: OpenAI format doesn't include tool name in tool messages
                output,
              },
            ],
          });
          break;
        }

        case "function": {
          // Legacy function messages - convert to tool messages
          const content = message.content || "";

          // Try to parse as JSON, otherwise treat as text
          let output;
          try {
            const parsed = JSON.parse(content);
            output = { type: "json" as const, value: parsed };
          } catch {
            output = { type: "text" as const, value: content };
          }

          prompt.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: message.name, // Use function name as tool call ID
                toolName: message.name,
                output,
              },
            ],
          });
          break;
        }

        default: {
          // Exhaustiveness check
          const _exhaustiveCheck: never = message as never;
          throw new Error(
            `Unsupported message role: ${(message as { role: string }).role}`,
          );
        }
      }
    }

    return prompt;
  }
}

