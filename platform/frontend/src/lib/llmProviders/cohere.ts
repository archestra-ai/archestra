/**
 * Cohere LLM Provider Frontend Utilities
 *
 * Implements InteractionUtils for displaying Cohere chat interactions in the UI.
 */

import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

class CohereChatInteraction implements InteractionUtils {
  private request: archestraApiTypes.CohereChatRequest;
  private response: archestraApiTypes.CohereChatResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as archestraApiTypes.CohereChatRequest;
    this.response =
      interaction.response as archestraApiTypes.CohereChatResponse;
    this.modelName = interaction.model ?? this.request.model;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;
    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    // Check if last message is a tool message
    return lastMessage.role === "tool";
  }

  getLastToolCallId(): string | null {
    const messages = this.request.messages;
    if (messages.length === 0) {
      return null;
    }

    // Look for the last tool message
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "tool" && "tool_call_id" in message) {
        return message.tool_call_id;
      }
    }

    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();

    // Tools are invoked by the assistant in tool_calls
    for (const message of this.request.messages) {
      if (
        message.role === "assistant" &&
        "tool_calls" in message &&
        message.tool_calls
      ) {
        for (const toolCall of message.tool_calls) {
          toolsUsed.add(toolCall.function.name);
        }
      }
    }

    return Array.from(toolsUsed);
  }

  getToolNamesRefused(): string[] {
    // TODO: Implement tool refusal detection for Cohere if needed
    return [];
  }

  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();

    // Check the response for tool_calls (tools that LLM wants to execute)
    if (this.response?.message?.tool_calls) {
      for (const toolCall of this.response.message.tool_calls) {
        toolsRequested.add(toolCall.function.name);
      }
    }

    return Array.from(toolsRequested);
  }

  getToolRefusedCount(): number {
    return 0;
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

      if (Array.isArray(message.content)) {
        return message.content
          .filter(
            (block): block is { type: string; text: string } =>
              block.type === "text" && "text" in block,
          )
          .map((block) => block.text)
          .join("");
      }
    }

    return "";
  }

  getLastAssistantResponse(): string {
    // Check response content first
    if (this.response?.message?.content) {
      return this.response.message.content
        .filter(
          (block): block is { type: string; text: string } =>
            block.type === "text" && "text" in block,
        )
        .map((block) => block.text)
        .join("");
    }

    // Fall back to looking in request messages
    const reversedMessages = [...this.request.messages].reverse();
    for (const message of reversedMessages) {
      if (message.role !== "assistant") {
        continue;
      }

      if ("content" in message) {
        if (typeof message.content === "string") {
          return message.content;
        }

        if (Array.isArray(message.content)) {
          return message.content
            .filter(
              (block): block is { type: string; text: string } =>
                block.type === "text" && "text" in block,
            )
            .map((block) => block.text)
            .join("");
        }
      }
    }

    return "";
  }

  mapToUiMessages(_dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    const uiMessages: PartialUIMessage[] = [];
    const messages = this.request.messages ?? [];
    const response = this.response;

    // Process request messages
    for (const message of messages) {
      if (message.role === "user") {
        let content = "";

        if (typeof message.content === "string") {
          content = message.content;
        } else if (Array.isArray(message.content)) {
          content = message.content
            .filter(
              (block): block is { type: string; text: string } =>
                block.type === "text" && "text" in block,
            )
            .map((block) => block.text)
            .join("");
        }

        if (content) {
          uiMessages.push({
            role: "user",
            parts: [{ type: "text", text: content }],
          });
        }
      } else if (message.role === "assistant") {
        const parts: PartialUIMessage["parts"] = [];

        // Extract assistant text
        if ("content" in message) {
          if (typeof message.content === "string" && message.content) {
            parts.push({ type: "text", text: message.content });
          } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === "text" && "text" in block) {
                parts.push({ type: "text", text: block.text });
              }
            }
          }
        }

        // Handle tool calls in assistant messages (invocations)
        if ("tool_calls" in message && message.tool_calls?.length) {
          for (const toolCall of message.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch {
              // Keep empty args if parsing fails
            }

            parts.push({
              type: "dynamic-tool",
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              state: "input-available",
              input: args,
            } as unknown as PartialUIMessage["parts"][number]);
          }
        }

        if (parts.length > 0) {
          uiMessages.push({ role: "assistant", parts });
        }

        // If assistant had tool_calls, tool results (role: tool) will be processed separately
      } else if (message.role === "tool" && "tool_call_id" in message) {
        // Parse tool output
        let output: unknown;
        try {
          output = JSON.parse(message.content);
        } catch {
          output = message.content;
        }

        uiMessages.push({
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "tool-result",
              toolCallId: message.tool_call_id,
              state: "output-available",
              input: {},
              output,
            } as unknown as PartialUIMessage["parts"][number],
          ],
        });
      }
    }

    // Process response
    if (response?.message) {
      const responseMessage = response.message;
      const parts: PartialUIMessage["parts"] = [];

      if (Array.isArray(responseMessage.content)) {
        for (const block of responseMessage.content) {
          if (block.type === "text" && "text" in block) {
            parts.push({ type: "text", text: block.text });
          }
        }
      }

      // Check for policy denial or refusal. We push the text so ChatBotDemo can parse it.
      if (parts.length > 0) {
        uiMessages.push({ role: "assistant", parts });
      }

      // Handle tool calls in response (LLM requested tool calls)
      if (responseMessage.tool_calls?.length) {
        for (const toolCall of responseMessage.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            // Keep empty args if parsing fails
          }

          uiMessages.push({
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: toolCall.function.name,
                toolCallId: toolCall.id,
                state: "input-available",
                input: args,
              } as unknown as PartialUIMessage["parts"][number],
            ],
          });
        }
      }
    }

    return uiMessages;
  }
}

export default CohereChatInteraction;
