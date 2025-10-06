import { InteractionModel, TrustedDataPolicyModel } from "@/models";

import type { ChatCompletionRequestMessages } from "../types";

/**
 * Extract tool name from conversation history by finding the assistant message
 * that contains the tool_call_id
 *
 * We need to do this because the name of the tool is not included in the "tool" message (ie. tool call result)
 * (just the content and tool_call_id)
 */
const extractToolNameFromHistory = async (
  chatId: string,
  toolCallId: string,
): Promise<string | null> => {
  const interactions = await InteractionModel.getAllInteractionsForChat(chatId);

  // Find the most recent assistant message with tool_calls
  for (let i = interactions.length - 1; i >= 0; i--) {
    const { content } = interactions[i];

    if (content.role === "assistant" && content.tool_calls) {
      for (const toolCall of content.tool_calls) {
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

export const evaluatePolicies = async (
  messages: ChatCompletionRequestMessages,
  chatId: string,
) => {
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

      // Extract tool name from conversation history
      const toolName = await extractToolNameFromHistory(chatId, toolCallId);

      if (toolName) {
        // Evaluate trusted data policy
        const { isTrusted, isBlocked, reason } =
          await TrustedDataPolicyModel.evaluate(chatId, toolName, toolResult);

        // Store tool result as interaction
        await InteractionModel.create({
          chatId,
          content: message,
          trusted: isTrusted,
          blocked: isBlocked,
          reason,
        });
      }
    }
  }
};

/**
 * "Redact" blocked tool result data from showing up in the context
 *
 * This function redacts tool response messages that have been marked as blocked,
 * by trusted data policies, preventing the LLM from seeing potentially malicious data
 *
 * NOTE: we cannot simply remove these messages because OpenAI makes certain assumptions, for example:
 *
 * HTTP 400 An assistant message with 'tool_calls' must be followed by tool messages responding to each
 * 'tool_call_id'. The following tool_call_ids did not have response messages: call_snkylRZezUUhqjex9BGwBRMb
 */
export const redactBlockedToolResultData = async (
  chatId: string,
  messages: ChatCompletionRequestMessages,
): Promise<ChatCompletionRequestMessages> => {
  // Get blocked tool calls
  const blockedToolCalls = await InteractionModel.getBlockedToolCalls(chatId);

  // If no blocked tool calls, return messages as-is
  if (blockedToolCalls.length === 0) {
    return messages;
  }

  // Redact content of blocked tool call messages
  return messages.map((message) => {
    if (message.role === "tool" && message.tool_call_id) {
      const blockedToolCall = blockedToolCalls.find(
        (call) => call.toolCallId === message.tool_call_id,
      );
      if (blockedToolCall) {
        return {
          ...message,
          content: `[REDACTED: Data blocked by policy: ${blockedToolCall?.reason}]`,
        };
      }
    }
    return message;
  });
};
