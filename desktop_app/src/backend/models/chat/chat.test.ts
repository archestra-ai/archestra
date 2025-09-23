import { eq } from 'drizzle-orm';

import db from '@backend/database';
import { chatsTable } from '@backend/database/schema/chat';
import { messagesTable } from '@backend/database/schema/messages';
import ChatModel from '@backend/models/chat';
import WebSocketService from '@backend/websocket';

// Only mock WebSocket service
vi.mock('@backend/websocket');
vi.mock('@backend/utils/logger');

describe('ChatModel', () => {
  describe('updateTokenUsage', () => {
    let testChatId: number;
    let testSessionId: string;

    beforeEach(async () => {
      // Clear any existing test data
      await db.delete(messagesTable);
      await db.delete(chatsTable);

      // Create a test chat
      const [chat] = await db
        .insert(chatsTable)
        .values({
          sessionId: 'test-session-' + Date.now(),
          title: 'Test Chat',
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
        })
        .returning();

      testChatId = chat.id;
      testSessionId = chat.sessionId;

      // Clear WebSocket mock
      vi.clearAllMocks();
    });

    afterEach(async () => {
      // Clean up test data
      if (testChatId) {
        await db.delete(chatsTable).where(eq(chatsTable.id, testChatId));
      }
    });

    it('should update/replace token usage values', async () => {
      // First update with initial values
      await ChatModel.updateTokenUsage(testSessionId, {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        model: 'gpt-4',
        contextWindow: 8192,
      });

      // Fetch the chat to verify first update
      let [updatedChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, testChatId));

      expect(updatedChat.totalPromptTokens).toBe(100);
      expect(updatedChat.totalCompletionTokens).toBe(50);
      expect(updatedChat.totalTokens).toBe(150);
      expect(updatedChat.lastModel).toBe('gpt-4');
      expect(updatedChat.lastContextWindow).toBe(8192);

      // Second update with different values - should replace, not add
      await ChatModel.updateTokenUsage(testSessionId, {
        promptTokens: 200,
        completionTokens: 75,
        totalTokens: 275,
        model: 'claude-3',
        contextWindow: 16384,
      });

      // Fetch the chat again to verify second update
      [updatedChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, testChatId));

      // Values should be replaced (200, 75, 275), not added (300, 125, 425)
      expect(updatedChat.totalPromptTokens).toBe(200);
      expect(updatedChat.totalCompletionTokens).toBe(75);
      expect(updatedChat.totalTokens).toBe(275);
      expect(updatedChat.lastModel).toBe('claude-3');
      expect(updatedChat.lastContextWindow).toBe(16384);
    });

    it('should handle missing optional token values with defaults', async () => {
      await ChatModel.updateTokenUsage(testSessionId, {
        totalTokens: 100,
        model: 'gpt-3.5-turbo',
      });

      const [updatedChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, testChatId));

      expect(updatedChat.totalPromptTokens).toBe(0); // Default to 0 when not provided
      expect(updatedChat.totalCompletionTokens).toBe(0); // Default to 0 when not provided
      expect(updatedChat.totalTokens).toBe(100);
      expect(updatedChat.lastModel).toBe('gpt-3.5-turbo');
      expect(updatedChat.lastContextWindow).toBeNull(); // No value provided
    });

    it('should not update if totalTokens is missing', async () => {
      // Get initial state
      const [initialChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, testChatId));

      // Call without totalTokens
      await ChatModel.updateTokenUsage(testSessionId, {
        promptTokens: 100,
        completionTokens: 50,
        model: 'gpt-4',
      });

      // Chat should remain unchanged
      const [unchangedChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, testChatId));

      expect(unchangedChat.totalPromptTokens).toBe(initialChat.totalPromptTokens);
      expect(unchangedChat.totalCompletionTokens).toBe(initialChat.totalCompletionTokens);
      expect(unchangedChat.totalTokens).toBe(initialChat.totalTokens);
      expect(unchangedChat.lastModel).toBe(initialChat.lastModel);
    });

    it('should not update if tokenUsage is falsy', async () => {
      // Get initial state
      const [initialChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, testChatId));

      // Call with null/undefined
      await ChatModel.updateTokenUsage(testSessionId, null as any);

      // Chat should remain unchanged
      const [unchangedChat] = await db.select().from(chatsTable).where(eq(chatsTable.id, testChatId));

      expect(unchangedChat.totalPromptTokens).toBe(initialChat.totalPromptTokens);
      expect(unchangedChat.totalCompletionTokens).toBe(initialChat.totalCompletionTokens);
      expect(unchangedChat.totalTokens).toBe(initialChat.totalTokens);
    });

    it('should handle chat not found gracefully', async () => {
      const nonExistentSessionId = 'non-existent-session-id';

      // This should not throw, just log an error (which is mocked)
      await expect(
        ChatModel.updateTokenUsage(nonExistentSessionId, {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        })
      ).resolves.not.toThrow();
    });

    it('should broadcast token usage update via WebSocket', async () => {
      const mockBroadcast = vi.fn();
      vi.mocked(WebSocketService).broadcast = mockBroadcast;

      await ChatModel.updateTokenUsage(testSessionId, {
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        model: 'gpt-4',
        contextWindow: 8192,
      });

      expect(mockBroadcast).toHaveBeenCalledWith({
        type: 'chat-token-usage-updated',
        payload: {
          chatId: testChatId,
          totalPromptTokens: 200,
          totalCompletionTokens: 100,
          totalTokens: 300,
          lastModel: 'gpt-4',
          lastContextWindow: 8192,
          contextUsagePercent: (300 / 8192) * 100,
        },
      });
    });
  });
});
