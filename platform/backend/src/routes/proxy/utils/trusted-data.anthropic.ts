// import {
//   DualLlmConfigModel,
//   DualLlmResultModel,
//   TrustedDataPolicyModel,
// } from "@/models";
import type { Anthropic } from "@/types";

// import { DualLlmSubagent } from "./dual-llm-subagent";

type Messages = Anthropic.Types.MessagesRequest["messages"];

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_call_id
 *
 * We need to do this because the name of the tool is not included in the "tool" message (ie. tool call result)
 * (just the content and tool_call_id)
 */
const _extractToolNameFromMessages = (
  messages: Messages,
  toolCallId: string,
): string | null => {
  // Find the most recent assistant message with tool_calls
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.length > 0
    ) {
      for (const content of message.content) {
        if (content.type === "tool_use") {
          if (content.id === toolCallId) {
            return content.name;
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
  messages: Messages,
  _agentId: string,
  _apiKey: string,
): Promise<{
  filteredMessages: Messages;
  contextIsTrusted: boolean;
}> => {
  /**
   * TODO: dual-llm doesn't yet work with anthropic
   * Load dual LLM configuration to check if analysis is enabled
   */
  // const dualLlmConfig = await DualLlmConfigModel.getDefault();
  const filteredMessages: Messages = [];
  const hasUntrustedData = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const content of message.content) {
        if (content.type === "tool_result") {
        }
      }
      filteredMessages.push(message);
    } else {
      filteredMessages.push(message);
    }
  }

  return {
    filteredMessages,
    contextIsTrusted: !hasUntrustedData,
  };
};
