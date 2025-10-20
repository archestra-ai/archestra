import type { Anthropic } from "@/types";
import type { CommonMessage, ToolResultUpdates } from "../types";

type AnthropicMessages = Anthropic.Types.MessagesRequest["messages"];

/**
 * Convert Anthropic messages to common format for trusted data evaluation
 */
export function toCommonFormat(messages: AnthropicMessages): CommonMessage[] {
  const commonMessages: CommonMessage[] = [];

  for (const message of messages) {
    const commonMessage: CommonMessage = {
      role: message.role as CommonMessage["role"],
    };

    // Handle user messages that may contain tool results
    if (message.role === "user" && Array.isArray(message.content)) {
      const toolCalls = [];

      for (const contentBlock of message.content) {
        if (contentBlock.type === "tool_result") {
          // Find the tool name from previous assistant messages
          const toolName = extractToolNameFromMessages(
            messages,
            contentBlock.tool_use_id,
          );

          if (toolName) {
            // Parse the tool result
            let toolResult: unknown;
            if (typeof contentBlock.content === "string") {
              try {
                toolResult = JSON.parse(contentBlock.content);
              } catch {
                toolResult = contentBlock.content;
              }
            } else {
              toolResult = contentBlock.content;
            }

            toolCalls.push({
              id: contentBlock.tool_use_id,
              name: toolName,
              result: toolResult,
            });
          }
        }
      }

      if (toolCalls.length > 0) {
        commonMessage.toolCalls = toolCalls;
      }
    }

    commonMessages.push(commonMessage);
  }

  return commonMessages;
}

/**
 * Apply tool result updates back to Anthropic messages
 */
export function applyUpdates(
  messages: AnthropicMessages,
  updates: ToolResultUpdates,
): AnthropicMessages {
  if (Object.keys(updates).length === 0) {
    return messages;
  }

  return messages.map((message) => {
    // Only process user messages with content arrays
    if (message.role === "user" && Array.isArray(message.content)) {
      const updatedContent = message.content.map((contentBlock) => {
        if (
          contentBlock.type === "tool_result" &&
          updates[contentBlock.tool_use_id]
        ) {
          return {
            ...contentBlock,
            content: updates[contentBlock.tool_use_id],
          };
        }
        return contentBlock;
      });

      return {
        ...message,
        content: updatedContent,
      };
    }

    return message;
  });
}

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_use_id
 */
function extractToolNameFromMessages(
  messages: AnthropicMessages,
  toolUseId: string,
): string | null {
  // Find the most recent assistant message with tool_use blocks
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.length > 0
    ) {
      for (const content of message.content) {
        if (content.type === "tool_use") {
          if (content.id === toolUseId) {
            return content.name;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract the user's original request from Anthropic messages
 * Gets the last user message that doesn't contain tool results
 */
export function extractUserRequest(messages: AnthropicMessages): string {
  // Find the last user message that doesn't contain tool_result blocks
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      if (typeof message.content === "string") {
        return message.content;
      }
      // If content is an array, look for text blocks (not tool_result blocks)
      if (Array.isArray(message.content)) {
        const textBlock = message.content.find(
          (block) =>
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string",
        );
        if (textBlock && "text" in textBlock) {
          return textBlock.text;
        }
      }
    }
  }
  return "process this data";
}
