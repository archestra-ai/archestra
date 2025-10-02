import crypto from "node:crypto";
import type OpenAI from "openai";
import type { z } from "zod";
import {
  AgentModel,
  ChatModel,
  InteractionModel,
  ToolInvocationPolicyModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "../../models";
import type { Chat, ErrorResponseSchema } from "../../types";
import type {
  ChatCompletionRequestMessages,
  ChatCompletionRequestTools,
  ChatCompletionsHeadersSchema,
} from "./types";

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
        /**
         * TODO: do we need to handle custom tool calls here as well?
         */
        if (toolCall.id === toolCallId && toolCall.type === "function") {
          return toolCall.function.name;
        }
      }
    }
  }

  return null;
};

/**
 * We need to explicitly get the first user message
 * (because if there is a system message it may be consistent across multiple chats and we'll end up with the same hash)
 */
const generateChatIdHashFromRequest = (
  messages: ChatCompletionRequestMessages,
) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(messages.find((message) => message.role === "user")))
    .digest("hex");

export const getAgentAndChatIdFromRequest = async (
  messages: ChatCompletionRequestMessages,
  {
    "x-archestra-chat-id": chatIdHeader,
  }: z.infer<typeof ChatCompletionsHeadersSchema>,
): Promise<
  { chatId: string; agentId: string } | z.infer<typeof ErrorResponseSchema>
> => {
  let chatId = chatIdHeader;
  let agentId: string | undefined;
  let chat: Chat | null = null;

  if (chatId) {
    /**
     * User has specified a particular chat ID, therefore let's first get the chat and then get the agent ID
     * associated with that chat
     */

    // Validate chat exists and get agent ID
    chat = await ChatModel.findById(chatId);
    if (!chat) {
      return {
        error: {
          message: `Specified chat ID ${chatId} not found`,
          type: "not_found",
        },
      };
    }

    agentId = chat.agentId;
  } else {
    /**
     * User has not specified a particular chat ID, therefore let's first create or get the
     * "first" agent, and then we will take a hash of the first chat message to create a new chat ID
     */
    const agent = await AgentModel.ensureDefaultAgentExists();
    agentId = agent.id;

    // Create or get chat
    chat = await ChatModel.createOrGetByHash({
      agentId,
      hashForId: generateChatIdHashFromRequest(messages), // Generate chat ID hash from request
    });
    chatId = chat.id;
  }

  return { chatId, agentId };
};

export const persistUserMessage = async (
  messages: ChatCompletionRequestMessages,
  chatId: string,
) => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage.role === "user") {
    await InteractionModel.create({ chatId, content: lastMessage });
  }
};

export const persistAssistantMessage = async (
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
  chatId: string,
) => {
  await InteractionModel.create({ chatId, content: message });
};

/**
 * Persist tools if present in the request
 *
 * NOTE: for right now we are only persisting function tools (not custom tools)
 */
export const persistTools = async (
  tools: ChatCompletionRequestTools,
  agentId: string,
) => {
  const functionTools = tools?.filter((tool) => tool.type === "function") || [];
  for (const {
    function: { name, parameters, description },
  } of functionTools) {
    await ToolModel.createToolIfNotExists({
      agentId,
      name,
      parameters,
      description,
    });
  }
};

export const evaluateTrustedDataPolicies = async (
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
          await TrustedDataPolicyModel.evaluateForAgent(
            agentId,
            toolName,
            toolResult,
          );

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

export const evaluateToolInvocationPolicies = async (
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
