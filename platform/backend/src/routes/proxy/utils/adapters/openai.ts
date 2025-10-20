import type { OpenAi } from "@/types";
import type { CommonMessage, ToolResultUpdates } from "../types";

type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];

/**
 * Convert OpenAI messages to common format for trusted data evaluation
 */
export function toCommonFormat(messages: OpenAiMessages): CommonMessage[] {
  const commonMessages: CommonMessage[] = [];

  for (const message of messages) {
    const commonMessage: CommonMessage = {
      role: message.role as CommonMessage["role"],
    };

    // Handle assistant messages with tool calls
    if (message.role === "assistant" && message.tool_calls) {
      // We don't include tool calls in assistant messages for evaluation
      // We only care about tool results
    }

    // Handle tool messages (tool results)
    if (message.role === "tool") {
      // Find the corresponding tool call to get the tool name
      const toolName = extractToolNameFromMessages(
        messages,
        message.tool_call_id,
      );

      if (toolName) {
        // Parse the tool result
        let toolResult: unknown;
        if (typeof message.content === "string") {
          try {
            toolResult = JSON.parse(message.content);
          } catch {
            toolResult = message.content;
          }
        } else {
          toolResult = message.content;
        }

        // Add as a tool call in common format
        commonMessage.toolCalls = [
          {
            id: message.tool_call_id,
            name: toolName,
            result: toolResult,
          },
        ];
      }
    }

    commonMessages.push(commonMessage);
  }

  return commonMessages;
}

/**
 * Apply tool result updates back to OpenAI messages
 */
export function applyUpdates(
  messages: OpenAiMessages,
  updates: ToolResultUpdates,
): OpenAiMessages {
  if (Object.keys(updates).length === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (message.role === "tool" && updates[message.tool_call_id]) {
      return {
        ...message,
        content: updates[message.tool_call_id],
      };
    }
    return message;
  });
}

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_call_id
 */
function extractToolNameFromMessages(
  messages: OpenAiMessages,
  toolCallId: string,
): string | null {
  // Find the most recent assistant message with tool_calls
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (message.role === "assistant" && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id === toolCallId) {
          if (toolCall.type === "function") {
            return toolCall.function.name;
          } else {
            return toolCall.custom.name;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract the user's original request from OpenAI messages
 */
export function extractUserRequest(messages: OpenAiMessages): string {
  const userContent =
    messages.filter((m) => m.role === "user").slice(-1)[0]?.content ||
    "process this data";

  // Convert to string if it's an array (multimodal content)
  return typeof userContent === "string"
    ? userContent
    : JSON.stringify(userContent);
}
