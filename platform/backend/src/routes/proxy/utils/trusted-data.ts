import { InteractionModel, TrustedDataPolicyModel } from "../../../models";
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
  const interactions = await InteractionModel.findByChatId(chatId);

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
  agentId: string,
) => {
  for (const message of messages) {
    if (message.role === "tool") {
      const { tool_call_id: toolCallId, content } = message;
      const toolResult =
        typeof content === "string" ? JSON.parse(content) : content;

      // Extract tool name from conversation history
      const toolName = await extractToolNameFromHistory(chatId, toolCallId);

      if (toolName) {
        // Evaluate trusted data policy
        const { isTrusted, trustReason } =
          await TrustedDataPolicyModel.evaluate(agentId, toolName, toolResult);

        // Store tool result as interaction (tainted if not trusted)
        await InteractionModel.create({
          chatId,
          content: message,
          tainted: !isTrusted,
          taintReason: trustReason,
        });
      }
    }
  }
};
