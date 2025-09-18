import { type UIMessage } from 'ai';
import { sql } from 'drizzle-orm';

import db from '@backend/database';
import { messagesTable } from '@backend/database/schema/messages';

export default class MessageModel {
  static async updateContent(messageId: string, content: UIMessage): Promise<void> {
    db.update(messagesTable)
      .set({ content })
      .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
      .run();
  }

  static async delete(messageId: string): Promise<void> {
    db.delete(messagesTable)
      .where(sql`json_extract(${messagesTable.content}, '$.id') = ${messageId}`)
      .run();
  }
}
