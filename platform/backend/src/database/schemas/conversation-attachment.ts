import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const conversationAttachmentsTable = pgTable(
  "conversation_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    uploadedByUserId: text("uploaded_by_user_id").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    contentHash: text("content_hash").notNull(),
    fileData: bytea("file_data").notNull(),
    textPreview: text("text_preview"),
    textPreviewStatus: text("text_preview_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { mode: "date" }),
  },
  (table) => [
    index("conversation_attachments_conversation_id_idx").on(
      table.conversationId,
    ),
    index("conversation_attachments_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    // Prevents the dedup race in extractInlineAttachments: a concurrent
    // findByConversationAndContentHash → create pair on the same bytes would
    // otherwise produce two rows. Partial — only enforced on live rows so
    // soft-deleted history can carry duplicates without conflicting.
    uniqueIndex(
      "conversation_attachments_conversation_id_content_hash_live_uidx",
    )
      .on(table.conversationId, table.contentHash)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default conversationAttachmentsTable;
