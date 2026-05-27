import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";

type ChatAttachment = typeof schema.chatAttachmentsTable.$inferSelect;
type ChatAttachmentInsert = typeof schema.chatAttachmentsTable.$inferInsert;

const metadataColumns = {
  id: schema.chatAttachmentsTable.id,
  organizationId: schema.chatAttachmentsTable.organizationId,
  conversationId: schema.chatAttachmentsTable.conversationId,
  uploadedByUserId: schema.chatAttachmentsTable.uploadedByUserId,
  originalName: schema.chatAttachmentsTable.originalName,
  mimeType: schema.chatAttachmentsTable.mimeType,
  fileSize: schema.chatAttachmentsTable.fileSize,
  contentHash: schema.chatAttachmentsTable.contentHash,
  textPreview: schema.chatAttachmentsTable.textPreview,
  textPreviewStatus: schema.chatAttachmentsTable.textPreviewStatus,
  createdAt: schema.chatAttachmentsTable.createdAt,
  deletedAt: schema.chatAttachmentsTable.deletedAt,
} as const;

class ChatAttachmentModel {
  static async create(
    params: Omit<ChatAttachmentInsert, "id" | "createdAt" | "deletedAt">,
  ): Promise<ChatAttachment> {
    const [result] = await db
      .insert(schema.chatAttachmentsTable)
      .values(params)
      .returning();
    return result;
  }

  static async findById(
    id: string,
  ): Promise<Omit<ChatAttachment, "fileData"> | null> {
    const [result] = await db
      .select(metadataColumns)
      .from(schema.chatAttachmentsTable)
      .where(
        and(
          eq(schema.chatAttachmentsTable.id, id),
          isNull(schema.chatAttachmentsTable.deletedAt),
        ),
      );
    return result ?? null;
  }

  static async findByIdWithData(id: string): Promise<ChatAttachment | null> {
    const [result] = await db
      .select()
      .from(schema.chatAttachmentsTable)
      .where(
        and(
          eq(schema.chatAttachmentsTable.id, id),
          isNull(schema.chatAttachmentsTable.deletedAt),
        ),
      );
    return result ? normalizeFileData(result) : null;
  }

  static async findByIdsWithData(ids: string[]): Promise<ChatAttachment[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select()
      .from(schema.chatAttachmentsTable)
      .where(
        and(
          inArray(schema.chatAttachmentsTable.id, ids),
          isNull(schema.chatAttachmentsTable.deletedAt),
        ),
      );
    return rows.map(normalizeFileData);
  }

  static async findByConversationAndContentHash(
    conversationId: string,
    contentHash: string,
  ): Promise<Omit<ChatAttachment, "fileData"> | null> {
    const [result] = await db
      .select(metadataColumns)
      .from(schema.chatAttachmentsTable)
      .where(
        and(
          eq(schema.chatAttachmentsTable.conversationId, conversationId),
          eq(schema.chatAttachmentsTable.contentHash, contentHash),
          isNull(schema.chatAttachmentsTable.deletedAt),
        ),
      );
    return result ?? null;
  }

  static async findByConversationIdWithoutData(
    conversationId: string,
  ): Promise<Omit<ChatAttachment, "fileData">[]> {
    return db
      .select(metadataColumns)
      .from(schema.chatAttachmentsTable)
      .where(
        and(
          eq(schema.chatAttachmentsTable.conversationId, conversationId),
          isNull(schema.chatAttachmentsTable.deletedAt),
        ),
      );
  }

  static async updateTextPreview(
    id: string,
    status: "ok" | "failed" | "unsupported",
    textPreview: string | null,
  ): Promise<void> {
    await db
      .update(schema.chatAttachmentsTable)
      .set({ textPreview, textPreviewStatus: status })
      .where(
        and(
          eq(schema.chatAttachmentsTable.id, id),
          isNull(schema.chatAttachmentsTable.deletedAt),
        ),
      );
  }

  static async softDelete(id: string): Promise<void> {
    await db
      .update(schema.chatAttachmentsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.chatAttachmentsTable.id, id));
  }

  static computeContentHash(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }
}

function normalizeFileData(row: ChatAttachment): ChatAttachment {
  // pg returns Buffer; PGlite returns Uint8Array. Callers rely on Buffer
  // methods (.toString("base64"), .equals()) — normalize at the read boundary.
  if (Buffer.isBuffer(row.fileData)) return row;
  return { ...row, fileData: Buffer.from(row.fileData as Uint8Array) };
}

export default ChatAttachmentModel;
