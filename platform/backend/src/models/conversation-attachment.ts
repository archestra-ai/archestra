import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import { normalizeByteaField } from "@/utils/normalize-bytea";

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
    return result ? normalizeByteaField(result, "fileData") : null;
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
    return rows.map((row) => normalizeByteaField(row, "fileData"));
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
    return (
      db
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
        )
        // stable order so downstream consumers (e.g. sandbox auto-staging, which
        // suffixes duplicate filenames in this order) are deterministic.
        .orderBy(
          asc(schema.conversationAttachmentsTable.createdAt),
          asc(schema.conversationAttachmentsTable.id),
        )
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

export default ConversationAttachmentModel;
