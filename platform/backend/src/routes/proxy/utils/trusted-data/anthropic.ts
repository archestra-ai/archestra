import {
  DualLlmConfigModel,
  DualLlmResultModel,
  TrustedDataPolicyModel,
} from "@/models";
import type { Anthropic } from "@/types";

// TODO: Uncomment when dual-llm is implemented for Anthropic
// import { DualLlmSubagent } from "../dual-llm-subagent";

type Messages = Anthropic.Types.MessagesRequest["messages"];

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_use_id
 *
 * We need to do this because the name of the tool is not included in the "tool_result" content block
 * (just the content and tool_use_id)
 */
const extractToolNameFromMessages = (
  messages: Messages,
  toolUseId: string,
): string | null => {
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
};

/**
 * Evaluate if context is trusted and filter messages based on trusted data policies
 * Dynamically evaluates and redacts blocked tool results
 * Returns both the filtered messages and whether the context is trusted
 */
export const evaluateIfContextIsTrusted = async (
  messages: Messages,
  agentId: string,
  _apiKey: string,
): Promise<{
  filteredMessages: Messages;
  contextIsTrusted: boolean;
}> => {
  /**
   * TODO: dual-llm doesn't yet work with anthropic
   * Load dual LLM configuration to check if analysis is enabled
   */
  const dualLlmConfig = await DualLlmConfigModel.getDefault();
  const filteredMessages: Messages = [];
  let hasUntrustedData = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // In Anthropic, tool results are in user messages with tool_result content blocks
    if (
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.length > 0
    ) {
      const updatedContentBlocks = [];

      for (const contentBlock of message.content) {
        if (contentBlock.type === "tool_result") {
          const { tool_use_id: toolUseId, content } = contentBlock;
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
          const toolName = extractToolNameFromMessages(messages, toolUseId);

          if (toolName) {
            // Evaluate trusted data policy dynamically
            const { isTrusted, isBlocked, shouldSanitizeWithDualLlm, reason } =
              await TrustedDataPolicyModel.evaluate(
                agentId,
                toolName,
                toolResult,
              );

            if (!isTrusted) {
              hasUntrustedData = true;
            }

            if (isBlocked) {
              updatedContentBlocks.push({
                ...contentBlock,
                content: `[Content blocked by policy${reason ? `: ${reason}` : ""}]`,
              });
            } else if (shouldSanitizeWithDualLlm) {
              // First, check if this tool call has already been analyzed
              const existingResult =
                await DualLlmResultModel.findByToolCallId(toolUseId);

              if (existingResult) {
                // Use cached result from database
                updatedContentBlocks.push({
                  ...contentBlock,
                  content: existingResult.result,
                });
              } else {
                /**
                 * No cached result - run Dual LLM quarantine pattern
                 * Note: This requires adapting the DualLlmSubagent to work with Anthropic format
                 * For now, we'll use the original content until dual-llm is fully implemented for Anthropic
                 */
                // const dualLlmSubagent = await DualLlmSubagent.create(
                //   messages,
                //   contentBlock,
                //   agentId,
                //   apiKey,
                // );
                // updatedContentBlocks.push({
                //   ...contentBlock,
                //   content: await dualLlmSubagent.processWithMainAgent(),
                // });

                // TODO: temporary -- Just pass through until dual-llm is implemented for Anthropic
                updatedContentBlocks.push(contentBlock);
              }
            } else {
              updatedContentBlocks.push(contentBlock);
            }
          } else {
            // If we can't find the tool name, mark as untrusted
            hasUntrustedData = true;
            updatedContentBlocks.push(contentBlock);
          }
        } else {
          // Non-tool-result content blocks pass through unchanged
          updatedContentBlocks.push(contentBlock);
        }
      }

      filteredMessages.push({
        ...message,
        content: updatedContentBlocks,
      });
    } else {
      // Non-user messages or non-array content pass through unchanged
      filteredMessages.push(message);
    }
  }

  return {
    filteredMessages,
    contextIsTrusted: !hasUntrustedData,
  };
};
