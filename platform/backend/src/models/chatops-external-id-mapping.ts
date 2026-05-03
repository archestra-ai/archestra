import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { ChatOpsExternalIdMapping } from "@/types/chatops-external-id-mapping";

class ChatOpsExternalIdMappingModel {
  static async findByExternalId(
    adapterId: string,
    externalId: string,
  ): Promise<ChatOpsExternalIdMapping | null> {
    const t = schema.chatopsExternalIdMappingTable;
    const [mapping] = await db
      .select()
      .from(t)
      .where(and(eq(t.adapterId, adapterId), eq(t.externalId, externalId)))
      .limit(1);
    return mapping ?? null;
  }

  static async findByUserId(
    userId: string,
  ): Promise<ChatOpsExternalIdMapping[]> {
    const t = schema.chatopsExternalIdMappingTable;
    return db.select().from(t).where(eq(t.userId, userId));
  }

  static async create(params: {
    adapterId: string;
    externalId: string;
    userId: string;
  }): Promise<ChatOpsExternalIdMapping> {
    const t = schema.chatopsExternalIdMappingTable;
    const [mapping] = await db
      .insert(t)
      .values({
        id: crypto.randomUUID(),
        adapterId: params.adapterId,
        externalId: params.externalId,
        userId: params.userId,
      })
      .returning();
    logger.debug(
      {
        adapterId: params.adapterId,
        externalId: params.externalId,
        userId: params.userId,
      },
      "ChatOpsExternalIdMappingModel.create: created mapping",
    );
    return mapping;
  }

  static async deleteById(id: string): Promise<boolean> {
    const t = schema.chatopsExternalIdMappingTable;
    const deleted = await db.delete(t).where(eq(t.id, id)).returning();
    return deleted.length > 0;
  }

  static async upsert(params: {
    adapterId: string;
    externalId: string;
    userId: string;
  }): Promise<ChatOpsExternalIdMapping> {
    const t = schema.chatopsExternalIdMappingTable;
    const [mapping] = await db
      .insert(t)
      .values({
        id: crypto.randomUUID(),
        adapterId: params.adapterId,
        externalId: params.externalId,
        userId: params.userId,
      })
      .onConflictDoUpdate({
        target: [t.adapterId, t.externalId],
        set: { userId: sql`excluded.user_id` },
      })
      .returning();
    logger.debug(
      {
        adapterId: params.adapterId,
        externalId: params.externalId,
        userId: params.userId,
      },
      "ChatOpsExternalIdMappingModel.upsert: upserted mapping",
    );
    return mapping;
  }
}

export default ChatOpsExternalIdMappingModel;
