/**
 * Ollama Interaction Utils
 *
 * Ollama exposes an OpenAI-compatible API, so we can reuse the OpenAI interaction class.
 * See: https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

/**
 * Ollama uses the same request/response format as OpenAI.
 * This class handles Ollama chat completion interactions identically to OpenAI.
 */
class OllamaChatCompletionInteraction implements InteractionUtils {
  // Ollama uses OpenAI-compatible types
  private request: archestraApiTypes.OpenAiChatCompletionRequest;
  private response: archestraApiTypes.OpenAiChatCompletionResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request =
      interaction.request as archestraApiTypes.OpenAiChatCompletionRequest;
    this.response =
      interaction.response as archestraApiTypes.OpenAiChatCompletionResponse;
    this.modelName = interaction.model ?? this.request.model;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    return lastMessage.role === "tool";
  }

  getLastToolCallId(): string | null {
    const messages = this.request.messages;
    if (messages.length === 0) {
      return null;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === "tool") {
      return lastMessage.tool_call_id;
    }
    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();
    for (const message of this.request.messages) {
      if (message.role === "assistant" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if ("function" in toolCall) {
            toolsUsed.add(toolCall.function.name);
          }
        }
      }
    }
    return Array.from(toolsUsed);
  }

  getToolNamesRefused(): string[] {
    const toolsRefused = new Set<string>();
    for (const message of this.request.messages) {
      if (message.role === "assistant") {
        const refusal = message.refusal as string;
        if (refusal && refusal.length > 0) {
          const toolName = refusal.match(
            /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
          )?.[1];
          if (toolName) {
            toolsRefused.add(toolName);
          }
        }
      }
    }

    for (const message of this.response.choices) {
      const refusal = message.message.refusal as string;
      if (refusal && refusal.length > 0) {
        const toolName = refusal.match(
          /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
        )?.[1];
        if (toolName) {
          toolsRefused.add(toolName);
        }
      }
    }
    return Array.from(toolsRefused);
  }

  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();

    for (const choice of this.response.choices) {
      if (Array.isArray(choice.message.tool_calls)) {
        for (const toolCall of choice.message.tool_calls) {
          if ("function" in toolCall) {
            toolsRequested.add(toolCall.function.name);
          }
        }
      }
    }

    return Array.from(toolsRequested);
  }

  getLastUserMessage(): string {
    const reversedMessages = [...this.request.messages].reverse();
    for (const message of reversedMessages) {
      if (message.role !== "user") {
        continue;
      }
      if (typeof message.content === "string") {
        return message.content;
      }
      if (message.content?.[0]?.type === "text") {
        return message.content[0].text;
      }
    }
    return "";
  }

  getLastAssistantResponse(): string {
    const content = this.response.choices[0]?.message?.content as string;
    return content ?? "";
  }

  getToolRefusedCount(): number {
    let count = 0;
    for (const message of this.request.messages) {
      if (message.role === "assistant") {
        const refusal = message.refusal as string;
        if (refusal && refusal.length > 0) {
          count++;
        }
      }
    }
    for (const message of this.response.choices) {
      const refusal = message.message.refusal as string;
      if (refusal && refusal.length > 0) {
        count++;
      }
    }
    return count;
  }

  private mapToUiMessage(
    message:
      | archestraApiTypes.OpenAiChatCompletionRequest["messages"][number]
      | archestraApiTypes.OpenAiChatCompletionResponse["choices"][number]["message"],
  ): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const { content, role } = message;

    if (role === "assistant") {
      const { tool_calls: toolCalls } = message;
      const refusal = message.refusal as string;

      if (Array.isArray(toolCalls)) {
        if (typeof content === "string" && content) {
          parts.push({ type: "text", text: content });
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text") {
              parts.push({ type: "text", text: part.text });
            } else if (part.type === "refusal") {
              parts.push({ type: "text", text: part.refusal });
            }
          }
        }

        for (const toolCall of toolCalls) {
          if (toolCall.type === "function") {
            parts.push({
              type: "dynamic-tool",
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              state: "input-available",
              input: JSON.parse(toolCall.function.arguments),
            });
          } else if (toolCall.type === "custom") {
            parts.push({
              type: "dynamic-tool",
              toolName: toolCall.custom.name,
              toolCallId: toolCall.id,
              state: "input-available",
              input: JSON.parse(toolCall.custom.input),
            });
          }
        }
      } else if (refusal) {
        parts.push({ type: "text", text: refusal });
      }
    } else if (message.role === "tool") {
      const toolContent = message.content;
      const toolCallId = message.tool_call_id;

      let output: unknown;
      try {
        output =
          typeof toolContent === "string"
            ? JSON.parse(toolContent)
            : toolContent;
      } catch {
        output = toolContent;
      }

      parts.push({
        type: "dynamic-tool",
        toolName: "tool-result",
        toolCallId,
        state: "output-available",
        input: {},
        output,
      });
    } else {
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "image_url") {
            parts.push({
              type: "file",
              mediaType: "image/*",
              url: part.image_url.url,
            });
          } else if (part.type === "refusal") {
            parts.push({ type: "text", text: part.refusal });
          }
        }
      }
    }

    const ollamaRoleToUIMessageRoleMap: Record<
      archestraApiTypes.OpenAiChatCompletionRequest["messages"][number]["role"],
      PartialUIMessage["role"]
    > = {
      developer: "system",
      system: "system",
      function: "assistant",
      tool: "assistant",
      user: "user",
      assistant: "assistant",
    };

    return {
      role: ollamaRoleToUIMessageRoleMap[role],
      parts,
    };
  }

  private mapRequestToUiMessages(
    dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage[] {
    const messages = this.request.messages;
    const uiMessages: PartialUIMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "tool") {
        continue;
      }

      const uiMessage = this.mapToUiMessage(msg);

      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

        for (const toolCall of msg.tool_calls) {
          const toolResultMsg = messages
            .slice(i + 1)
            .find(
              (m) =>
                m.role === "tool" &&
                "tool_call_id" in m &&
                m.tool_call_id === toolCall.id,
            );

          if (toolResultMsg && toolResultMsg.role === "tool") {
            const toolResultUiMsg = this.mapToUiMessage(toolResultMsg);
            toolCallParts.push(...toolResultUiMsg.parts);

            const dualLlmResultForTool = dualLlmResults?.find(
              (result) => result.toolCallId === toolCall.id,
            );

            if (dualLlmResultForTool) {
              const dualLlmPart = {
                type: "dual-llm-analysis" as const,
                toolCallId: dualLlmResultForTool.toolCallId,
                safeResult: dualLlmResultForTool.result,
                conversations: Array.isArray(dualLlmResultForTool.conversations)
                  ? (dualLlmResultForTool.conversations as Array<{
                      role: "user" | "assistant";
                      content: string | unknown;
                    }>)
                  : [],
              };
              toolCallParts.push(dualLlmPart);
            }
          }
        }

        uiMessages.push({
          ...uiMessage,
          parts: toolCallParts,
        });
      } else {
        uiMessages.push(uiMessage);
      }
    }

    return uiMessages;
  }

  private mapResponseToUiMessages(): PartialUIMessage[] {
    return this.response.choices.map((choice) =>
      this.mapToUiMessage(choice.message),
    );
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    return [
      ...this.mapRequestToUiMessages(dualLlmResults),
      ...this.mapResponseToUiMessages(),
    ];
  }
}

export default OllamaChatCompletionInteraction;
