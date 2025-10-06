import crypto from "node:crypto";
import type OpenAI from "openai";
import type { z } from "zod";
import { AgentModel, ChatModel, InteractionModel, ToolModel } from "@/models";
import type { Chat, ErrorResponseSchema } from "@/types";
import type {
  ChatCompletionRequestMessages,
  ChatCompletionRequestTools,
  ChatCompletionsHeadersSchema,
} from "../types";

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
    "user-agent": userAgentHeader,
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
    const agent = await AgentModel.ensureDefaultAgentExists(userAgentHeader);
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
  message: ChatCompletionRequestMessages[number],
  chatId: string,
) => {
  if (message.role === "user") {
    await InteractionModel.create({
      chatId,
      content: message,
      trusted: true,
    });
  }
};

export const persistAssistantMessage = async (
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
  chatId: string,
) => {
  await InteractionModel.create({ chatId, content: message, trusted: true });
};

/**
 * Persist tools if present in the request
 */
export const persistTools = async (
  tools: ChatCompletionRequestTools,
  agentId: string,
) => {
  for (const tool of tools || []) {
    let toolName = "";
    let toolParameters: Record<string, unknown> | undefined;
    let toolDescription: string | undefined;

    if (tool.type === "function") {
      toolName = tool.function.name;
      toolParameters = tool.function.parameters;
      toolDescription = tool.function.description;
    } else {
      toolName = tool.custom.name;
      toolParameters = tool.custom.format;
      toolDescription = tool.custom.description;
    }

    await ToolModel.createToolIfNotExists({
      agentId,
      name: toolName,
      parameters: toolParameters,
      description: toolDescription,
    });
  }
};

export * as streaming from "./streaming";
export * as toolInvocation from "./tool-invocation";
export * as trustedData from "./trusted-data";
