import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import kbDocumentsTable from "./kb-document";
import kbChunksTable from "./kb-chunk";
import knowledgeBasesTable from "./knowledge-base";
import conversationsTable from "./conversation";

const kbSearchFeedbackTable = pgTable(
  "kb_search_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, {
        onDelete: "cascade",
      }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => kbDocumentsTable.id, {
        onDelete: "cascade",
      }),
    chunkId: uuid("chunk_id").references(
      () => kbChunksTable.id,
      { onDelete: "cascade" },
    ),
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    userId: text("user_id").notNull(),
    rating: text("rating").notNull(), // 'positive' | 'negative'
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_search_feedback_kb_id_idx").on(table.knowledgeBaseId),
    index("kb_search_feedback_document_id_idx").on(table.documentId),
    index("kb_search_feedback_org_id_idx").on(table.organizationId),
  ],
);

export default kbSearchFeedbackTable;
