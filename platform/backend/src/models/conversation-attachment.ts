import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
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

  /**
   * Newest non-deleted attachment with this original name in the conversation,
   * bytes included. Filename selection resolves latest-wins deliberately:
   * attachment names are not unique (re-attaching a file mints a new row every
   * time), so "the newest one" is the only selection that matches what a user
   * means by the name. Callers that need a specific older revision pass its id.
   */
  static async findLatestByNameWithData(params: {
    conversationId: string;
    originalName: string;
  }): Promise<ConversationAttachment | null> {
    const { conversationId, originalName } = params;
    const [result] = await db
      .select()
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          eq(
            schema.conversationAttachmentsTable.conversationId,
            conversationId,
          ),
          eq(schema.conversationAttachmentsTable.originalName, originalName),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      )
      .orderBy(
        desc(schema.conversationAttachmentsTable.createdAt),
        desc(schema.conversationAttachmentsTable.id),
      )
      .limit(1);
    return result ? normalizeByteaField(result, "fileData") : null;
  }

  /**
   * Batch metadata lookup that leaves the bytea column alone. Lets a caller
   * decide which attachments it actually needs bytes for before paying to read
   * them — an over-the-sandbox-limit file can be described from metadata alone.
   */
  static async findByIdsWithoutData(
    ids: string[],
  ): Promise<Omit<ConversationAttachment, "fileData">[]> {
    if (ids.length === 0) return [];
    return db
      .select(metadataColumns)
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          inArray(schema.conversationAttachmentsTable.id, ids),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
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
