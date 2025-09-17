import type { UIMessage } from 'ai';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import db from '@backend/database';
import { chatsTable } from '@backend/database/schema/chat';
import { messagesTable } from '@backend/database/schema/messages';

import MessageModel from './index';

describe('MessageModel', () => {
  describe('updateContent', () => {
    let testChatId: number;

    beforeEach(async () => {
      // Clean up any existing test data
      db.delete(chatsTable)
        .where(sql`title = 'Test Chat for Messages'`)
        .run();

      // Create a test chat
      const result = db
        .insert(chatsTable)
        .values({
          title: 'Test Chat for Messages',
        })
        .returning({ id: chatsTable.id })
        .get();

      testChatId = result.id;
    });

    it('should update content for user message with matching id', async () => {
      const messageId = 'hZkwBiS0Sezws5dg';
      const originalContent = {
        parts: [{ type: 'text', text: 'Original message' }],
        id: messageId,
        role: 'user',
      };

      // Insert original message
      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'user',
          content: originalContent as UIMessage,
        })
        .run();

      // Update the content
      const updatedContent = {
        parts: [{ type: 'text', text: 'Updated message' }],
        id: messageId,
        role: 'user',
      };

      await MessageModel.updateContent(messageId, updatedContent as UIMessage);

      // Verify the update
      const result = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
        .get();

      expect(result).toBeDefined();
      expect(result?.content).toEqual(updatedContent);
      expect((result?.content as any).parts[0].text).toBe('Updated message');
    });

    it('should update content for system message with matching id', async () => {
      const messageId = 'system-prompt';
      const originalContent = {
        id: messageId,
        role: 'system',
        parts: [
          {
            type: 'text',
            text: 'Original system message',
          },
        ],
      };

      // Insert original message
      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'system',
          content: originalContent as UIMessage,
        })
        .run();

      // Update the content
      const updatedContent = {
        id: messageId,
        role: 'system',
        parts: [
          {
            type: 'text',
            text: 'Updated system message',
          },
        ],
      };

      await MessageModel.updateContent(messageId, updatedContent as UIMessage);

      // Verify the update
      const result = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
        .get();

      expect(result).toBeDefined();
      expect(result?.content).toEqual(updatedContent);
      expect((result?.content as any).parts[0].text).toBe('Updated system message');
    });

    it('should handle assistant message with empty id', async () => {
      // Assistant messages often have empty id initially
      const originalContent = {
        id: '',
        role: 'assistant',
        parts: [
          {
            type: 'step-start',
          },
          {
            type: 'text',
            text: 'Original assistant response',
            providerMetadata: {
              openai: {
                itemId: 'item_123',
              },
            },
            state: 'done',
          },
        ],
      };

      // Insert original message
      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'assistant',
          content: originalContent as UIMessage,
        })
        .run();

      // Update the content - using empty string as messageId to match
      const updatedContent = {
        id: '',
        role: 'assistant',
        parts: [
          {
            type: 'step-start',
          },
          {
            type: 'text',
            text: 'Updated assistant response',
            providerMetadata: {
              openai: {
                itemId: 'item_123',
              },
            },
            state: 'done',
          },
        ],
      };

      await MessageModel.updateContent('', updatedContent as UIMessage);

      // Verify the update
      const result = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ''`)
        .get();

      expect(result).toBeDefined();
      expect(result?.content).toEqual(updatedContent);
      expect((result?.content as any).parts[1].text).toBe('Updated assistant response');
    });

    it('should handle messages with multiple parts', async () => {
      const messageId = 'message-123';
      const originalContent = {
        parts: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
          { type: 'text', text: 'Part 3' },
        ],
        id: messageId,
        role: 'assistant',
      };

      // Insert original message
      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'assistant',
          content: originalContent as UIMessage,
        })
        .run();

      // Update the content
      const updatedContent = {
        parts: [
          { type: 'text', text: 'Updated Part 1' },
          { type: 'text', text: 'Updated Part 2' },
          { type: 'text', text: 'Updated Part 3' },
        ],
        id: messageId,
        role: 'assistant',
      };

      await MessageModel.updateContent(messageId, updatedContent as UIMessage);

      // Verify the update - should query based on $.id
      const result = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
        .get();

      expect(result).toBeDefined();
      expect(result?.content).toEqual(updatedContent);
      expect((result?.content as any).parts[0].text).toBe('Updated Part 1');
      expect((result?.content as any).parts[1].text).toBe('Updated Part 2');
      expect((result?.content as any).parts[2].text).toBe('Updated Part 3');
    });

    it('should handle special characters in messageId', async () => {
      const messageId = 'test\'message"with-special_chars!@#$';
      const originalContent = {
        parts: [{ type: 'text', text: 'Original' }],
        id: messageId,
        role: 'user',
      };

      // Insert original message
      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'user',
          content: originalContent as UIMessage,
        })
        .run();

      // Update the content
      const updatedContent = {
        parts: [{ type: 'text', text: 'Updated with special chars' }],
        id: messageId,
        role: 'user',
      };

      await MessageModel.updateContent(messageId, updatedContent as UIMessage);

      // Verify the update - parameterized queries should handle special characters safely
      const result = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
        .get();

      expect(result).toBeDefined();
      expect(result?.content).toEqual(updatedContent);
      expect((result?.content as any).parts[0].text).toBe('Updated with special chars');
    });

    it('should not update messages when id does not match', async () => {
      const messageId = 'message-to-update';
      const differentId = 'different-message-id';

      // Insert a message with a different id
      const originalContent = {
        parts: [{ type: 'text', text: 'Should not be updated' }],
        id: differentId,
        role: 'user',
      };

      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'user',
          content: originalContent as UIMessage,
        })
        .run();

      // Try to update with a non-matching messageId
      const updatedContent = {
        parts: [{ type: 'text', text: 'This should not be saved' }],
        id: messageId,
        role: 'user',
      };

      await MessageModel.updateContent(messageId, updatedContent as UIMessage);

      // Verify the original message was not updated
      const result = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${differentId}`)
        .get();

      expect(result).toBeDefined();
      expect((result?.content as any).parts[0].text).toBe('Should not be updated');

      // Verify no message exists with the messageId we tried to update
      const noResult = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
        .get();

      expect(noResult).toBeUndefined();
    });

    it('should update only the matching message when multiple messages exist', async () => {
      const messageId1 = 'message-1';
      const messageId2 = 'message-2';

      // Insert multiple messages
      const content1 = {
        parts: [{ type: 'text', text: 'Message 1' }],
        id: messageId1,
        role: 'user',
      };

      const content2 = {
        parts: [{ type: 'text', text: 'Message 2' }],
        id: messageId2,
        role: 'user',
      };

      db.insert(messagesTable)
        .values([
          { chatId: testChatId, role: 'user', content: content1 as UIMessage },
          { chatId: testChatId, role: 'user', content: content2 as UIMessage },
        ])
        .run();

      // Update only message 2
      const updatedContent2 = {
        parts: [{ type: 'text', text: 'Updated Message 2' }],
        id: messageId2,
        role: 'user',
      };

      await MessageModel.updateContent(messageId2, updatedContent2 as UIMessage);

      // Verify message 1 is unchanged
      const result1 = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId1}`)
        .get();

      expect(result1).toBeDefined();
      expect((result1?.content as any).parts[0].text).toBe('Message 1');

      // Verify message 2 is updated
      const result2 = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId2}`)
        .get();

      expect(result2).toBeDefined();
      expect((result2?.content as any).parts[0].text).toBe('Updated Message 2');
    });
  });

  describe('delete', () => {
    let testChatId: number;

    beforeEach(async () => {
      // Clean up any existing test data
      db.delete(chatsTable)
        .where(sql`title = 'Test Chat for Delete'`)
        .run();

      // Create a test chat
      const result = db
        .insert(chatsTable)
        .values({
          title: 'Test Chat for Delete',
        })
        .returning({ id: chatsTable.id })
        .get();

      testChatId = result.id;
    });

    it('should delete message with matching id', async () => {
      const messageId = 'message-to-delete';
      const content = {
        parts: [{ type: 'text', text: 'Message to be deleted' }],
        id: messageId,
        role: 'user',
      };

      // Insert message
      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'user',
          content: content as UIMessage,
        })
        .run();

      // Verify message exists
      const beforeDelete = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
        .get();

      expect(beforeDelete).toBeDefined();

      // Delete the message
      await MessageModel.delete(messageId);

      // Verify message is deleted
      const afterDelete = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
        .get();

      expect(afterDelete).toBeUndefined();
    });

    it('should not delete messages with different id', async () => {
      const messageToDelete = 'delete-this';
      const messageToKeep = 'keep-this';

      const content1 = {
        parts: [{ type: 'text', text: 'Delete me' }],
        id: messageToDelete,
        role: 'user',
      };

      const content2 = {
        parts: [{ type: 'text', text: 'Keep me' }],
        id: messageToKeep,
        role: 'user',
      };

      // Insert both messages
      db.insert(messagesTable)
        .values([
          { chatId: testChatId, role: 'user', content: content1 as UIMessage },
          { chatId: testChatId, role: 'user', content: content2 as UIMessage },
        ])
        .run();

      // Delete only the first message
      await MessageModel.delete(messageToDelete);

      // Verify first message is deleted
      const deletedMessage = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageToDelete}`)
        .get();

      expect(deletedMessage).toBeUndefined();

      // Verify second message still exists
      const keptMessage = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageToKeep}`)
        .get();

      expect(keptMessage).toBeDefined();
      expect((keptMessage?.content as any).parts[0].text).toBe('Keep me');
    });

    it('should handle deleting non-existent message', async () => {
      const nonExistentId = 'does-not-exist';

      // Delete non-existent message (should not throw)
      await MessageModel.delete(nonExistentId);

      // Verify no messages were affected
      const allMessages = db
        .select()
        .from(messagesTable)
        .where(sql`${messagesTable.chatId} = ${testChatId}`)
        .all();

      expect(allMessages).toHaveLength(0);
    });

    it('should handle deleting message with empty id', async () => {
      const emptyIdContent = {
        parts: [{ type: 'text', text: 'Message with empty id' }],
        id: '',
        role: 'assistant',
      };

      const normalContent = {
        parts: [{ type: 'text', text: 'Normal message' }],
        id: 'normal-id',
        role: 'user',
      };

      // Insert both messages
      db.insert(messagesTable)
        .values([
          { chatId: testChatId, role: 'assistant', content: emptyIdContent as UIMessage },
          { chatId: testChatId, role: 'user', content: normalContent as UIMessage },
        ])
        .run();

      // Delete message with empty id
      await MessageModel.delete('');

      // Verify message with empty id is deleted
      const emptyIdMessage = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ''`)
        .get();

      expect(emptyIdMessage).toBeUndefined();

      // Verify normal message still exists
      const normalMessage = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = 'normal-id'`)
        .get();

      expect(normalMessage).toBeDefined();
      expect((normalMessage?.content as any).parts[0].text).toBe('Normal message');
    });

    it('should handle special characters in id when deleting', async () => {
      const specialId = 'special\'chars"in-id!@#$';
      const content = {
        parts: [{ type: 'text', text: 'Message with special id' }],
        id: specialId,
        role: 'user',
      };

      // Insert message with special characters in id
      db.insert(messagesTable)
        .values({
          chatId: testChatId,
          role: 'user',
          content: content as UIMessage,
        })
        .run();

      // Delete message with special characters - parameterized queries should handle it safely
      await MessageModel.delete(specialId);

      // Verify message is deleted
      const result = db
        .select()
        .from(messagesTable)
        .where(sql`json_extract(${messagesTable.content}, '$.id') = ${specialId}`)
        .get();

      expect(result).toBeUndefined();
    });

    it('should delete only messages from correct chat', async () => {
      // Create another chat
      const anotherChat = db
        .insert(chatsTable)
        .values({
          title: 'Another Chat',
        })
        .returning({ id: chatsTable.id })
        .get();

      const messageId = 'same-id-different-chats';

      const content = {
        parts: [{ type: 'text', text: 'Message content' }],
        id: messageId,
        role: 'user',
      };

      // Insert same message id in both chats
      db.insert(messagesTable)
        .values([
          { chatId: testChatId, role: 'user', content: content as UIMessage },
          { chatId: anotherChat.id, role: 'user', content: content as UIMessage },
        ])
        .run();

      // Delete message (should delete from both chats since we're matching by content id)
      await MessageModel.delete(messageId);

      // Verify message is deleted from both chats
      const messagesInFirstChat = db
        .select()
        .from(messagesTable)
        .where(
          sql`${messagesTable.chatId} = ${testChatId} AND json_extract(${messagesTable.content}, '$.id') = ${messageId}`
        )
        .get();

      const messagesInSecondChat = db
        .select()
        .from(messagesTable)
        .where(
          sql`${messagesTable.chatId} = ${anotherChat.id} AND json_extract(${messagesTable.content}, '$.id') = ${messageId}`
        )
        .get();

      // Both should be deleted since we're matching by content.id
      expect(messagesInFirstChat).toBeUndefined();
      expect(messagesInSecondChat).toBeUndefined();
    });
  });
});
