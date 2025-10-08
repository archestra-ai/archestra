import { TrustedDataPolicyModel } from "@/models";

import type { ChatCompletionRequestMessages } from "../types";

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_call_id
 *
 * We need to do this because the name of the tool is not included in the "tool" message (ie. tool call result)
 * (just the content and tool_call_id)
 */
const extractToolNameFromMessages = (
  messages: ChatCompletionRequestMessages,
  toolCallId: string,
): string | null => {
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
};

/**
 * Evaluate if context is trusted and filter messages based on trusted data policies
 * Dynamically evaluates and redacts blocked tool results
 * Returns both the filtered messages and whether the context is trusted
 */
export const evaluateIfContextIsTrusted = async (
  messages: ChatCompletionRequestMessages,
  agentId: string,
): Promise<{
  filteredMessages: ChatCompletionRequestMessages;
  contextIsTrusted: boolean;
}> => {
  const filteredMessages: ChatCompletionRequestMessages = [];
  const blockedToolCallIds = new Set<string>();
  const blockReasons = new Map<string, string>();
  let hasUntrustedData = false;

  // First pass: identify blocked tool calls and untrusted data
  for (const message of messages) {
    if (message.role === "tool") {
      const { tool_call_id: toolCallId, content } = message;
      let toolResult: unknown;
      if (typeof content === "string") {
        try {
          toolResult = JSON.parse(content);
        } catch {
          // If content is not valid JSON, use it as-is
          toolResult = content;
        }
      } else {
        toolResult = content;
      }

      // Extract tool name from messages
      const toolName = extractToolNameFromMessages(messages, toolCallId);

      if (toolName) {
        // Evaluate trusted data policy dynamically
        const { isTrusted, isBlocked, reason } =
          await TrustedDataPolicyModel.evaluate(agentId, toolName, toolResult);

        if (!isTrusted) {
          hasUntrustedData = true;
        }

        if (isBlocked) {
          blockedToolCallIds.add(toolCallId);
          if (reason) {
            blockReasons.set(toolCallId, reason);
          }
        }
      } else {
        // If we can't find the tool name, mark as untrusted
        hasUntrustedData = true;
      }
    }
  }

  // Second pass: filter or redact messages
  for (const message of messages) {
    if (
      message.role === "tool" &&
      blockedToolCallIds.has(message.tool_call_id)
    ) {
      // Redact blocked tool result
      const reason = blockReasons.get(message.tool_call_id);
      filteredMessages.push({
        ...message,
        content: `[Content blocked by policy${reason ? `: ${reason}` : ""}]`,
      });
    } else {
      filteredMessages.push(message);
    }
  }

  return {
    filteredMessages,
    contextIsTrusted: !hasUntrustedData,
  };
};
