import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { z } from "zod";
import { AgentModel, ChatModel, InteractionModel, ToolModel } from "@/models";
import type { Chat, ErrorResponseSchema } from "@/types";
import type {
  ChatCompletionRequestMessages,
  ChatCompletionRequestTools,
  ChatCompletionsHeadersSchema,
} from "../types";

const CHAT_ID_TAG_REGEX = /<archestra_chat_id>([\w-]+)<\/archestra_chat_id>/;

/**
 * Extracts chat ID from system message content if it exists
 */
const extractChatIdFromSystemMessage = (
  content: string | Array<{ type: string; text: string }>,
): string | null => {
  const contentStr =
    typeof content === "string"
      ? content
      : content.find((c) => c.type === "text")?.text || "";
  const match = contentStr.match(CHAT_ID_TAG_REGEX);
  return match ? match[1] : null;
};

/**
 * Embeds chat ID into system message content
 */
const embedChatIdIntoContent = (
  content: string | Array<{ type: string; text: string }>,
  chatId: string,
): string | Array<{ type: "text"; text: string }> => {
  const tag = `<archestra_chat_id>${chatId}</archestra_chat_id>`;

  if (typeof content === "string") {
    return `${content}\n\n${tag}`;
  }

  // For array content, append to the first text part or add a new text part
  const textPart = content.find((c) => c.type === "text");
  if (textPart) {
    return content.map((c) =>
      c.type === "text" && c === textPart
        ? { type: "text" as const, text: `${c.text}\n\n${tag}` }
        : { type: "text" as const, text: c.text },
    );
  }

  return [
    ...content.map((c) => ({ type: "text" as const, text: c.text })),
    { type: "text" as const, text: tag },
  ];
};

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
     * User has not specified a particular chat ID, therefore we'll use system message tagging
     * to track the chat ID across requests
     */
    const agent = await AgentModel.ensureDefaultAgentExists(userAgentHeader);
    agentId = agent.id;

    // Find or create system message
    const systemMessage = messages.find((m) => m.role === "system");

    if (systemMessage) {
      // Extract chat ID from existing system message if present
      const extractedChatId = extractChatIdFromSystemMessage(
        systemMessage.content,
      );

      if (extractedChatId) {
        // Chat ID found in system message - verify it exists
        chat = await ChatModel.findById(extractedChatId);
        if (chat) {
          chatId = extractedChatId;
        } else {
          // Chat ID in message but chat doesn't exist - create new chat with that ID
          chat = await ChatModel.create({ id: extractedChatId, agentId });
          chatId = extractedChatId;
        }
      } else {
        // System message exists but no chat ID - create new chat and embed ID
        chatId = randomUUID();
        chat = await ChatModel.create({ id: chatId, agentId });
        systemMessage.content = embedChatIdIntoContent(
          systemMessage.content,
          chatId,
        );
      }
    } else {
      // No system message - create one with new chat ID
      chatId = randomUUID();
      chat = await ChatModel.create({ id: chatId, agentId });

      const newSystemMessage = {
        role: "system" as const,
        content: `<archestra_chat_id>${chatId}</archestra_chat_id>`,
      };

      messages.unshift(newSystemMessage);
    }
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
