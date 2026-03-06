import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";
import knowledgeBasesTable from "./knowledge-base";

const kbDocumentsTable = pgTable(
  "kb_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    sourceType: text("source_type")
      .$type<"connector" | "api">()
      .notNull(),
    sourceId: text("source_id"),
    connectorId: uuid("connector_id").references(
      () => knowledgeBaseConnectorsTable.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceUrl: text("source_url"),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    embeddingStatus: text("embedding_status")
      .$type<"pending" | "processing" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("kb_documents_kb_id_idx").on(table.knowledgeBaseId),
    index("kb_documents_org_id_idx").on(table.organizationId),
    index("kb_documents_content_hash_idx").on(
      table.knowledgeBaseId,
      table.contentHash,
    ),
    index("kb_documents_source_idx").on(
      table.knowledgeBaseId,
      table.sourceType,
      table.sourceId,
    ),
  ],
);

export default kbDocumentsTable;
