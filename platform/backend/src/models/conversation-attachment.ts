import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  decryptLockedChatBytes,
  decryptLockedChatText,
  encryptLockedChatBytes,
  encryptLockedChatText,
  lockedChatContentHash,
} from "@/content-encryption/locked-chat";
import db, { schema } from "@/database";
import type { ConversationContentKey } from "@/types/conversation";
import { normalizeByteaField } from "@/utils/normalize-bytea";

type ConversationAttachment =
  typeof schema.conversationAttachmentsTable.$inferSelect;
type ConversationAttachmentInsert =
  typeof schema.conversationAttachmentsTable.$inferInsert;

/**
 * The conversation's browser-held key, for attachments belonging to a locked
 * chat. Passed to every method that reads or writes a content column, and
 * `null`/omitted for an ordinary chat, whose columns are plaintext.
 *
 * Reads are lenient about a row that is not marked `lockedChat` — passing a key
 * for a plaintext row returns it unchanged — because a conversation can hold
 * rows from both sides of the moment it was locked. Writes are not: a key means
 * the row is sealed.
 */
type AttachmentKey = ConversationContentKey | null | undefined;

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
  lockedChat: schema.conversationAttachmentsTable.lockedChat,
  createdAt: schema.conversationAttachmentsTable.createdAt,
  deletedAt: schema.conversationAttachmentsTable.deletedAt,
} as const;

class ConversationAttachmentModel {
  /**
   * Store an attachment. With a `conversationKey` the content columns are
   * sealed under it and the row is marked `lockedChat`, so later reads know to
   * open them; `contentHash` must already have been computed with
   * {@link computeContentHash} under the same key.
   */
  static async create(
    params: Omit<
      ConversationAttachmentInsert,
      "id" | "createdAt" | "deletedAt" | "lockedChat"
    >,
    conversationKey?: AttachmentKey,
  ): Promise<ConversationAttachment> {
    const [result] = await db
      .insert(schema.conversationAttachmentsTable)
      .values(
        conversationKey
          ? {
              ...params,
              lockedChat: true,
              originalName: encryptLockedChatText(params.originalName, {
                ...conversationKey,
                context: "conversation_attachments.original_name",
              }),
              fileData: encryptLockedChatBytes(params.fileData, {
                ...conversationKey,
                context: "conversation_attachments.file_data",
              }),
              textPreview: params.textPreview
                ? encryptLockedChatText(params.textPreview, {
                    ...conversationKey,
                    context: "conversation_attachments.text_preview",
                  })
                : params.textPreview,
            }
          : params,
      )
      .returning();
    // Hand the caller back what it stored, not the ciphertext it now holds.
    return openRow(normalizeByteaField(result, "fileData"), conversationKey);
  }

  static async findById(
    id: string,
    conversationKey?: AttachmentKey,
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
    return result ? openMetadata(result, conversationKey) : null;
  }

  static async findByIdWithData(
    id: string,
    conversationKey?: AttachmentKey,
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
    return result
      ? openRow(normalizeByteaField(result, "fileData"), conversationKey)
      : null;
  }

  /**
   * Newest non-deleted attachment with this original name in the conversation,
   * bytes included. Filename selection resolves latest-wins deliberately:
   * attachment names are not unique (re-attaching a file mints a new row every
   * time), so "the newest one" is the only selection that matches what a user
   * means by the name. Callers that need a specific older revision pass its id.
   */
  static async findLatestByNameWithData(
    params: {
      conversationId: string;
      originalName: string;
    },
    conversationKey?: AttachmentKey,
  ): Promise<ConversationAttachment | null> {
    const { conversationId, originalName } = params;
    // A locked chat stores the name sealed, and every envelope of the same
    // name differs (random IV), so there is nothing to match on in SQL. Read
    // the conversation's rows newest-first and compare opened names instead —
    // the same latest-wins selection, decided in memory.
    if (conversationKey) {
      const rows = await db
        .select()
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
        .orderBy(
          desc(schema.conversationAttachmentsTable.createdAt),
          desc(schema.conversationAttachmentsTable.id),
        );
      for (const row of rows) {
        const opened = openRow(
          normalizeByteaField(row, "fileData"),
          conversationKey,
        );
        if (opened.originalName === originalName) return opened;
      }
      return null;
    }
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
    conversationKey?: AttachmentKey,
  ): Promise<Omit<ConversationAttachment, "fileData">[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select(metadataColumns)
      .from(schema.conversationAttachmentsTable)
      .where(
        and(
          inArray(schema.conversationAttachmentsTable.id, ids),
          isNull(schema.conversationAttachmentsTable.deletedAt),
        ),
      );
    return rows.map((row) => openMetadata(row, conversationKey));
  }

  static async findByIdsWithData(
    ids: string[],
    conversationKey?: AttachmentKey,
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
    return rows.map((row) =>
      openRow(normalizeByteaField(row, "fileData"), conversationKey),
    );
  }

  /**
   * Dedup lookup. `contentHash` must have been produced by
   * {@link computeContentHash} with the same key the row was written under —
   * for a locked chat that is a per-conversation HMAC, so the column stays
   * matchable in SQL without holding a recomputable digest of the bytes.
   */
  static async findByConversationAndContentHash(
    conversationId: string,
    contentHash: string,
    conversationKey?: AttachmentKey,
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
    return result ? openMetadata(result, conversationKey) : null;
  }

  static async findByConversationIdWithoutData(
    conversationId: string,
    conversationKey?: AttachmentKey,
  ): Promise<Omit<ConversationAttachment, "fileData">[]> {
    const rows = await db
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
      );
    return rows.map((row) => openMetadata(row, conversationKey));
  }

  static async updateTextPreview(
    id: string,
    status: "ok" | "failed" | "unsupported",
    textPreview: string | null,
    conversationKey?: AttachmentKey,
  ): Promise<void> {
    await db
      .update(schema.conversationAttachmentsTable)
      .set({
        textPreview:
          conversationKey && textPreview
            ? encryptLockedChatText(textPreview, {
                ...conversationKey,
                context: "conversation_attachments.text_preview",
              })
            : textPreview,
        textPreviewStatus: status,
      })
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

  /**
   * The dedup key for a set of bytes. Under a `conversationKey` it is an HMAC
   * bound to that conversation instead of a bare digest — see
   * {@link lockedChatContentHash} for why a plain hash of a locked chat's
   * bytes is itself a leak.
   */
  static computeContentHash(
    buffer: Buffer,
    conversationKey?: AttachmentKey,
  ): string {
    return conversationKey
      ? lockedChatContentHash(buffer, conversationKey)
      : createHash("sha256").update(buffer).digest("hex");
  }
}

export default ConversationAttachmentModel;

// === Internal ===

/**
 * Open the content columns of a metadata row (no bytes). A row that is not
 * marked `lockedChat` is returned untouched, so a caller may pass the
 * conversation key uniformly across a conversation whose rows straddle the
 * moment it was locked.
 */
function openMetadata<T extends Omit<ConversationAttachment, "fileData">>(
  row: T,
  conversationKey: AttachmentKey,
): T {
  if (!conversationKey || !row.lockedChat) return row;
  return {
    ...row,
    originalName: decryptLockedChatText(row.originalName, {
      ...conversationKey,
      context: "conversation_attachments.original_name",
    }),
    textPreview: row.textPreview
      ? decryptLockedChatText(row.textPreview, {
          ...conversationKey,
          context: "conversation_attachments.text_preview",
        })
      : row.textPreview,
  };
}

/** {@link openMetadata} plus the file bytes. */
function openRow(
  row: ConversationAttachment,
  conversationKey: AttachmentKey,
): ConversationAttachment {
  if (!conversationKey || !row.lockedChat) return row;
  return {
    ...openMetadata(row, conversationKey),
    fileData: decryptLockedChatBytes(row.fileData, {
      ...conversationKey,
      context: "conversation_attachments.file_data",
    }),
  };
}
