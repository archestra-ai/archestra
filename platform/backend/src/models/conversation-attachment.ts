import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";

type ConversationAttachment =
  typeof schema.conversationAttachmentsTable.$inferSelect;
type ConversationAttachmentInsert =
  typeof schema.conversationAttachmentsTable.$inferInsert;

const metadataColumns = {
  id: schema.conversationAttachmentsTable.id,
  organizationId: schema.conversationAttachmentsTable.organizationId,
  conversationId: schema.conversationAttachmentsTable.conversationId,
  uploadedByUserId: schema.conversationAttachmentsTable.uploadedByUserId,
  originalName: schema.conversationAttachmentsTable.originalName,
  mimeType: schema.conversationAttachmentsTable.mimeType,
  fileSize: schema.conversationAttachmentsTable.fileSize,
  contentHash: schema.conversationAttachmentsTable.contentHash,
  textPreview: schema.conversationAttachmentsTable.textPreview,
  textPreviewStatus: schema.conversationAttachmentsTable.textPreviewStatus,
  createdAt: schema.conversationAttachmentsTable.createdAt,
  deletedAt: schema.conversationAttachmentsTable.deletedAt,
} as const;

class ConversationAttachmentModel {
  static async create(
    params: Omit<
      ConversationAttachmentInsert,
      "id" | "createdAt" | "deletedAt"
    >,
  ): Promise<ConversationAttachment> {
    const [result] = await db
      .insert(schema.conversationAttachmentsTable)
      .values(params)
      .returning();
    return result;
  }

  static async findById(
    id: string,
  ): Promise<Omit<ConversationAttachment, "fileData"> | null> {
    const [result] = await db
      .select(metadataColumns)
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          eq(schema.conversationAttachmentsTable.id, id),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
    return result ?? null;
  }

  static async findByIdWithData(
    id: string,
  ): Promise<ConversationAttachment | null> {
    const [result] = await db
      .select()
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          eq(schema.conversationAttachmentsTable.id, id),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
    return result ? normalizeFileData(result) : null;
  }

  static async findByIdsWithData(
    ids: string[],
  ): Promise<ConversationAttachment[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select()
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          inArray(schema.conversationAttachmentsTable.id, ids),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
    return rows.map(normalizeFileData);
  }

  static async findByConversationAndContentHash(
    conversationId: string,
    contentHash: string,
  ): Promise<Omit<ConversationAttachment, "fileData"> | null> {
    const [result] = await db
      .select(metadataColumns)
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          eq(
            schema.conversationAttachmentsTable.conversationId,
            conversationId,
          ),
          eq(schema.conversationAttachmentsTable.contentHash, contentHash),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
    return result ?? null;
  }

  static async findByConversationIdWithoutData(
    conversationId: string,
  ): Promise<Omit<ConversationAttachment, "fileData">[]> {
    return db
      .select(metadataColumns)
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          eq(
            schema.conversationAttachmentsTable.conversationId,
            conversationId,
          ),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
  }

  static async updateTextPreview(
    id: string,
    status: "ok" | "failed" | "unsupported",
    textPreview: string | null,
  ): Promise<void> {
    await db
      .update(schema.conversationAttachmentsTable)
      .set({ textPreview, textPreviewStatus: status })
      .where(
        and(
          eq(schema.conversationAttachmentsTable.id, id),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
  }

  static async softDelete(id: string): Promise<void> {
    await db
      .update(schema.conversationAttachmentsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.conversationAttachmentsTable.id, id));
  }

  static computeContentHash(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }
}

function normalizeFileData(
  row: ConversationAttachment,
): ConversationAttachment {
  // pg returns Buffer; PGlite returns Uint8Array. Callers rely on Buffer
  // methods (.toString("base64"), .equals()) — normalize at the read boundary.
  if (Buffer.isBuffer(row.fileData)) return row;
  return { ...row, fileData: Buffer.from(row.fileData as Uint8Array) };
}

export default ConversationAttachmentModel;
