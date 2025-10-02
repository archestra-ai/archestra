import type OpenAI from "openai";
import { ToolInvocationPolicyModel } from "../../../models";

/**
 * This method will evaluate whether, based on the tool invocation policies assigned to the specified agent,
 * if the tool call is allowed or blocked.
 *
 * If this method returns non-null it is because the tool call was blocked and we are returning a refusal message
 * (in the format of an assistant message with a refusal)
 */
export const evaluatePolicies = async (
  { tool_calls: toolCalls }: OpenAI.Chat.Completions.ChatCompletionMessage,
  agentId: string,
): Promise<null | OpenAI.Chat.Completions.ChatCompletion.Choice> => {
  if (toolCalls && toolCalls.length > 0) {
    // Intercept and evaluate tool calls
    for (const toolCall of toolCalls) {
      let toolCallName = "";
      let toolCallArgs = "";

      if (toolCall.type === "function") {
        toolCallName = toolCall.function.name;
        toolCallArgs = toolCall.function.arguments;
      } else {
        toolCallName = toolCall.custom.name;
        toolCallArgs = toolCall.custom.input;
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
        return {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          message: {
            role: "assistant",
            refusal: `I tried to invoke the ${toolCallName} tool with the following arguments: ${JSON.stringify(toolInput)}. However, I was denied by a tool invocation policy.`,
            content: null,
          },
        };
      }
    }
  }

  return null;
};
