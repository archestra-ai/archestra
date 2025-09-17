import { type UIMessage } from 'ai';
import { eq } from 'drizzle-orm';

import db from '@backend/database';
import { messagesTable } from '@backend/database/schema/messages';

export default class MessageModel {
  static async updateContent(messageId: number, content: UIMessage): Promise<void> {
    db.update(messagesTable).set({ content }).where(eq(messagesTable.id, messageId));
  }
}
