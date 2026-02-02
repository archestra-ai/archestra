/**
 * Groq LLM Provider Interaction Utilities
 *
 * Groq uses an OpenAI-compatible API, so this module re-exports the OpenAI
 * interaction utilities for use with Groq interactions.
 *
 * @module llmProviders/groq
 */

import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import {
  type DualLlmResult,
  type Interaction,
  type InteractionUtils,
  parseRefusalMessage,
} from "./common";

/**
 * Groq Chat Completion Interaction handler.
 *
 * This class provides utilities for parsing and extracting information from
 * Groq chat completion interactions. Since Groq uses an OpenAI-compatible API,
 * the request and response structures are the same as OpenAI.
 */
class GroqChatCompletionInteraction implements InteractionUtils {
  private request: archestraApiTypes.OpenAiChatCompletionRequest;
  private response: archestraApiTypes.OpenAiChatCompletionResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    // Groq uses OpenAI-compatible request/response format
    this.request =
      interaction.request as archestraApiTypes.OpenAiChatCompletionRequest;
    this.response =
      interaction.response as archestraApiTypes.OpenAiChatCompletionResponse;
    this.modelName = interaction.model ?? this.request.model;
  }

  /**
   * Check if the last message in the request is a tool message.
   *
   * @returns True if the last message has role "tool".
   */
  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    return lastMessage.role === "tool";
  }

  /**
   * Get the tool_call_id from the last message if it's a tool message.
   *
   * @returns The tool_call_id string or null.
   */
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

  /**
   * Get the names of tools that were used (invoked) in the interaction.
   *
   * @returns Array of tool names.
   */
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

  /**
   * Get the names of tools that were refused by policy.
   *
   * @returns Array of refused tool names.
   */
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

  /**
   * Get the names of tools requested in the response (tool calls that LLM
   * wants to execute).
   *
   * @returns Array of requested tool names.
   */
  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();

    for (const choice of this.response.choices) {
      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          if ("function" in toolCall) {
            toolsRequested.add(toolCall.function.name);
          }
        }
      }
    }

    return Array.from(toolsRequested);
  }

  /**
   * Get the last user message content from the request.
   *
   * @returns The user message text.
   */
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

  /**
   * Get the assistant's response content.
   *
   * @returns The assistant response text.
   */
  getLastAssistantResponse(): string {
    const content = this.response.choices[0]?.message?.content as string;
    return content ?? "";
  }

  /**
   * Count the number of tool invocations that were refused.
   *
   * @returns The count of refused tools.
   */
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
    for (const choice of this.response.choices) {
      const refusal = choice.message.refusal as string;
      if (refusal && refusal.length > 0) {
        count++;
      }
    }
    return count;
  }

  /**
   * Map the interaction to UI-friendly message format.
   *
   * @param dualLlmResults - Optional dual LLM verification results.
   * @returns Array of partial UI messages.
   */
  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    const uiMessages: PartialUIMessage[] = [];

    // Process request messages
    for (const message of this.request.messages) {
      if (message.role === "user") {
        const content =
          typeof message.content === "string"
            ? message.content
            : message.content?.[0]?.type === "text"
              ? message.content[0].text
              : "";
        uiMessages.push({
          id: crypto.randomUUID(),
          role: "user",
          content,
          parts: [{ type: "text", text: content }],
        });
      } else if (message.role === "assistant") {
        const parts: PartialUIMessage["parts"] = [];

        // Handle text content
        if (message.content) {
          parts.push({
            type: "text",
            text: message.content as string,
          });
        }

        // Handle tool calls
        if (message.tool_calls) {
          for (const toolCall of message.tool_calls) {
            if ("function" in toolCall) {
              const dualLlmResult = dualLlmResults?.find(
                (r) => r.toolCallId === toolCall.id,
              );

              parts.push({
                type: `tool-${toolCall.function.name}`,
                toolCallId: toolCall.id,
                state: "output",
                input: JSON.parse(toolCall.function.arguments || "{}"),
                output: undefined,
                dualLlmResult: dualLlmResult
                  ? {
                      recommendation: dualLlmResult.recommendation,
                      reasoning: dualLlmResult.reasoning,
                    }
                  : undefined,
              });
            }
          }
        }

        // Handle refusals
        if (message.refusal) {
          const refusalInfo = parseRefusalMessage(message.refusal as string);
          if (refusalInfo.toolName) {
            parts.push({
              type: `tool-${refusalInfo.toolName}`,
              toolCallId: "",
              state: "output-denied",
              input: refusalInfo.toolArguments
                ? JSON.parse(refusalInfo.toolArguments)
                : {},
              errorText: JSON.stringify({ reason: refusalInfo.reason }),
            });
          }
        }

        if (parts.length > 0) {
          uiMessages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: (message.content as string) ?? "",
            parts,
          });
        }
      }
    }

    // Process response
    for (const choice of this.response.choices) {
      const parts: PartialUIMessage["parts"] = [];

      if (choice.message.content) {
        parts.push({
          type: "text",
          text: choice.message.content as string,
        });
      }

      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          if ("function" in toolCall) {
            const dualLlmResult = dualLlmResults?.find(
              (r) => r.toolCallId === toolCall.id,
            );

            parts.push({
              type: `tool-${toolCall.function.name}`,
              toolCallId: toolCall.id,
              state: "pending",
              input: JSON.parse(toolCall.function.arguments || "{}"),
              dualLlmResult: dualLlmResult
                ? {
                    recommendation: dualLlmResult.recommendation,
                    reasoning: dualLlmResult.reasoning,
                  }
                : undefined,
            });
          }
        }
      }

      if (choice.message.refusal) {
        const refusalInfo = parseRefusalMessage(choice.message.refusal as string);
        if (refusalInfo.toolName) {
          parts.push({
            type: `tool-${refusalInfo.toolName}`,
            toolCallId: "",
            state: "output-denied",
            input: refusalInfo.toolArguments
              ? JSON.parse(refusalInfo.toolArguments)
              : {},
            errorText: JSON.stringify({ reason: refusalInfo.reason }),
          });
        }
      }

      if (parts.length > 0) {
        uiMessages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: (choice.message.content as string) ?? "",
          parts,
        });
      }
    }

    return uiMessages;
  }
}

export { GroqChatCompletionInteraction };
export default GroqChatCompletionInteraction;
