import { type UIMessage } from 'ai';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import db from '@backend/database';
import { SelectChatSchema, chatsTable } from '@backend/database/schema/chat';
import {
  SelectMessagesSchema as DatabaseMessageRepresentationSchema,
  messagesTable,
} from '@backend/database/schema/messages';
import ollamaClient from '@backend/ollama/client';
import toolService from '@backend/services/tool';
import log from '@backend/utils/logger';
import WebSocketService from '@backend/websocket';
import { DEFAULT_ARCHESTRA_TOOLS } from '@constants';

const TransformedMessageSchema = DatabaseMessageRepresentationSchema.extend({
  /**
   * NOTE: id is stored in the database as a number, but we will convert it to a string as such:
   * `${chat.sessionId}-${message.id}`
   */
  id: z.string(),
  /**
   * Content is a UIMessage from the 'ai' SDK
   */
  content: z.custom<UIMessage>(),
});

export const ChatWithMessagesSchema = SelectChatSchema.extend({
  messages: z.array(TransformedMessageSchema),
});

type DatabaseMessage = z.infer<typeof DatabaseMessageRepresentationSchema>;
type TransformedMessage = z.infer<typeof TransformedMessageSchema>;
type Chat = z.infer<typeof SelectChatSchema>;
type ChatWithMessages = z.infer<typeof ChatWithMessagesSchema>;

export default class ChatModel {
  static generateCompositeMessageId = (chat: Chat, message: DatabaseMessage): string =>
    `${chat.sessionId}-${message.id}`;

  /**
   * Get selected tools for a chat
   * @param chatId The chat ID
   * @returns Array of selected tool IDs, or null if all tools are selected
   */
  static async getSelectedTools(chatId: number): Promise<string[] | null> {
    const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.id, chatId)).limit(1);

    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    return chat.selectedTools as string[] | null;
  }

  /**
   * Update selected tools for a chat
   * @param chatId The chat ID
   * @param toolIds Array of tool IDs to set as selected, or null to select all
   */
  static async updateSelectedTools(chatId: number, toolIds: string[] | null): Promise<void> {
    await db
      .update(chatsTable)
      .set({
        selectedTools: toolIds,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chatsTable.id, chatId));

    // Broadcast the update via WebSocket
    WebSocketService.broadcast({
      type: 'chat-tools-updated',
      payload: {
        chatId,
        selectedTools: toolIds,
      },
    });
  }

  /**
   * Add tools to the chat's selection
   * @param chatId The chat ID
   * @param toolIds Array of tool IDs to add
   */
  static async addSelectedTools(chatId: number, toolIds: string[]): Promise<string[]> {
    const currentTools = await this.getSelectedTools(chatId);

    let updatedTools: string[];

    if (currentTools === null) {
      // When null (all tools selected), we need to convert to explicit list
      // Get all available tools and ensure the new ones are included
      const allAvailableTools = toolService.getAllAvailableTools();
      const allToolIds = allAvailableTools.map((tool) => tool.id);

      // Make sure all tools including the new ones are in the list
      const toolSet = new Set([...allToolIds, ...toolIds]);
      updatedTools = Array.from(toolSet);
    } else {
      // Add new tools to existing selection, avoiding duplicates
      const toolSet = new Set([...currentTools, ...toolIds]);
      updatedTools = Array.from(toolSet);
    }

    await this.updateSelectedTools(chatId, updatedTools);
    return updatedTools;
  }

  /**
   * Remove tools from the chat's selection
   * @param chatId The chat ID
   * @param toolIds Array of tool IDs to remove
   */
  static async removeSelectedTools(chatId: number, toolIds: string[]): Promise<string[]> {
    const currentTools = await this.getSelectedTools(chatId);

    let updatedTools: string[];

    if (currentTools === null) {
      // When null (all tools selected), we need to convert to explicit list first
      // then remove the specified tools
      const allAvailableTools = toolService.getAllAvailableTools();
      const allToolIds = allAvailableTools.map((tool) => tool.id);

      // Remove specified tools from the full list
      const toolSet = new Set(allToolIds);
      for (const toolId of toolIds) {
        toolSet.delete(toolId);
      }
      updatedTools = Array.from(toolSet);
    } else {
      // Remove specified tools from existing selection
      const toolSet = new Set(currentTools);
      for (const toolId of toolIds) {
        toolSet.delete(toolId);
      }
      updatedTools = Array.from(toolSet);
    }

    await this.updateSelectedTools(chatId, updatedTools);
    return updatedTools;
  }

  /**
   * Select all available tools for a chat (sets selectedTools to null)
   * @param chatId The chat ID
   */
  static async selectAllTools(chatId: number): Promise<void> {
    await this.updateSelectedTools(chatId, null);
  }

  /**
   * Deselect all tools for a chat (sets selectedTools to empty array)
   * @param chatId The chat ID
   */
  static async deselectAllTools(chatId: number): Promise<void> {
    await this.updateSelectedTools(chatId, []);
  }

  static async conditionallyGenerateAndUpdateChatTitle(
    chatId: number,
    currentTitle: string | null,
    messages: UIMessage[]
  ): Promise<void> {
    const messagesToConsiderForTitle = messages.filter((msg) => msg.role === 'user' || msg.role === 'assistant');

    /**
     * Only generate a title if the chat has no title yet and has 4 messages
     *
     * NOTE: we only consider messages between the user and the LLM (ignore system messages)
     */
    if (currentTitle || messagesToConsiderForTitle.length < 4) {
      return;
    }

    try {
      // Extract text content from the first few messages for title generation
      const messageTexts: string[] = [];

      for (const msg of messagesToConsiderForTitle.slice(0, 4)) {
        // UIMessage has a parts array, extract text from text parts
        let textContent = '';

        if (msg.parts) {
          for (const part of msg.parts) {
            if (part.type === 'text' && part.text) {
              textContent += part.text + ' ';
            }
          }
        }

        if (textContent.trim()) {
          messageTexts.push(`${msg.role}: ${textContent.trim()}`);
        }
      }

      if (messageTexts.length > 0) {
        const title = await ollamaClient.generateChatTitle(messageTexts);

        // Update the chat with the generated title
        await db
          .update(chatsTable)
          .set({
            title,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(chatsTable.id, chatId));

        // Broadcast the title update via WebSocket
        WebSocketService.broadcast({
          type: 'chat-title-updated',
          payload: {
            chatId,
            title,
          },
        });

        log.info(`Generated title for chat ${chatId}: ${title}`);
      }
    } catch (error) {
      log.error(`Failed to generate title for chat ${chatId}:`, error);
      // Don't throw - title generation failure shouldn't break message saving
    }
  }

  static async getAllChats(): Promise<ChatWithMessages[]> {
    const rows = await db
      .select()
      .from(chatsTable)
      .leftJoin(messagesTable, eq(chatsTable.id, messagesTable.chatId))
      .orderBy(desc(chatsTable.createdAt), asc(messagesTable.createdAt)); // Most recent chats first, then messages in order

    // Use a Map for better performance and type safety
    const chatMap = new Map<number, ChatWithMessages>();

    for (const row of rows) {
      const chat = row.chats;
      const message = row.messages;

      if (!chatMap.has(chat.id)) {
        chatMap.set(chat.id, {
          ...chat,
          messages: [],
        });
      }

      if (message) {
        // Content is already a UIMessage, just need to update the id
        const parsedMessage = {
          ...message,
          id: `${chat.sessionId}-${message.id}`,
          content: message.content as UIMessage,
        };
        chatMap.get(chat.id)!.messages.push(parsedMessage);
      }
    }

    // Convert Map to array and sort by createdAt to maintain order
    return Array.from(chatMap.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  static async getChatById(id: number): Promise<ChatWithMessages | null> {
    const rows = await db
      .select()
      .from(chatsTable)
      .leftJoin(messagesTable, eq(chatsTable.id, messagesTable.chatId))
      .where(eq(chatsTable.id, id))
      .orderBy(asc(messagesTable.createdAt)); // Order messages by creation time

    if (rows.length === 0 || !rows[0].chats) {
      return null;
    }

    const chat = rows[0].chats;
    const messages: TransformedMessage[] = [];

    for (const row of rows) {
      if (row.messages) {
        messages.push({
          ...row.messages,
          id: this.generateCompositeMessageId(chat, row.messages),
          content: row.messages.content as UIMessage,
        });
      }
    }

    return {
      ...chat,
      messages,
    };
  }

  static async createChat(): Promise<ChatWithMessages> {
    // The sessionId is auto-generated by SQLite using the UUID expression
    // defined in the schema (see chat.ts schema file)
    const [chat] = await db
      .insert(chatsTable)
      .values({
        // Set default tools for new chats (excluding delete_memory and disable_tools)
        selectedTools: DEFAULT_ARCHESTRA_TOOLS,
      })
      .returning(); // SQLite returns the inserted row

    return {
      ...chat,
      messages: [],
    };
  }

  static async updateChat(id: number, data: { title?: string | null }): Promise<ChatWithMessages | null> {
    // First check if the chat exists
    const chat = await this.getChatById(id);
    if (!chat) {
      return null; // Will trigger 404 in the route handler
    }

    const [updatedChat] = await db
      .update(chatsTable)
      .set({
        title: data.title,
        // Manually update the timestamp since SQLite doesn't have ON UPDATE
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chatsTable.id, id))
      .returning();

    return {
      ...updatedChat,
      messages: chat.messages, // Keep existing messages
    };
  }

  static async deleteChat(id: number): Promise<void> {
    // Note: Related chat_interactions will be cascade deleted
    // when that table is added (foreign key constraint)
    await db.delete(chatsTable).where(eq(chatsTable.id, id));
  }

  static async updateTokenUsage(
    sessionId: string,
    tokenUsage: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      model?: string;
      contextWindow?: number;
    }
  ): Promise<void> {
    if (!tokenUsage || !tokenUsage.totalTokens) {
      return;
    }

    // Find the chat by session ID
    const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.sessionId, sessionId)).limit(1);

    if (!chat) {
      log.error(`Chat not found for session ID: ${sessionId}`);
      return;
    }

    log.info(`Updating token usage for chat ${chat.id}: ${JSON.stringify(tokenUsage)}`);

    // Update the chat with cumulative token usage
    await db
      .update(chatsTable)
      .set({
        totalPromptTokens: sql`COALESCE(total_prompt_tokens, 0) + ${tokenUsage.promptTokens || 0}`,
        totalCompletionTokens: sql`COALESCE(total_completion_tokens, 0) + ${tokenUsage.completionTokens || 0}`,
        totalTokens: sql`COALESCE(total_tokens, 0) + ${tokenUsage.totalTokens || 0}`,
        lastModel: tokenUsage.model,
        lastContextWindow: tokenUsage.contextWindow,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chatsTable.id, chat.id));

    // Broadcast token usage update
    const [updatedChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, chat.id)).limit(1);

    if (updatedChat) {
      WebSocketService.broadcast({
        type: 'chat-token-usage-updated',
        payload: {
          chatId: chat.id,
          totalPromptTokens: updatedChat.totalPromptTokens,
          totalCompletionTokens: updatedChat.totalCompletionTokens,
          totalTokens: updatedChat.totalTokens,
          lastModel: updatedChat.lastModel,
          lastContextWindow: updatedChat.lastContextWindow,
          contextUsagePercent:
            updatedChat.lastContextWindow && updatedChat.totalTokens
              ? (updatedChat.totalTokens / updatedChat.lastContextWindow) * 100
              : 0,
        },
      });
    }
  }

  static async saveMessages(sessionId: string, messages: UIMessage[]): Promise<void> {
    // First, find the chat by session ID
    const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.sessionId, sessionId)).limit(1);

    if (!chat) {
      log.error(`Chat not found for session ID: ${sessionId}`);
      return;
    }

    // Clear existing messages for this chat to avoid duplicates
    await db.delete(messagesTable).where(eq(messagesTable.chatId, chat.id));

    // Save each message with an explicit timestamp to preserve order
    const now = Date.now();
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      // Add a small offset to each message timestamp to preserve order
      const timestamp = new Date(now + i).toISOString();

      await db.insert(messagesTable).values({
        chatId: chat.id,
        role: message.role,
        content: message, // Store the entire UIMessage
        createdAt: timestamp, // Explicit timestamp with order preservation
      });
    }

    await this.conditionallyGenerateAndUpdateChatTitle(chat.id, chat.title, messages);
  }
}
