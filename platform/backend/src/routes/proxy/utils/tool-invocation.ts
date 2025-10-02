import type OpenAI from "openai";
import type { z } from "zod";
import { ToolInvocationPolicyModel } from "../../../models";
import type { ErrorResponseSchema } from "../../../types";

export const evaluatePolicies = async (
  { tool_calls: toolCalls }: OpenAI.Chat.Completions.ChatCompletionMessage,
  agentId: string,
): Promise<null | z.infer<typeof ErrorResponseSchema>> => {
  if (toolCalls && toolCalls.length > 0) {
    // Intercept and evaluate tool calls
    for (const toolCall of toolCalls) {
      // Only process function tool calls (not custom tool calls)
      if (toolCall.type === "function") {
        const {
          function: { arguments: toolCallArgs, name: toolCallName },
        } = toolCall;

        // Skip if arguments are empty (can happen during streaming assembly)
        if (!toolCallArgs || toolCallArgs.trim() === "") {
          continue;
        }

        const toolInput = JSON.parse(toolCallArgs);

        console.log(
          `Evaluating tool call: ${toolCallName} with input: ${JSON.stringify(toolInput)}`,
        );

        // Evaluate tool invocation policy
        const { isAllowed, denyReason } =
          await ToolInvocationPolicyModel.evaluateForAgent(
            agentId,
            toolCallName,
            toolInput,
          );

        console.log(
          `Tool evaluation result: ${isAllowed} with deny reason: ${denyReason}`,
        );

        if (!isAllowed) {
          // Block this tool call
          return {
            error: {
              message: denyReason,
              type: "tool_invocation_blocked",
            },
          };
        }
      }
    }
  }

  return null;
};
