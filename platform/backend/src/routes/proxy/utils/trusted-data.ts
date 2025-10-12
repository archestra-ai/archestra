import {
  DualLlmConfigModel,
  DualLlmResultModel,
  TrustedDataPolicyModel,
} from "@/models";
import type { ChatCompletionRequestMessages } from "../types";
import { DualLlmSubagent } from "./dual-llm-subagent";

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
  apiKey: string,
): Promise<{
  filteredMessages: ChatCompletionRequestMessages;
  contextIsTrusted: boolean;
}> => {
  // Load dual LLM configuration to check if analysis is enabled
  const dualLlmConfig = await DualLlmConfigModel.getDefault();

  const filteredMessages: ChatCompletionRequestMessages = [];
  const blockedToolCallIds = new Set<string>();
  const blockReasons = new Map<string, string>();
  let hasUntrustedData = false;

  // First pass: identify blocked tool calls and untrusted data
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
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
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

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
    } else if (message.role === "tool") {
      // Tool message - check if it needs Dual LLM analysis

      // Check if Dual LLM analysis is enabled
      if (dualLlmConfig.enabled) {
        // First, check if this tool call has already been analyzed
        const existingResult = await DualLlmResultModel.findByToolCallId(
          message.tool_call_id,
        );

        if (existingResult) {
          // Use cached result from database
          filteredMessages.push({
            ...message,
            content: existingResult.result,
          });
        } else {
          // No cached result - run Dual LLM quarantine pattern
          // Dual LLM Quarantine Pattern:
          // 1. Main LLM (privileged) asks multiple choice questions
          // 2. Quarantined LLM sees the untrusted data and answers the questions
          // 3. Main LLM extracts safe information through Q&A
          // 4. Returns a safe summary instead of raw untrusted data
          const dualLlmSubagent = await DualLlmSubagent.create(
            messages,
            message,
            agentId,
            apiKey,
          );
          const safeContent = await dualLlmSubagent.processWithMainAgent();

          // Replace the tool message content with the safe summary
          // Note: The result is automatically saved to database in processWithMainAgent
          filteredMessages.push({
            ...message,
            content: safeContent,
          });
        }
      } else {
        // Dual LLM analysis is disabled - pass through the original message
        filteredMessages.push(message);
      }
    } else {
      filteredMessages.push(message);
    }
  }

  return {
    filteredMessages,
    contextIsTrusted: !hasUntrustedData,
  };
};
